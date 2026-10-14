import { createHash } from "node:crypto";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import type { IncomingMeta } from "../base";
import {
  BaseWebChatAdapter,
  BrowserTurnOptionsDto,
  TurnExecutionMetaDto,
  ResponseTranslationResultDto,
  CodexRawPayload,
  CodexPayloadNormalizer,
  BasePromptCompiler,
  buildM365FormatRetryPrompt,
  BaseTitleGuard,
  ConversationLoopGuard,
  ToolArgumentNormalizer,
  ToolCallValidator,
  BaseToolBridge,
  type GenericDetectedToolCall,
} from "../base-web";
import { parseStrictWebResponse } from "../base-web/translation";
import {
  M365BrowserWorker,
  defaultM365BrowserWorker,
} from "./browser/m365-browser-worker";
import {
  M365CapabilityPicker,
  defaultM365CapabilityPicker,
  M365_CAPABILITY_SPECS,
  type M365CapabilityMode,
  type M365CapabilitySpec,
} from "./browser/m365-capability-specs";
import {
  M365_CHAT_URL,
  parseM365ConversationId,
  waitForM365ConversationId,
} from "./browser/conversation-url";
import { emitStructuredEvent } from "../../observability/emitter";

export {
  M365BrowserWorker,
  defaultM365BrowserWorker,
  M365CapabilityPicker,
  defaultM365CapabilityPicker,
  M365_CAPABILITY_SPECS,
  type M365CapabilityMode,
  type M365CapabilitySpec,
  M365_CHAT_URL,
  parseM365ConversationId,
  waitForM365ConversationId,
};

/**
 * Sinh conversationKey SHA-256 ổn định gắn liền với cấu hình model của request
 */
export function m365ConversationKey(
  parsed: CodexParsedRequest,
  rawConversationKey?: string,
): string | undefined {
  const source = rawConversationKey?.trim();
  if (!source) return undefined;

  return createHash("sha256").update(JSON.stringify({
    provider: "m365-copilot",
    source,
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
  })).digest("hex");
}

/**
 * Adapter Microsoft 365 Copilot tinh gọn kế thừa BaseWebChatAdapter
 * Chỉ nắm giữ cấu hình riêng của M365 và tận dụng 100% pipeline chung từ BaseWeb
 */
export class M365CopilotAdapter extends BaseWebChatAdapter {
  readonly name = "m365-copilot";
  readonly browserWorker = defaultM365BrowserWorker;
  readonly modelSelector = defaultM365CapabilityPicker;

  private readonly promptCompiler = new BasePromptCompiler();
  private readonly titleGuard: BaseTitleGuard;
  private readonly loopGuard = new ConversationLoopGuard();

  constructor(readonly options?: { enableTitleGuard?: boolean }) {
    super();
    this.titleGuard = new BaseTitleGuard({
      enableTitleGuard: options?.enableTitleGuard,
    });
  }

  protected resolveExecutionMeta(parsed: CodexParsedRequest, incoming: IncomingMeta): TurnExecutionMetaDto {
    const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
    const rawConversationKey = incoming.headers.get("x-codex-conversation-key")
      || rawPayload.getThreadId()
      || undefined;
    const conversationKey = m365ConversationKey(parsed, rawConversationKey);
    const hasPriorAssistantReply = (parsed.context.messages || []).some(m => m.role === "assistant");
    const isNewConversation = !hasPriorAssistantReply;

    return TurnExecutionMetaDto.of({
      conversationKey,
      isNewConversation,
      traceContext: incoming.traceContext,
      traceId: incoming.headers.get("x-codex-trace-id") || undefined,
    });
  }

  protected buildTurnPrompt(parsed: CodexParsedRequest, meta: TurnExecutionMetaDto): string {
    const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
    const normalized = CodexPayloadNormalizer.normalize(rawPayload);
    const res = this.promptCompiler.compile({
      parsed,
      normalized,
      isNewConversation: meta.isNewConversation,
    });
    return res.finalPrompt;
  }

  /**
   * Khôi phục handoff ảnh đúng như adapter M365 cũ:
   * - Chỉ upload ảnh ở lần gửi đầu tiên.
   * - Không upload lại ảnh khi Format Retry.
   * - Bảo toàn filename, MIME type, buffer và detail.
   *
   * Không lưu normalized request vào field của singleton adapter để tránh
   * trộn dữ liệu khi nhiều conversation được xử lý đồng thời.
   */
  protected override createBrowserTurnOptions(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    meta: TurnExecutionMetaDto,
    attempt: number
  ): BrowserTurnOptionsDto {
    const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
    const normalized = CodexPayloadNormalizer.normalize(rawPayload);

    return BrowserTurnOptionsDto.of({
      signal: incoming.abortSignal,
      traceId: meta.traceId,
      conversationKey: meta.conversationKey,
      isNewConversation: attempt === 0 ? meta.isNewConversation : false,
      modelSlug: parsed.modelId,
      reasoning: parsed.options.reasoning,
      traceContext: meta.traceContext,
      images: attempt === 0
        ? (normalized.images || []).map(image => ({
            filename: image.name,
            name: image.name,
            mimeType: image.mimeType,
            buffer: image.buffer,
            detail: image.detail,
          }))
        : [],
    });
  }

