
import type { AdapterEvent, CodexMessage, CodexParsedRequest } from "../../types";
import type { IncomingMeta, ProviderAdapter } from "../base";
import { isTitleRequest, generateTitleResponse, isTitleGuardEnabled } from "./guards";
import { promptCompiler, buildM365FormatRetryPrompt } from "./prompts/index";
import { CodexRawPayload, CodexPayloadNormalizer } from "./normalization";
import { executeM365Turn, m365ConversationKey } from "./browser";
import { parseStrictM365Response, maskArgumentsForLog, type StrictM365ResponseResult } from "./translation";
import { M365ToolBridge, normalizeM365ToolArguments, validateM365ToolCall } from "./tools";
import {
  conversationGuard,
  cleanExpiredConversationGuards,
  MAX_TOOL_ITERATIONS,
  MAX_IDENTICAL_TOOL_CALLS,
  getMaxIdenticalToolCalls,
  stableSortValue,
  stableToolFingerprint,
  isToolCallPart,
  isAssistantFinalAnswer,
  type ConversationGuardState,
} from "./session";
import { emitStructuredEvent } from "../../observability/emitter";
import { logDebugPipelineStation } from "../../observability/debug-logger";
import { traceStorage, secureToolFingerprint } from "../../observability/trace-context";
import type { TraceContext } from "../../observability/types";

export * from "./session";
export * from "./guards";
export * from "./normalization";
export * from "./prompts/index";
export * from "./translation";
export * from "./tools";
export * from "./browser";
export * from "./harness";

/**
 * Trích xuất thông tin môi trường shell của client từ các tham số hoặc context của request.
 */
function extractClientShell(parsed: CodexParsedRequest): string | undefined {

  // 1. Kiểm tra trong system prompt
  for (const sp of parsed.context.systemPrompt || []) {
    const match = sp.match(/<shell>([^<]+)<\/shell>/i);
    if (match) return match[1].trim();
  }
  // 2. Kiểm tra trong messages (user / developer)
  for (const msg of parsed.context.messages || []) {
    const text = typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map(c => c.type === "text" ? c.text : "").join(" ")
        : "";
    const match = text.match(/<shell>([^<]+)<\/shell>/i);
    if (match) return match[1].trim();
  }

  return undefined;
}

export class M365CopilotAdapter implements ProviderAdapter {
  readonly name = "m365-copilot";

  constructor(readonly options?: { enableTitleGuard?: boolean }) { }

