import type { AdapterEvent, CodexParsedRequest } from "../../types";
import type { IncomingMeta, ProviderAdapter } from "../base";
import {
  BaseWebChatAdapter,
  TurnExecutionMetaDto,
  ResponseTranslationResultDto,
  BrowserTurnOptionsDto,
  type GenericDetectedToolCall,
} from "../base-web";
import { isTitleRequest, generateTitleResponse } from "./guards";
import { promptCompiler, buildM365FormatRetryPrompt } from "./prompts/index";
import { CodexRawPayload, CodexPayloadNormalizer, type NormalizedCodexRequest } from "./normalization";
import {
  m365ConversationKey,
  defaultM365BrowserWorker,
  defaultCapabilityPicker,
} from "./browser";
import { parseStrictM365Response, maskArgumentsForLog } from "./translation";
import { M365ToolBridge, normalizeM365ToolArguments, validateM365ToolCall } from "./tools";
import {
  conversationGuard,
  cleanExpiredConversationGuards,
  MAX_TOOL_ITERATIONS,
  getMaxIdenticalToolCalls,
  stableToolFingerprint,
  isAssistantFinalAnswer,
} from "./session";
import { emitStructuredEvent } from "../../observability/emitter";
import { logDebugPipelineStation } from "../../observability/debug-logger";
import { traceStorage, secureToolFingerprint } from "../../observability/trace-context";

export * from "./session";
export * from "./guards";
export * from "./normalization";
export * from "./prompts/index";
export * from "./translation";
export * from "./tools";
export * from "./browser";
export * from "./harness";

/**
 * Adapter Microsoft 365 Copilot kế thừa BaseWebChatAdapter theo chuẩn Enterprise Clean OOP
 */
export class M365CopilotAdapter extends BaseWebChatAdapter {
  readonly name = "m365-copilot";
  readonly browserWorker = defaultM365BrowserWorker;
  readonly modelSelector = defaultCapabilityPicker;

  private readonly normalizedCache = new WeakMap<CodexParsedRequest, NormalizedCodexRequest>();

  constructor(readonly options?: { enableTitleGuard?: boolean }) {
    super();
  }

  protected resolveExecutionMeta(parsed: CodexParsedRequest, incoming: IncomingMeta): TurnExecutionMetaDto {
    const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
    const rawConversationKey = incoming.headers.get("x-codex-conversation-key")
      || rawPayload.getThreadId()
      || undefined;
    const conversationKey = m365ConversationKey(parsed, rawConversationKey);
    const hasPriorAssistantReply = (parsed.context.messages || []).some(m => m.role === "assistant");
    const isNewConversation = !hasPriorAssistantReply;
    const traceContext = incoming.traceContext || traceStorage.getStore() || undefined;
    const traceId = incoming.headers.get("x-codex-trace-id") || undefined;

    return TurnExecutionMetaDto.of({
      conversationKey,
      isNewConversation,
      traceContext,
      traceId,
    });
  }

  protected override isAssistantAlreadyCompleted(parsed: CodexParsedRequest): boolean {
    const allMsgs = parsed.context.messages || [];
    if (allMsgs.length === 0) return false;
    const lastMsg = allMsgs[allMsgs.length - 1];
    return isAssistantFinalAnswer(lastMsg);
  }

