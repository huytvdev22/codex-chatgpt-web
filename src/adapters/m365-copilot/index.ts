import { logFunctionInput } from "./debug-logger";
import type { AdapterEvent, CodexMessage, CodexParsedRequest } from "../../types";
import type { IncomingMeta, ProviderAdapter } from "../base";
import { isTitleRequest, generateTitleResponse } from "./guards";
import { compileM365Prompt, compileM365HybridForwardPrompt, promptCompiler } from "./prompts/index";
import { CodexRawPayload, CodexPayloadNormalizer } from "./normalization";
import { executeM365Turn } from "./browser";
import { M365ToolCallDetector, M365OutputTranslator, maskArgumentsForLog } from "./translation";
import { M365ToolBridge } from "./tools";
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
  resolveM365ConversationKey,
  extractProjectLabel,
  type ConversationGuardState,
} from "./session";
import { emitStructuredEvent } from "../../observability/emitter";
import { logDebugPipelineStation } from "../../observability/debug-logger";
import { traceStorage, secureToolFingerprint } from "../../observability/trace-context";
import path from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { TraceContext } from "../../observability/types";
import { readLauncherBrowserHostDescriptor } from "../../launcher-browser-host";

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
  logFunctionInput("index", "extractClientShell", { parsed });
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
  private readonly activeConversations = new Map<string, { lastSeenAt: number; turnCount: number }>();
  private readonly translator = new M365OutputTranslator();

    /**
   * Điều phối toàn bộ vòng đời của một lượt tương tác (turn): chuẩn hóa request, compile prompt, chạy browser worker và dịch kết quả.
   */