  /**
 * Điều phối toàn bộ vòng đời của một lượt tương tác (turn): chuẩn hóa request, compile prompt, chạy browser worker và dịch kết quả.
 */
  async runTurn(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void
  ): Promise<void> {

    const traceContext: TraceContext | undefined = incoming.traceContext || traceStorage.getStore() || undefined;

    if (incoming.abortSignal?.aborted) {
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
      throw new DOMException("M365 Copilot turn aborted before start", "AbortError");
    }

    // 1. Khởi tạo Domain Model 1:1 đại diện cho toàn bộ Raw JSON Request của Codex
    const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
    let turnConsumed = false;
    const markTurnConsumed = (): boolean => {
      if (turnConsumed) {
        console.warn(`[m365-adapter] Lượt này đã được consume trước đó. Bỏ qua emit trùng lặp.`);
        return false;
      }
      turnConsumed = true;
      return true;
    };

    const rawConversationKey = incoming.headers.get("x-codex-conversation-key")
      || rawPayload.getThreadId()
      || undefined;
    const conversationKey = m365ConversationKey(parsed, rawConversationKey);

    const hasPriorAssistantReply = (parsed.context.messages || []).some(m => m.role === "assistant");
    const isNewConversation = !hasPriorAssistantReply;

    // Kiểm tra an toàn: Nếu tin nhắn cuối cùng trong context đã là assistant final answer (không có pending tool calls, không có input mới)
    const allMsgs = parsed.context.messages || [];
    const lastMsg = allMsgs[allMsgs.length - 1];
    if (isAssistantFinalAnswer(lastMsg)) {
      console.log(`[m365-adapter] Cuộc hội thoại đã kết thúc bằng phản hồi của trợ lý và không có pending tool call hoặc input mới. Hoàn tất lượt.`);
      if (conversationKey) {
        conversationGuard.delete(conversationKey);
      }
      emitStructuredEvent({
        level: "info",
        event: "m365.turn.completed",
        traceContext,
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
      return;
    }

    // 2. Biên dịch prompt cho phiên M365 stateful.
    const payload = CodexRawPayload.from(rawPayload || parsed._rawBody || parsed);
    const normalized = CodexPayloadNormalizer.normalize(payload);
    const compileResult = promptCompiler.compile({
      normalized,
      parsed,
      isNewConversation,
    });
    const promptToSend = compileResult.finalPrompt;
    const compiledPrompt = promptToSend;

    // 3. Title Guard: Phản hồi tức thì yêu cầu tiêu đề ngầm (5ms)
    // MẶC ĐỊNH DISABLED. Chỉ kích hoạt khi được cấu hình bật tường minh qua options hoặc env var
    // TUYỆT ĐỐI không đánh chặn nếu lượt này có tool results từ IDE
    if (
      normalized.trailingToolResults.length === 0 &&
      isTitleRequest(parsed, compiledPrompt, { enableTitleGuard: this.options?.enableTitleGuard })
    ) {
      if (!markTurnConsumed()) {
        return;
      }
      const titleText = generateTitleResponse(compiledPrompt);
      const usage = {
        inputTokens: Math.ceil(compiledPrompt.length / 4),
        outputTokens: Math.ceil(titleText.length / 4),
        totalTokens: Math.ceil((compiledPrompt.length + titleText.length) / 4),
      };
      emitStructuredEvent({
        level: "info",
        event: "m365.turn.completed",
        traceContext,
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
      return;
    }

    // 4. Chuyển giao prompt thực tế cho WebContentsView M365 Copilot qua CDP
    try {
      // Toàn bộ response bị quarantine cho tới khi strict parser xác nhận envelope hoàn chỉnh.
      // Không stream trực tiếp để response lỗi format không thể rò rỉ sang Codex UI.
      let streamedAnyText = false;
      const configuredRetries = Number.parseInt(process.env.M365_FORMAT_MAX_RETRIES || "3", 10);
      const maxFormatRetries = Number.isFinite(configuredRetries) && configuredRetries >= 0
        ? Math.min(configuredRetries, 10)
        : 3;
      let attemptPrompt = promptToSend;
      let totalPromptChars = compiledPrompt.length;
      let reply = "";
      let protocolResult: StrictM365ResponseResult | null = null;

      for (let formatAttempt = 0; formatAttempt <= maxFormatRetries; formatAttempt++) {
        reply = await executeM365Turn(attemptPrompt, {
          // Quarantine: browser vẫn thu thập stream nhưng adapter không emit trước validation.
          onChunk: () => { },
          signal: incoming.abortSignal,
          traceId: incoming.headers.get("x-codex-trace-id") || undefined,
          conversationKey,
          isNewConversation: formatAttempt === 0 ? isNewConversation : false,
          modelSlug: parsed.modelId,
          traceContext,
          images: formatAttempt === 0 ? normalized.images : [],
        });

        protocolResult = parseStrictM365Response(reply);
        if (protocolResult.kind === "tool_calls") {
          const clientTools = parsed.context.tools || [];
          for (const call of protocolResult.calls) {
            const normalizedCall = normalizeM365ToolArguments(call.name, call.arguments);
            const validation = validateM365ToolCall(normalizedCall.name, normalizedCall.arguments, clientTools);
            if (!validation.ok) {
              protocolResult = {
                kind: "protocol_error",
                code: "INVALID_TOOL_CALL",
                message: `${validation.code}: ${validation.message}`,
                rawResponse: reply,
              };
              break;
            }
          }
        }
        if (protocolResult.kind !== "protocol_error") break;

        emitStructuredEvent({
          level: "warning",
          event: "m365.response.format_retry",
          traceContext,
          safeDetails: {
            attempt: formatAttempt + 1,
            maxAttempts: maxFormatRetries + 1,
            code: protocolResult.code,
            message: protocolResult.message,
          },
          diagnosticDetails: {
            responseChars: reply.length,
          },
        });

        if (formatAttempt >= maxFormatRetries) {
          throw new Error(
            `[M365 Format Error] Đã hủy response sau ${maxFormatRetries + 1} lần vì sai protocol (${protocolResult.code}): ${protocolResult.message}`
          );
        }

        const retryInstruction = buildM365FormatRetryPrompt({
          code: protocolResult.code,
          message: protocolResult.message,
        });
        attemptPrompt = retryInstruction;
        totalPromptChars += attemptPrompt.length;
      }

      if (!protocolResult || protocolResult.kind === "protocol_error") {
        throw new Error("[M365 Format Error] Không nhận được response protocol hợp lệ.");
      }

      const detectedToolCalls: Array<{ id?: string; name: string; arguments: any }> =
        protocolResult.kind === "tool_calls" ? protocolResult.calls : [];
      const finalContent = protocolResult.kind === "final_answer" ? protocolResult.content : "";

      const inputTokens = Math.ceil(totalPromptChars / 4);
      const outputTokens = Math.ceil((reply.length || 10) / 4);
      const usage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };

      if (detectedToolCalls.length > 0) {
        const clientTools = parsed.context.tools || [];
        const detectedShell = extractClientShell(parsed);
        const mappedCalls = detectedToolCalls.map(rawCall => ({
          rawCall,
          mapped: M365ToolBridge.mapToolCall(rawCall, clientTools, { shell: detectedShell }),
          callId: rawCall.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        }));

        for (const { mapped, callId } of mappedCalls) {
          emitStructuredEvent({
            level: "info",
            event: "m365.tool.detected",
            traceContext,
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
        const cKey = conversationKey || `transient_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`;
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
          traceContext,
          safeDetails: {
            toolIterations: guardState.toolIterations,
            identicalToolCount: guardState.identicalToolCount,
          },
        });

        // 1. Kiểm tra lặp lại cùng một tool call quá giới hạn liên tiếp (phân biệt read vs write)
        const currentToolName = mappedCalls[0]?.mapped.name || "unknown";
        const maxIdenticalAllowed = getMaxIdenticalToolCalls(currentToolName);
        if (guardState.identicalToolCount >= maxIdenticalAllowed) {
          console.warn(`[m365-guard] Ngắt vòng lặp: Công cụ ${currentToolName} bị gọi lặp lại ${maxIdenticalAllowed} lần liên tiếp.`);
          conversationGuard.delete(cKey);
          emitStructuredEvent({
            level: "error",
            event: "m365.loop.blocked",
            traceContext,
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
            traceContext,
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
            traceContext,
            safeDetails: {
              reason: "max_iterations_exceeded",
              toolIterations: guardState.toolIterations,
            },
          });
          emitStructuredEvent({
            level: "error",
            event: "m365.turn.completed",
            traceContext,
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

        if (!markTurnConsumed()) {
          console.warn(`[M365 TOOL] Lượt này đã được consume trước đó. Bỏ qua tool emit trùng lặp.`);
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
          traceContext,
          safeDetails: {
            completionType: "tool_call",
            terminalReason: "tool_calls_emitted",
            terminalExplanation: `Bridge Server đã phát lệnh gọi ${detectedToolCalls.length} công cụ về Codex: ${mappedCalls.map(c => c.mapped.name).join(", ")}. Codex sẽ tiếp tục thực thi và mở lượt tiếp theo.`,
            toolCount: detectedToolCalls.length,
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

        // [DEBUG PIPELINE] STEP 4: Bridge Server ➔ Codex IDE (OUTGOING SSE / TOOL CALLS)
        logDebugPipelineStation(
          4,
          "BRIDGE SERVER ➔ CODEX IDE (OUTGOING SSE / TOOL CALLS)",
          mappedCalls.map(c => ({
            id: c.callId,
            name: c.mapped.name,
            arguments: c.mapped.arguments,
          }))
        );

        console.log(`[M365 TOOL] emitted ${detectedToolCalls.length} tool(s) with stopReason=tool_use`);
        return;
      }

      // Chỉ emit sau khi toàn bộ m365Response đã được strict parser xác nhận hợp lệ.
      if (finalContent) {
        emit({ type: "text_delta", text: finalContent });
        streamedAnyText = true;
      }

      // Đảm bảo Responses stream có ít nhất 1 chunk text nếu không có tool calls
      if (!streamedAnyText) {
        emit({ type: "text_delta", text: "" });
      }

      console.log(`[m365-adapter] [done] conversationKey=${conversationKey} streamedAnyText=${streamedAnyText}`);
      if (conversationKey) {
        conversationGuard.delete(conversationKey);
      }
      const terminalReason = "model_final_answer";
      const terminalExplanation = "M365 Copilot hoàn tất một m365Response hợp lệ dạng Final Answer. Codex dừng chu trình agent và chờ người dùng.";
      console.log(`[m365-adapter] [turn-completed] terminalReason=${terminalReason} explanation=${terminalExplanation}`);

      if (!markTurnConsumed()) {
        console.warn(`[M365 FINAL] Lượt này đã được consume trước đó. Bỏ qua final answer emit trùng lặp.`);
        return;
      }

      emitStructuredEvent({
        level: "info",
        event: "m365.turn.completed",
        traceContext,
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

      // [DEBUG PIPELINE] STEP 4: Bridge Server ➔ Codex IDE (OUTGOING SSE / TOOL CALLS)
      const step4TextContent = finalContent.trim();
      logDebugPipelineStation(4, "BRIDGE SERVER ➔ CODEX IDE (OUTGOING SSE / TOOL CALLS)", step4TextContent || "(Phản hồi hoàn tất)");
    } catch (err: unknown) {
      if (conversationKey) {
        conversationGuard.delete(conversationKey);
      }
      if (incoming.abortSignal?.aborted) {
        console.log(`[m365-adapter] [aborted] turn aborted by incoming signal`);
        emitStructuredEvent({
          level: "warning",
          event: "m365.turn.completed",
          traceContext,
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
      console.error(`[m365-adapter] [error] ${message}`);
      emitStructuredEvent({
        level: "error",
        event: "m365.turn.completed",
        traceContext,
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
}

/**
 * Factory khởi tạo đối tượng M365CopilotAdapter với đầy đủ các cấu hình và dependencies cần thiết.
 */
export function createM365CopilotAdapter(): ProviderAdapter {

  return new M365CopilotAdapter();
}