  protected override emitAssistantAlreadyCompleted(meta: TurnExecutionMetaDto, emit: (event: AdapterEvent) => void): void {
    if (meta.conversationKey) {
      conversationGuard.delete(meta.conversationKey);
    }
    emitStructuredEvent({
      level: "info",
      event: "m365.turn.completed",
      traceContext: meta.traceContext,
      safeDetails: {
        completionType: "final_answer",
        terminalReason: "already_completed_assistant_reply",
        terminalExplanation: "Cuộc hội thoại đã kết thúc bằng phản hồi trước đó của trợ lý và không có lệnh mới từ Codex.",
        toolCount: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    });
    emit({
      type: "done",
      stopReason: "stop",
      endTurn: true,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
  }

  protected buildTurnPrompt(parsed: CodexParsedRequest, meta: TurnExecutionMetaDto): string {
    const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
    const normalized = CodexPayloadNormalizer.normalize(rawPayload);
    this.normalizedCache.set(parsed, normalized);

    const compileResult = promptCompiler.compile({
      normalized,
      parsed,
      isNewConversation: meta.isNewConversation,
    });
    return compileResult.finalPrompt;
  }

  protected override async handleTitleGuardFastPath(
    parsed: CodexParsedRequest,
    prompt: string,
    meta: TurnExecutionMetaDto,
    emit: (event: AdapterEvent) => void
  ): Promise<boolean> {
    const normalized = this.normalizedCache.get(parsed);
    const trailingCount = normalized ? normalized.trailingToolResults.length : 0;

    if (
      trailingCount === 0 &&
      isTitleRequest(parsed, prompt, { enableTitleGuard: this.options?.enableTitleGuard })
    ) {
      const titleText = generateTitleResponse(prompt);
      const usage = {
        inputTokens: Math.ceil(prompt.length / 4),
        outputTokens: Math.ceil(titleText.length / 4),
        totalTokens: Math.ceil((prompt.length + titleText.length) / 4),
      };
      emitStructuredEvent({
        level: "info",
        event: "m365.turn.completed",
        traceContext: meta.traceContext,
        safeDetails: {
          completionType: "title_response",
          terminalReason: "title_request",
          terminalExplanation: "Codex gửi yêu cầu sinh tiêu đề ngầm, hệ thống đã phản hồi tức thì.",
          toolCount: 0,
          finalAnswer: titleText,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
      });
      emit({ type: "text_delta", text: titleText });
      emit({
        type: "done",
        stopReason: "stop",
        endTurn: true,
        usage,
      });
      return true;
    }
    return false;
  }

  protected override createBrowserTurnOptions(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    meta: TurnExecutionMetaDto,
    attempt: number
  ): BrowserTurnOptionsDto {
    const normalized = this.normalizedCache.get(parsed);
    return BrowserTurnOptionsDto.of({
      signal: incoming.abortSignal,
      traceId: meta.traceId,
      conversationKey: meta.conversationKey,
      isNewConversation: attempt === 0 ? meta.isNewConversation : false,
      modelSlug: parsed.modelId,
      reasoning: parsed.options.reasoning,
      traceContext: meta.traceContext,
      images: attempt === 0 ? normalized?.images : [],
    });
  }

  protected translateResponse(rawReply: string, parsed: CodexParsedRequest): ResponseTranslationResultDto {
    const protocolResult = parseStrictM365Response(rawReply);
    if (protocolResult.kind === "protocol_error") {
      return ResponseTranslationResultDto.protocolError(protocolResult.code, protocolResult.message, rawReply);
    }

    if (protocolResult.kind === "tool_calls") {
      const clientTools = parsed.context.tools || [];
      for (const call of protocolResult.calls) {
        const normalizedCall = normalizeM365ToolArguments(call.name, call.arguments);
        const validation = validateM365ToolCall(normalizedCall.name, normalizedCall.arguments, clientTools);
        if (!validation.ok) {
          return ResponseTranslationResultDto.protocolError(
            "INVALID_TOOL_CALL",
            `${validation.code}: ${validation.message}`,
            rawReply
          );
        }
      }
      return ResponseTranslationResultDto.toolCalls(protocolResult.calls);
    }

    return ResponseTranslationResultDto.finalAnswer(protocolResult.content);
  }

  protected buildFormatRetryPrompt(code: string, message: string): string {
    return buildM365FormatRetryPrompt({ code, message });
  }

  protected override getMaxFormatRetries(): number {
    const configuredRetries = Number.parseInt(process.env.M365_FORMAT_MAX_RETRIES || "3", 10);
    return Number.isFinite(configuredRetries) && configuredRetries >= 0
      ? Math.min(configuredRetries, 10)
      : 3;
  }

  protected override emitFormatRetryWarning(
    attempt: number,
    maxRetries: number,
    result: ResponseTranslationResultDto,
    meta: TurnExecutionMetaDto,
    rawReply: string
  ): void {
    emitStructuredEvent({
      level: "warning",
      event: "m365.response.format_retry",
      traceContext: meta.traceContext,
      safeDetails: {
        attempt: attempt + 1,
        maxAttempts: maxRetries + 1,
        code: result.errorCode,
        message: result.errorMessage,
      },
      diagnosticDetails: {
        responseChars: rawReply.length,
      },
    });
  }

  protected override async dispatchToolCalls(
    calls: readonly GenericDetectedToolCall[],
    parsed: CodexParsedRequest,
    meta: TurnExecutionMetaDto,
    usage: { inputTokens: number; outputTokens: number; totalTokens: number },
    emit: (event: AdapterEvent) => void
  ): Promise<void> {
    const clientTools = parsed.context.tools || [];
    const mappedCalls = calls.map(rawCall => ({
      rawCall,
      mapped: M365ToolBridge.mapToolCall(rawCall, clientTools),
      callId: rawCall.id || `call_${Math.random().toString(36).slice(2, 10)}`,
    }));

    for (const { mapped, callId } of mappedCalls) {
      emitStructuredEvent({
        level: "info",
        event: "m365.tool.detected",
        traceContext: meta.traceContext,
        safeDetails: {
          toolName: mapped.name,
          callId,
          arguments: mapped.arguments,
          argKeys: mapped.arguments && typeof mapped.arguments === "object" ? Object.keys(mapped.arguments) : [],
        },
        diagnosticDetails: {
          toolFingerprint: secureToolFingerprint(mapped.name, mapped.arguments),
          argsBytes: Buffer.byteLength(JSON.stringify(mapped.arguments || {}), "utf8"),
        },
      });
    }

    // Loop Guard: Kiểm tra giới hạn số vòng lặp và lặp lại công cụ liên tiếp
    cleanExpiredConversationGuards();
    const cKey = meta.conversationKey || `transient_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`;
    const guardState = conversationGuard.get(cKey) || {
      toolIterations: 0,
      identicalToolCount: 0,
      updatedAt: Date.now(),
    };

    guardState.toolIterations += 1;
    guardState.updatedAt = Date.now();
    const currentFingerprint = mappedCalls
      .map(c => stableToolFingerprint(c.mapped.name, c.mapped.arguments))
      .sort()
      .join("|");

    if (currentFingerprint === guardState.lastToolFingerprint) {
      guardState.identicalToolCount += 1;
    } else {
      guardState.lastToolFingerprint = currentFingerprint;
      guardState.identicalToolCount = 1;
    }

    conversationGuard.set(cKey, guardState);

    emitStructuredEvent({
      level: "info",
      event: "m365.loop.updated",
      traceContext: meta.traceContext,
      safeDetails: {
        toolIterations: guardState.toolIterations,
        identicalToolCount: guardState.identicalToolCount,
      },
    });

    // 1. Kiểm tra lặp lại cùng một tool call quá giới hạn liên tiếp
    const currentToolName = mappedCalls[0]?.mapped.name || "unknown";
    const maxIdenticalAllowed = getMaxIdenticalToolCalls(currentToolName);
    if (guardState.identicalToolCount >= maxIdenticalAllowed) {
      console.warn(`[m365-guard] Ngắt vòng lặp: Công cụ ${currentToolName} bị gọi lặp lại ${maxIdenticalAllowed} lần liên tiếp.`);
      conversationGuard.delete(cKey);
      emitStructuredEvent({
        level: "error",
        event: "m365.loop.blocked",
        traceContext: meta.traceContext,
        safeDetails: {
          reason: "repeated_tool_call",
          toolName: currentToolName,
          identicalCount: guardState.identicalToolCount,
          maxAllowed: maxIdenticalAllowed,
        },
      });
      emitStructuredEvent({
        level: "error",
        event: "m365.turn.completed",
        traceContext: meta.traceContext,
        safeDetails: {
          completionType: "loop_blocked",
          terminalReason: "loop_blocked_repeated_tool",
          terminalExplanation: `Ngắt vòng lặp an toàn: Công cụ ${currentToolName} bị gọi lặp lại ${maxIdenticalAllowed} lần liên tiếp với cùng tham số.`,
          toolCount: 0,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
      });
      emit({
        type: "text_delta",
        text: `\n\n> [!WARNING]\n> **Phát hiện vòng lặp vô hạn (Repeated Tool Calls):** Công cụ \`${currentToolName}\` đã được yêu cầu lặp lại ${maxIdenticalAllowed} lần liên tiếp với cùng tham số. Hệ thống tự động kết thúc để bảo vệ môi trường làm việc.`,
      });
      emit({
        type: "done",
        stopReason: "stop",
        endTurn: true,
        usage,
      });
      return;
    }

    // 2. Kiểm tra vượt quá số vòng tool tối đa trong phiên (MAX_TOOL_ITERATIONS = 20)
    if (guardState.toolIterations > MAX_TOOL_ITERATIONS) {
      console.warn(`[m365-guard] Ngắt vòng lặp: Vượt quá giới hạn tối đa ${MAX_TOOL_ITERATIONS} lượt gọi công cụ trong phiên.`);
      conversationGuard.delete(cKey);
      emitStructuredEvent({
        level: "error",
        event: "m365.loop.blocked",
        traceContext: meta.traceContext,
        safeDetails: {
          reason: "max_iterations_exceeded",
          toolIterations: guardState.toolIterations,
        },
      });
      emitStructuredEvent({
        level: "error",
        event: "m365.turn.completed",
        traceContext: meta.traceContext,
        safeDetails: {
          completionType: "loop_blocked",
          terminalReason: "loop_blocked_max_iterations",
          terminalExplanation: `Ngắt an toàn: Đã chạm giới hạn tối đa ${MAX_TOOL_ITERATIONS} lượt gọi công cụ liên tiếp trong phiên.`,
          toolCount: 0,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
      });
      emit({
        type: "text_delta",
        text: `\n\n> [!WARNING]\n> **Giới hạn an toàn (Max Tool Iterations Exceeded):** Đã chạm ngưỡng tối đa ${MAX_TOOL_ITERATIONS} lượt thực thi công cụ liên tiếp trong phiên. Hệ thống tự động kết thúc để bảo vệ tài nguyên.`,
      });
      emit({
        type: "done",
        stopReason: "stop",
        endTurn: true,
        usage,
      });
      return;
    }

    for (const { mapped, callId } of mappedCalls) {
      console.log(`[M365 TOOL] emit tool call: ${mapped.name} (${callId})`);
      console.log(`[M365 TOOL] arguments=${maskArgumentsForLog(mapped.arguments)}`);

      const serializedArgs = typeof mapped.arguments === "string"
        ? mapped.arguments
        : JSON.stringify(mapped.arguments ?? {});

      emit({ type: "tool_call_start", id: callId, name: mapped.name });
      emit({ type: "tool_call_delta", arguments: serializedArgs });
      emit({ type: "tool_call_end" });
    }

    emitStructuredEvent({
      level: "info",
      event: "m365.turn.completed",
      traceContext: meta.traceContext,
      safeDetails: {
        completionType: "tool_call",
        terminalReason: "tool_calls_emitted",
        terminalExplanation: `Bridge Server đã phát lệnh gọi ${calls.length} công cụ về Codex: ${mappedCalls.map(c => c.mapped.name).join(", ")}. Codex sẽ tiếp tục thực thi và mở lượt tiếp theo.`,
        toolCount: calls.length,
        thinking: false,
        narrative: false,
        toolCalls: mappedCalls.map(c => ({
          id: c.callId,
          name: c.mapped.name,
          arguments: c.mapped.arguments,
        })),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
    });

    emit({
      type: "done",
      stopReason: "tool_use",
      endTurn: false,
      usage,
    });

    logDebugPipelineStation(
      4,
      "BRIDGE SERVER ➔ CODEX IDE (OUTGOING SSE / TOOL CALLS)",
      mappedCalls.map(c => ({
        id: c.callId,
        name: c.mapped.name,
        arguments: c.mapped.arguments,
      }))
    );
  }

  protected override async dispatchFinalAnswer(
    finalContent: string,
    meta: TurnExecutionMetaDto,
    usage: { inputTokens: number; outputTokens: number; totalTokens: number },
    emit: (event: AdapterEvent) => void
  ): Promise<void> {
    if (finalContent) {
      emit({ type: "text_delta", text: finalContent });
    } else {
      emit({ type: "text_delta", text: "" });
    }

    if (meta.conversationKey) {
      conversationGuard.delete(meta.conversationKey);
    }

    const terminalReason = "model_final_answer";
    const terminalExplanation = "M365 Copilot hoàn tất một m365Response hợp lệ dạng Final Answer. Codex dừng chu trình agent và chờ người dùng.";

    emitStructuredEvent({
      level: "info",
      event: "m365.turn.completed",
      traceContext: meta.traceContext,
      safeDetails: {
        completionType: "final_answer",
        terminalReason,
        terminalExplanation,
        toolCount: 0,
        finalAnswer: finalContent,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
    });

    emit({
      type: "done",
      stopReason: "stop",
      endTurn: true,
      usage,
    });

    const step4TextContent = finalContent.trim();
    logDebugPipelineStation(4, "BRIDGE SERVER ➔ CODEX IDE (OUTGOING SSE / TOOL CALLS)", step4TextContent || "(Phản hồi hoàn tất)");
  }

  protected override handleEarlyAbort(incoming: IncomingMeta): void {
    const traceContext = incoming.traceContext || traceStorage.getStore() || undefined;
    emitStructuredEvent({
      level: "warning",
      event: "m365.turn.completed",
      traceContext,
      safeDetails: {
        completionType: "aborted",
        toolCount: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    });
  }

  protected override cleanupSessionGuard(conversationKey?: string): void {
    if (conversationKey) {
      conversationGuard.delete(conversationKey);
    }
  }

  protected override async handleTurnError(
    err: unknown,
    meta: TurnExecutionMetaDto,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void
  ): Promise<void> {
    if (meta.conversationKey) {
      conversationGuard.delete(meta.conversationKey);
    }
    if (incoming.abortSignal?.aborted) {
      console.log(`[${this.name}] [aborted] turn aborted by incoming signal`);
      emitStructuredEvent({
        level: "warning",
        event: "m365.turn.completed",
        traceContext: meta.traceContext,
        safeDetails: {
          completionType: "aborted",
          terminalReason: "client_aborted",
          terminalExplanation: "Codex gửi tín hiệu abort (người dùng bấm Dừng hoặc ngắt kết nối).",
          toolCount: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
      });
      throw new DOMException("M365 Copilot turn aborted", "AbortError");
    }

    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${this.name}] [error] ${message}`);
    emitStructuredEvent({
      level: "error",
      event: "m365.turn.completed",
      traceContext: meta.traceContext,
      safeDetails: {
        completionType: "error",
        terminalReason: "error",
        terminalExplanation: `Gặp lỗi trong quá trình thực thi: ${message}`,
        toolCount: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
      diagnosticDetails: {
        errorMessage: message,
      },
    });
    emit({
      type: "error",
      message: `[M365 Copilot] ${message}`,
    });
  }
}

/**
 * Factory khởi tạo đối tượng M365CopilotAdapter với đầy đủ các cấu hình và dependencies cần thiết.
 */
export function createM365CopilotAdapter(): ProviderAdapter {
  return new M365CopilotAdapter();
}
