import type { AdapterEvent, CodexMessage, CodexParsedRequest } from "../../types";
import type { IncomingMeta, ProviderAdapter } from "../base";
import { isTitleRequest, generateTitleResponse } from "./title-guard";
import { compileM365Prompt } from "./prompt";
import { executeM365Turn } from "./browser-worker";
import { M365ToolCallDetector } from "./markdown";
import { M365ToolBridge } from "./tool-bridge";
import { M365OutputTranslator, maskArgumentsForLog } from "./output-translator";
import { emitStructuredEvent } from "../../observability/emitter";
import { logDebugPipelineStation } from "../../observability/debug-logger";
import { traceStorage, secureToolFingerprint } from "../../observability/trace-context";
import path from "node:path";
import { homedir } from "node:os";
import type { TraceContext } from "../../observability/types";
import { readLauncherBrowserHostDescriptor } from "../../launcher-browser-host";

export * from "./bash-translator";
export * from "./output-translator";
export * from "./agent-loop";
export * from "./tool-bridge";
export * from "./capability-picker";

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

export function stableSortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") {
      return value.replace(/\\/g, "/").trim();
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stableSortValue);
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = stableSortValue(obj[key]);
  }
  return sorted;
}

export function stableToolFingerprint(name: string, rawArgs: unknown): string {
  let parsedArgs = rawArgs;
  if (typeof rawArgs === "string") {
    try {
      parsedArgs = JSON.parse(rawArgs);
    } catch {
      parsedArgs = rawArgs.trim();
    }
  }
  const normalized = stableSortValue(parsedArgs);
  return `${name.trim()}:${JSON.stringify(normalized)}`;
}

export function isToolCallPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const p = part as Record<string, unknown>;
  const typeStr = typeof p.type === "string" ? p.type.toLowerCase() : "";
  return (
    typeStr === "toolcall" ||
    typeStr === "tool_call" ||
    typeStr === "function_call" ||
    typeStr === "functioncall" ||
    typeStr === "custom_tool_call" ||
    typeStr === "tool_search_call" ||
    p.call_id !== undefined ||
    p.callId !== undefined ||
    p.function !== undefined
  );
}

export function isAssistantFinalAnswer(msg: CodexMessage | undefined): boolean {
  if (!msg || msg.role !== "assistant") return false;

  // 1. Nếu content là string: Kiểm tra xem có chứa XML tool_call serialize không
  if (typeof msg.content === "string") {
    if (/<tool[\\_]*call>/i.test(msg.content)) {
      return false;
    }
    return true;
  }

  // 2. Nếu content là structured parts: Kiểm tra toàn bộ schema biến thể của tool call
  if (Array.isArray(msg.content)) {
    const hasToolCall = msg.content.some(isToolCallPart);
    return !hasToolCall;
  }

  return true;
}

interface ConversationGuardState {
  toolIterations: number;
  lastToolFingerprint?: string;
  identicalToolCount: number;
  updatedAt: number;
}

export const MAX_TOOL_ITERATIONS = 100;
export const MAX_IDENTICAL_TOOL_CALLS = 10;
const GUARD_TTL_MS = 15 * 60 * 1000; // 15 phút

export const conversationGuard = new Map<string, ConversationGuardState>();

export function cleanExpiredConversationGuards(now = Date.now()): void {
  for (const [key, state] of conversationGuard.entries()) {
    if (now - state.updatedAt > GUARD_TTL_MS) {
      conversationGuard.delete(key);
    }
  }
  if (conversationGuard.size > 1000) {
    const entries = [...conversationGuard.entries()]
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (let i = 0; i < Math.min(200, entries.length); i++) {
      conversationGuard.delete(entries[i][0]);
    }
  }
}

export class M365CopilotAdapter implements ProviderAdapter {
  readonly name = "m365-copilot";
  private lastConversationKey?: string;
  private readonly translator = new M365OutputTranslator();

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

