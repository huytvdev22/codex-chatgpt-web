import type { AdapterEvent, CodexParsedRequest } from "../../types";
import type { IncomingMeta, ProviderAdapter } from "../base";
import { isTitleRequest, generateTitleResponse } from "./title-guard";
import { compileM365Prompt } from "./prompt";
import { executeM365Turn } from "./browser-worker";
import { M365ToolCallDetector } from "./markdown";
import { M365ToolBridge } from "./tool-bridge";
import { M365OutputTranslator, maskArgumentsForLog } from "./output-translator";

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

export class M365CopilotAdapter implements ProviderAdapter {
  readonly name = "m365-copilot";
  private lastConversationKey?: string;
  private readonly translator = new M365OutputTranslator();

  async runTurn(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void
  ): Promise<void> {
    if (incoming.abortSignal?.aborted) {
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

    // 2. Biên dịch prompt (chỉ gửi tin nhắn mới nếu đang tiếp tục cuộc trò chuyện)
    const compiledPrompt = compileM365Prompt(parsed, isNewConversation);

    // 3. Title Guard: Phản hồi tức thì yêu cầu tiêu đề ngầm (5ms)
    if (isTitleRequest(parsed, compiledPrompt)) {
      const titleText = generateTitleResponse(compiledPrompt);
      emit({ type: "text_delta", text: titleText });
      emit({
        type: "done",
        usage: {
          inputTokens: Math.ceil(compiledPrompt.length / 4),
          outputTokens: Math.ceil(titleText.length / 4),
          totalTokens: Math.ceil((compiledPrompt.length + titleText.length) / 4),
        },
      });
      return;
    }

    // 4. Chuyển giao prompt thực tế cho WebContentsView M365 Copilot qua CDP
    try {
      const toolDetector = new M365ToolCallDetector();
      let streamedAnyText = false;

      const reply = await executeM365Turn(compiledPrompt, {
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
        isNewConversation,
        shouldStop: () => toolDetector.hasDetectedToolCall(),
        modelSlug: parsed.modelId,
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

        for (const rawCall of detectedToolCalls) {
          const mapped = M365ToolBridge.mapToolCall(rawCall, clientTools, { shell: detectedShell });
          const callId = rawCall.id || `call_${Math.random().toString(36).slice(2, 10)}`;

          console.log(`[M365 TOOL] emit tool call: ${mapped.name} (${callId})`);
          console.log(`[M365 TOOL] arguments=${maskArgumentsForLog(mapped.arguments)}`);

          emit({ type: "tool_call_start", id: callId, name: mapped.name });
          emit({ type: "tool_call_delta", arguments: mapped.arguments });
          emit({ type: "tool_call_end" });
        }

        emit({
          type: "done",
          stopReason: "tool_use",
          endTurn: false,
          usage,
        });

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
      emit({
        type: "done",
        usage,
      });
    } catch (err: unknown) {
      if (incoming.abortSignal?.aborted) {
        console.log(`[m365-adapter] [aborted] turn aborted by incoming signal`);
        throw new DOMException("M365 Copilot turn aborted", "AbortError");
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[m365-adapter] [error] ${message}`);
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