async runTurn(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void
  ): Promise<void> {
    logFunctionInput("index", "runTurn", { parsed, incoming, emit });
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

    // =========================================================================
    // 1. GIẢI THÍCH VỀ BIẾN isNewConversation (TRÁNH HIỂU NHẦM):
    // - hasPriorAssistantReply: kiểm tra xem trong context đã có phản hồi assistant nào chưa.
    // - resolveM365ConversationKey: Tự động phân tách phiên theo từng project workspace (CWD)
    //   và session/thread, định dạng: [projectName_hash]__[sessionToken/threadId].
    //   -> Khi mở project khác trong VS Code: sinh key riêng -> Launcher tự mở Tab M365 riêng.
    //   -> Khi bấm New Chat trên Codex: sinh session mới -> mở Tab M365 mới.
    //   -> Khi chat tiếp trong cùng phiên: giữ nguyên key -> tái sử dụng Tab M365 hiện tại.
    // - isNewConversation CHỈ ĐƯỢC COI LÀ TRUE TRONG 2 TRƯỜNG HỢP:
    //   (1) Người dùng bấm "New Chat" trên Codex IDE (!hasPriorAssistantReply).
    //   (2) Lần đầu tiên bắt gặp conversationKey của một cửa sổ VS Code mới (!isKnownConversation).
    // - TRONG SUỐT QUÁ TRÌNH CHAT TIẾP THEO CỦA CỬA SỔ ĐÓ (Request 2, 3, 4...):
    //   hasPriorAssistantReply === true và conversationKey đã được ghi nhận -> isNewConversation = FALSE.
    //   Khi đó trình duyệt TUYỆT ĐỐI KHÔNG BẤM NÚT "New Chat", KHÔNG reload trang,
    //   KHÔNG toggle lại nút Temporary Chat, phiên chat tạm thời được DUY TRÌ LIÊN TỤC.
    // =========================================================================
    const hasPriorAssistantReply = (parsed.context.messages || []).some(m => m.role === "assistant");
    const conversationKey = resolveM365ConversationKey({
      parsed,
      rawPayload,
      headers: incoming.headers,
      hasPriorAssistantReply,
    });
    const isKnownConversation = Boolean(conversationKey && this.activeConversations.has(conversationKey));
    const isNewConversation = !hasPriorAssistantReply || (Boolean(conversationKey) && !isKnownConversation);

    if (conversationKey) {
      const prev = this.activeConversations.get(conversationKey);
      this.activeConversations.set(conversationKey, {
        lastSeenAt: Date.now(),
        turnCount: (prev?.turnCount ?? 0) + 1,
      });

      // Tự động dọn dẹp các session không hoạt động sau 2 giờ nếu danh sách mở rộng quá 100 entries
      if (this.activeConversations.size > 100) {
        const now = Date.now();
        const twoHours = 2 * 60 * 60 * 1000;
        for (const [key, state] of this.activeConversations.entries()) {
          if (now - state.lastSeenAt > twoHours) {
            this.activeConversations.delete(key);
          }
        }
      }
    }

    // =========================================================================
    // 2. GIẢI THÍCH VỀ CỜ descriptor.m365TemporaryChatPerRequest (TRÁNH HIỂU NHẦM):
    // - Cờ này đọc từ cấu hình Launcher (mặc định là FALSE trong Launcher setup).
    // - NẾU BẬT (TRUE): Mỗi request (mỗi turn) sẽ bị cưỡng ép làm mới phiên từ đầu (Stateless Pure Forwarder),
    //   bọc prompt 4-backtick và reload về /chat ở MỌI REQUEST. Chỉ dùng khi người dùng muốn
    //   mỗi prompt là 1 lần chat hoàn toàn độc lập không lưu lịch sử ngữ cảnh.
    // - NẾU TẮT (FALSE - MẶC ĐỊNH): Hệ thống duy trì cuộc trò chuyện liên tục (Stateful Multi-Turn)
    //   qua các request trong cùng một cửa sổ VS Code. KHÔNG mở chat mới ở mỗi request!
    // - LƯU Ý BẢN CHẤT: Ngay cả khi cờ này là FALSE, hệ thống VẪN BẬT CUỘC TRÒ CHUYỆN TẠM THỜI (Temporary Chat)
    //   trên giao diện web M365 Copilot (để không lưu rác vào sidebar Chats) VÀ DUY TRÌ cuộc trò chuyện
    //   tạm thời đó xuyên suốt các lượt hỏi đáp cho đến khi bấm New Chat trên Codex!
    // =========================================================================
    let isTemporaryPerRequest = false;
    const descriptorPath = process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR
      || path.join(homedir(), ".codex-m365-copilot", "runtime", "launcher-browser.json");
    if (descriptorPath) {
      try {
        const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
        if (typeof (descriptor as any).m365TemporaryChatPerRequest === "boolean") {
          isTemporaryPerRequest = Boolean((descriptor as any).m365TemporaryChatPerRequest);
        }
      } catch (err) {
        console.warn(`[m365-adapter] Không thể đọc descriptor từ ${descriptorPath}:`, err);
      }
    }
    console.log(`[m365-adapter] Chế độ Temporary Chat Per Request: ${isTemporaryPerRequest ? "BẬT (Pure Forwarder)" : "TẮT (Stateful)"}`);

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

    // 2. Biên dịch prompt duy nhất: Tái sử dụng 100% dữ liệu từ Raw Content & Normalizer cho cả Stateful và Stateless
    const effectiveIsNewConversation = isTemporaryPerRequest ? true : isNewConversation;
    const payload = CodexRawPayload.from(rawPayload || parsed._rawBody || parsed);
    const normalized = CodexPayloadNormalizer.normalize(payload);
    const compileResult = promptCompiler.compile({
      normalized,
      parsed,
      isNewConversation: effectiveIsNewConversation,
    });
    const promptToSend = compileResult.finalPrompt;
    const compiledPrompt = promptToSend;

    // 3. Title Guard: Phản hồi tức thì yêu cầu tiêu đề ngầm (5ms)
    if (isTitleRequest(parsed, compiledPrompt)) {
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
      const toolDetector = new M365ToolCallDetector({ renderThinkingInText: true });
      let streamedAnyText = false;

      const rawTurnId = rawPayload.getTurnId();
      const cleanTurnId = rawTurnId ? rawTurnId.replace(/[^A-Za-z0-9_-]/g, "_") : undefined;
      const traceId = incoming.headers.get("x-codex-trace-id")
        || (cleanTurnId && cleanTurnId.length >= 6 ? cleanTurnId : undefined)
        || `turn_${randomBytes(8).toString("hex")}`;
      const projectLabel = extractProjectLabel(parsed, rawPayload, incoming.headers);

      const reply = await executeM365Turn(promptToSend, {
        onChunk: (delta) => {
          const safeText = toolDetector.feed(delta);
          if (safeText) {
            streamedAnyText = true;
            emit({ type: "text_delta", text: safeText });
          }
        },
        signal: incoming.abortSignal,
        traceId,
        conversationKey,
        isNewConversation: isTemporaryPerRequest ? true : isNewConversation,
        forceTemporaryChat: isTemporaryPerRequest,
        modelSlug: parsed.modelId,
        providerId: incoming.headers.get("x-codex-provider") || undefined,
        traceContext,
        projectLabel,
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

        // Cognitive Loop: Phát khối suy nghĩ nội tâm (thinking) và lời dẫn dắt (narrative) trước tool calls
        if (translated.thinking && !streamedAnyText) {
          console.log(`[M365 COGNITIVE] emit thinking: ${translated.thinking.slice(0, 100)}...`);
          emit({ type: "thinking_delta", thinking: translated.thinking });
        }

        if (!streamedAnyText) {
          let preToolText = "";
          if (translated.thinking) {
            preToolText += `💭 ${translated.thinking.trim()}\n\n`;
          }
          if (translated.narrative) {
            preToolText += translated.narrative;
          } else if (remainingText) {
            preToolText += remainingText;
          }
          if (preToolText) {
            console.log(`[M365 COGNITIVE] emit pre-tool text: ${preToolText.slice(0, 100)}...`);
            emit({ type: "text_delta", text: preToolText });
            streamedAnyText = true;
          }
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
            thinking: translated.thinking ? true : false,
            narrative: translated.narrative ? true : false,
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

      // Xử lý nhánh Final Answer: Phát thinking (nếu có) trước khi phát text kết luận nếu chưa từng stream text
      if (translated.thinking && !streamedAnyText) {
        console.log(`[M365 COGNITIVE] emit final answer thinking: ${translated.thinking.slice(0, 100)}...`);
        emit({ type: "thinking_delta", thinking: translated.thinking });
      }

      if (streamedAnyText) {
        // Đã stream realtime qua onChunk: chỉ xả phần text dở dang còn sót lại trong buffer (nếu có)
        // Tuyệt đối không emit lại toàn bộ finalText để tránh nhân đôi câu trả lời trên Codex UI
        if (remainingText) {
          emit({ type: "text_delta", text: remainingText });
        }
      } else {
        // Fallback an toàn: Nếu chưa từng stream chunk nào qua onChunk, emit toàn bộ câu trả lời hoàn chỉnh
        let finalText = translated.type === "final_answer" ? translated.content : (remainingText || fullContent);
        finalText = finalText.replace(/<\s*\/?\s*m365[\\_]*response\s*>/gi, "").trim();
        if (translated.thinking && !finalText.includes("💭")) {
          finalText = `💭 ${translated.thinking.trim()}\n\n${finalText}`;
        }
        if (finalText) {
          emit({ type: "text_delta", text: finalText });
          streamedAnyText = true;
        } else {
          emit({ type: "text_delta", text: "" });
        }
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

      if (!markTurnConsumed()) {
        console.warn(`[M365 FINAL] Lượt này đã được consume trước đó. Bỏ qua final answer emit trùng lặp.`);
        return;
      }

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

/**
 * Factory khởi tạo đối tượng M365CopilotAdapter với đầy đủ các cấu hình và dependencies cần thiết.
 */
export function createM365CopilotAdapter(): ProviderAdapter {
  logFunctionInput("index", "createM365CopilotAdapter");
  return new M365CopilotAdapter();
}