    // 1. Xác định định danh phiên trò chuyện và kiểm tra xem có phải cuộc trò chuyện mới
    const rawBody = parsed._rawBody as Record<string, any> | undefined;
    const clientMeta = rawBody?.client_metadata as Record<string, any> | undefined;
    const turnMeta = clientMeta?.["x-codex-turn-metadata"];
    const parsedTurnMeta = typeof turnMeta === "string" ? (() => { try { return JSON.parse(turnMeta); } catch { return undefined; } })() : turnMeta;

    const conversationKey = incoming.headers.get("x-codex-conversation-key")
      || parsedTurnMeta?.thread_id
      || clientMeta?.thread_id
      || undefined;

    const hasPriorAssistantReply = (parsed.context.messages || []).some(m => m.role === "assistant");
    const isNewConversation = !hasPriorAssistantReply || (
      Boolean(conversationKey) && Boolean(this.lastConversationKey) && this.lastConversationKey !== conversationKey
    );

    if (conversationKey) {
      this.lastConversationKey = conversationKey;
    }

    // 1.1. Kiểm tra cấu hình Temporary Chat Per Request từ Launcher
    let isTemporaryPerRequest = false;
    const descriptorPath = process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR
      || path.join(homedir(), ".codex-m365-copilot", "runtime", "launcher-browser.json");
    if (descriptorPath) {
      try {
        const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
        isTemporaryPerRequest = Boolean(descriptor.m365TemporaryChatPerRequest);
      } catch (err) {
        console.warn(`[m365-adapter] Không thể đọc descriptor từ ${descriptorPath}:`, err);
      }
    }
    console.log(`[m365-adapter] Chế độ Temporary Chat Per Request: ${isTemporaryPerRequest ? "BẬT (Pure Forwarder)" : "TẮT (Stateful)"}`);

    // Kiểm tra an toàn: Nếu tin nhắn cuối cùng trong context đã là assistant final answer (không có pending tool calls, không có input mới)
    // (Chỉ áp dụng trong chế độ Stateful thông thường)
    const allMsgs = parsed.context.messages || [];
    const lastMsg = allMsgs[allMsgs.length - 1];
    if (!isTemporaryPerRequest && isAssistantFinalAnswer(lastMsg)) {
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

    // 2. Biên dịch prompt: Nếu ở chế độ Temporary Per Request thì forward nguyên trạng raw request của Codex (không format json để tiết kiệm token)
    const compiledPrompt = compileM365Prompt(parsed, isNewConversation);
    const promptToSend = isTemporaryPerRequest
      ? (typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody || parsed))
      : compiledPrompt;