  /**
   * Khôi phục đầy đủ production tool pipeline của adapter M365 cũ:
   *
   * strict call
   * -> normalize/validate
   * -> map sang đúng native wire call của client
   * -> fingerprint cả batch
   * -> loop guard
   * -> emit sang IDE
   */
  protected override async dispatchToolCalls(
    calls: readonly GenericDetectedToolCall[],
    parsed: CodexParsedRequest,
    meta: TurnExecutionMetaDto,
    usage: { inputTokens: number; outputTokens: number; totalTokens: number },
    emit: (event: AdapterEvent) => void
  ): Promise<void> {
    const clientTools = parsed.context.tools || [];
    const mappedCalls = calls.map(call => {
      const mapped = BaseToolBridge.mapToolCall(
        {
          name: call.name,
          arguments: call.arguments,
        },
        clientTools
      );

      return {
        id: call.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        name: mapped.name,
        arguments: mapped.arguments,
      };
    });

    for (const call of mappedCalls) {
      emitStructuredEvent({
        level: "info",
        event: "m365.tool.detected",
        traceContext: meta.traceContext,
        toolCallId: call.id,
        safeDetails: {
          toolName: call.name,
          callId: call.id,
          argBytes: Buffer.byteLength(call.arguments, "utf8"),
        },
      });
    }

    this.loopGuard.cleanExpired();

    const conversationKey = meta.conversationKey
      || `transient_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`;
    const batchFingerprint = mappedCalls
      .map(call => ({
        name: call.name,
        arguments: call.arguments,
      }))
      .sort((left, right) => {
        const leftKey = `${left.name}:${left.arguments}`;
        const rightKey = `${right.name}:${right.arguments}`;
        return leftKey.localeCompare(rightKey);
      });
    const primaryToolName = mappedCalls[0]?.name || "unknown";
    const guardResult = this.loopGuard.recordToolCall(
      conversationKey,
      primaryToolName,
      batchFingerprint
    );

    emitStructuredEvent({
      level: "info",
      event: "m365.loop.updated",
      traceContext: meta.traceContext,
      safeDetails: {
        toolIterations: guardResult.state.toolIterations,
        identicalToolCount: guardResult.state.identicalToolCount,
        primaryToolName,
        toolCount: mappedCalls.length,
      },
    });

    if (guardResult.isLoopDetected) {
      this.loopGuard.delete(conversationKey);

      emitStructuredEvent({
        level: "error",
        event: "m365.loop.blocked",
        traceContext: meta.traceContext,
        safeDetails: {
          reason: guardResult.reason,
          toolIterations: guardResult.state.toolIterations,
          identicalToolCount: guardResult.state.identicalToolCount,
          primaryToolName,
        },
      });

      emitStructuredEvent({
        level: "error",
        event: "m365.turn.completed",
        traceContext: meta.traceContext,
        completionType: "loop_blocked",
        stopReason: "stop",
        endTurn: true,
        safeDetails: {
          completionType: "loop_blocked",
          terminalReason: "loop_blocked",
          terminalExplanation: guardResult.reason,
          toolCount: 0,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
      });

      emit({
        type: "text_delta",
        text:
          `\n\n> [!WARNING]\n` +
          `> **Giới hạn an toàn:** ${guardResult.reason} ` +
          `Hệ thống tự động kết thúc để bảo vệ môi trường làm việc.`,
      });
      emit({
        type: "done",
        stopReason: "stop",
        endTurn: true,
        usage,
      });
      return;
    }

    for (const call of mappedCalls) {
      emit({ type: "tool_call_start", id: call.id, name: call.name });
      emit({ type: "tool_call_delta", arguments: call.arguments });
      emit({ type: "tool_call_end" });
    }

    emitStructuredEvent({
      level: "info",
      event: "m365.turn.completed",
      traceContext: meta.traceContext,
      completionType: "tool_call",
      stopReason: "tool_use",
      endTurn: false,
      safeDetails: {
        completionType: "tool_call",
        terminalReason: "tool_calls_emitted",
        terminalExplanation:
          `Đã phát ${mappedCalls.length} tool call về IDE: ` +
          mappedCalls.map(call => call.name).join(", "),
        toolCount: mappedCalls.length,
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
  }

  protected override async dispatchFinalAnswer(
    content: string,
    meta: TurnExecutionMetaDto,
    usage: { inputTokens: number; outputTokens: number; totalTokens: number },
    emit: (event: AdapterEvent) => void
  ): Promise<void> {
    emitStructuredEvent({
      level: "info",
      event: "m365.turn.completed",
      traceContext: meta.traceContext,
      completionType: "final_answer",
      stopReason: "stop",
      endTurn: true,
      safeDetails: {
        completionType: "final_answer",
        terminalReason: "model_final_answer",
        terminalExplanation:
          "M365 Copilot hoàn tất một response hợp lệ dạng Final Answer.",
        toolCount: 0,
        finalAnswer: content,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
    });

    await super.dispatchFinalAnswer(content, meta, usage, emit);
  }

  protected translateResponse(rawReply: string, parsed: CodexParsedRequest): ResponseTranslationResultDto {
    // Khôi phục pipeline strict của adapter M365 cũ:
    // Browser raw reply -> strict protocol parser -> format retry / tool calls / final answer.
    //
    // BaseOutputTranslator là tolerant translator. Nếu dùng nó làm cổng
    // production, response sai envelope hoặc tool call bị cắt có thể bị hạ
    // thành final_answer, khiến format retry không được kích hoạt.
    const result = parseStrictWebResponse(rawReply);

    if (result.kind === "protocol_error") {
      return ResponseTranslationResultDto.protocolError(
        result.code,
        result.message,
        result.rawResponse
      );
    }

    if (result.kind === "tool_calls") {
      const normalizedCalls = result.calls.map(call => {
        const normalized = ToolArgumentNormalizer.normalizeToolArguments(
          call.name,
          call.arguments
        );

        return {
          id: call.id,
          name: normalized.name,
          arguments: normalized.arguments,
        };
      });

      const clientTools = parsed.context.tools || [];
      for (const call of normalizedCalls) {
        const validation = ToolCallValidator.validateToolCall(
          call.name,
          call.arguments,
          clientTools
        );

        if (!validation.ok) {
          return ResponseTranslationResultDto.protocolError(
            "INVALID_TOOL_CALL",
            `${validation.code}: ${validation.message}`,
            rawReply
          );
        }
      }

      return ResponseTranslationResultDto.toolCalls(
        normalizedCalls
      );
    }

    return ResponseTranslationResultDto.finalAnswer(result.content);
  }

  protected buildFormatRetryPrompt(code: string, message: string): string {
    return buildM365FormatRetryPrompt(code, message);
  }

  /**
   * Khôi phục cấu hình retry riêng của M365 adapter cũ.
   *
   * Giá trị hợp lệ nằm trong khoảng 0..10:
   * - 0: không retry
   * - 3: mặc định
   * - tối đa 10 để tránh vòng phát lại quá dài
   */
  protected override getMaxFormatRetries(): number {
    const configuredRetries = Number.parseInt(
      process.env.M365_FORMAT_MAX_RETRIES || "3",
      10
    );

    return Number.isFinite(configuredRetries) && configuredRetries >= 0
      ? Math.min(configuredRetries, 10)
      : 3;
  }

  protected override async handleTitleGuardFastPath(
    parsed: CodexParsedRequest,
    prompt: string,
    _meta: TurnExecutionMetaDto,
    emit: (event: AdapterEvent) => void
  ): Promise<boolean> {
    if (this.titleGuard.isTitleRequest(parsed, prompt)) {
      const title = this.titleGuard.generateTitleResponse(prompt);
      const inputTokens = Math.ceil(prompt.length / 4);
      const outputTokens = Math.ceil(title.length / 4);

      emitStructuredEvent({
        level: "info",
        event: "m365.turn.completed",
        traceContext: _meta.traceContext,
        completionType: "title_response",
        stopReason: "stop",
        endTurn: true,
        safeDetails: {
          completionType: "title_response",
          terminalReason: "title_request",
          terminalExplanation:
            "Codex gửi yêu cầu sinh tiêu đề ngầm và adapter phản hồi bằng Title Guard.",
          toolCount: 0,
          inputTokens,
          outputTokens,
        },
      });

      emit({ type: "text_delta", text: title });
      emit({
        type: "done",
        stopReason: "stop",
        endTurn: true,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
      });
      return true;
    }
    return false;
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
        code: result.errorCode || "PROTOCOL_ERROR",
        message: result.errorMessage || "Sai định dạng response protocol",
      },
      diagnosticDetails: {
        responseChars: rawReply.length,
      },
    });
  }

  protected override cleanupSessionGuard(conversationKey?: string): void {
    if (conversationKey) {
      this.loopGuard.delete(conversationKey);
    }
  }
}

export function createM365CopilotAdapter(options?: { enableTitleGuard?: boolean }): M365CopilotAdapter {
  return new M365CopilotAdapter(options);
}

export const m365CopilotAdapter = new M365CopilotAdapter();