    // 3. Title Guard: Phản hồi tức thì yêu cầu tiêu đề ngầm (5ms)
    if (isTitleRequest(parsed, compiledPrompt)) {
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
      const toolDetector = new M365ToolCallDetector();
      let streamedAnyText = false;

      const reply = await executeM365Turn(promptToSend, {
        onChunk: (delta) => {
          const safeText = toolDetector.feed(delta);
          if (safeText) {
            streamedAnyText = true;
            emit({ type: "text_delta", text: safeText });
          }
        },
        signal: incoming.abortSignal,
        traceId: incoming.headers.get("x-codex-trace-id") || undefined,
        conversationKey,
        isNewConversation: isTemporaryPerRequest ? true : isNewConversation,
        forceTemporaryChat: isTemporaryPerRequest,
        shouldStop: () => toolDetector.hasDetectedToolCall(),
        modelSlug: parsed.modelId,
        traceContext,
      });

      const { remainingText, toolCall } = toolDetector.finish();
      let detectedToolCalls: Array<{ id?: string; name: string; arguments: any }> = [];

      // Ưu tiên kiểm tra qua M365OutputTranslator để hỗ trợ đầy đủ JSON, XML, Bash và Parallel Tool Calls
      const fullContent = reply || remainingText;
      const translated = this.translator.translate(fullContent);
      if (translated.type === "tool_call" && translated.tool_calls.length > 0) {
        detectedToolCalls = translated.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        }));
      } else if (toolCall || toolDetector.getToolCall()) {
        const single = (toolCall || toolDetector.getToolCall())!;
        detectedToolCalls = [{
          name: single.name,
          arguments: single.arguments,
        }];
      }

      const inputTokens = Math.ceil(compiledPrompt.length / 4);
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

        // 1. Kiểm tra lặp lại cùng một tool call quá 3 lần liên tiếp
        if (guardState.identicalToolCount >= MAX_IDENTICAL_TOOL_CALLS) {
          console.warn(`[m365-guard] Ngắt vòng lặp: Công cụ bị gọi lặp lại ${MAX_IDENTICAL_TOOL_CALLS} lần liên tiếp.`);
          conversationGuard.delete(cKey);
          emitStructuredEvent({
            level: "error",
            event: "m365.loop.blocked",
            traceContext,
            safeDetails: {
              reason: "repeated_tool_call",
              toolName: mappedCalls[0]?.mapped.name,
              identicalCount: guardState.identicalToolCount,
            },
          });
          emitStructuredEvent({
            level: "error",
            event: "m365.turn.completed",
            traceContext,
            safeDetails: {
              completionType: "loop_blocked",
              terminalReason: "loop_blocked_repeated_tool",
              terminalExplanation: `Ngắt vòng lặp an toàn: Công cụ ${mappedCalls[0]?.mapped.name} bị gọi lặp lại ${MAX_IDENTICAL_TOOL_CALLS} lần liên tiếp với cùng tham số.`,
              toolCount: 0,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            },
          });
          emit({
            type: "text_delta",
            text: `\n\n> [!WARNING]\n> **Phát hiện vòng lặp vô hạn (Repeated Tool Calls):** Công cụ \`${mappedCalls[0].mapped.name}\` đã được yêu cầu lặp lại ${MAX_IDENTICAL_TOOL_CALLS} lần liên tiếp với cùng tham số. Hệ thống tự động kết thúc để bảo vệ môi trường làm việc.`,
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

        for (const { mapped, callId } of mappedCalls) {
          console.log(`[M365 TOOL] emit tool call: ${mapped.name} (${callId})`);
          console.log(`[M365 TOOL] arguments=${maskArgumentsForLog(mapped.arguments)}`);

          emit({ type: "tool_call_start", id: callId, name: mapped.name });
          emit({ type: "tool_call_delta", arguments: mapped.arguments });
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

      if (remainingText) {
        emit({ type: "text_delta", text: remainingText });
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
      const isSuspiciousFallback = Boolean(translated.parseDiagnostics?.suspiciousToolDetected);
      const terminalReason = isSuspiciousFallback
        ? "parse_failed_fallback_final_answer"
        : (translated.parseDiagnostics?.terminalReason || "model_final_answer");

      const terminalExplanation = isSuspiciousFallback
        ? `CẢNH BÁO: M365 có sinh khối công cụ nhưng parser bị lỗi JSON (${translated.parseDiagnostics?.warningMessage || "cú pháp hỏng"}), dẫn đến bị fallback sang văn bản thường làm Codex dừng lại.`
        : (translated.parseDiagnostics?.warningMessage || "M365 Copilot hoàn tất câu trả lời kết luận (Final Answer). Codex dừng chu trình agent và chờ người dùng.");

      if (isSuspiciousFallback) {
        console.warn(`[m365-adapter] [PARSER-FALLBACK-WARNING] Phát hiện fallback nguy hiểm sang final_answer:`, translated.parseDiagnostics);
      }
      console.log(`[m365-adapter] [turn-completed] terminalReason=${terminalReason} explanation=${terminalExplanation}`);

      emitStructuredEvent({
        level: isSuspiciousFallback ? "warning" : "info",
        event: "m365.turn.completed",
        traceContext,
        safeDetails: {
          completionType: isSuspiciousFallback ? "parse_failed" : "final_answer",
          terminalReason,
          terminalExplanation,
          ...(translated.parseDiagnostics ? { parseDiagnostics: translated.parseDiagnostics } : {}),
          toolCount: 0,
          finalAnswer: reply || remainingText || "",
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
      const step4TextContent = (reply || remainingText || "").trim();
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

export function createM365CopilotAdapter(): ProviderAdapter {
  return new M365CopilotAdapter();
}

