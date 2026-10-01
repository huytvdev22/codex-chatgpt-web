import type { AdapterEvent, CodexParsedRequest } from "../../types";
import type { IncomingMeta, ProviderAdapter } from "../base";
import { isTitleRequest, generateTitleResponse } from "./title-guard";
import { compileM365Prompt } from "./prompt";
import { executeM365Turn } from "./browser-worker";
import { M365ToolCallDetector } from "./markdown";
import { M365ToolBridge } from "./tool-bridge";


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

      const reply = await executeM365Turn(compiledPrompt, {
        onChunk: (delta) => {
          const safeText = toolDetector.feed(delta);
          if (safeText) {
            emit({ type: "text_delta", text: safeText });
          }
        },
        signal: incoming.abortSignal,
        traceId: incoming.headers.get("x-codex-trace-id") || undefined,
        conversationKey,
        isNewConversation,
        shouldStop: () => toolDetector.hasDetectedToolCall(),
      });

      const { remainingText, toolCall } = toolDetector.finish();
      const detectedToolCall = toolCall || toolDetector.getToolCall();

      const inputTokens = Math.ceil(compiledPrompt.length / 4);
      const outputTokens = Math.ceil((reply.length || 10) / 4);
      const usage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };

      if (detectedToolCall) {
        const clientTools = parsed.context.tools || [];
        const detectedShell = extractClientShell(parsed);
        const mapped = M365ToolBridge.mapToolCall(detectedToolCall, clientTools, { shell: detectedShell });
        const callId = `call_${Math.random().toString(36).slice(2, 10)}`;

        console.log("[M365 TOOL] detected tool call");
        console.log(`[M365 TOOL] original name=${detectedToolCall.name}`);
        console.log(`[M365 TOOL] mapped name=${mapped.name}`);
        console.log(`[M365 TOOL] arguments=${mapped.arguments}`);

        emit({ type: "tool_call_start", id: callId, name: mapped.name });
        emit({ type: "tool_call_delta", arguments: mapped.arguments });
        emit({ type: "tool_call_end" });
        emit({
          type: "done",
          stopReason: "tool_use",
          endTurn: false,
          usage,
        });

        console.log("[M365 TOOL] emitted tool_use");
        return;
      }

      if (remainingText) {
        emit({ type: "text_delta", text: remainingText });
      }

      emit({
        type: "done",
        usage,
      });
    } catch (err: unknown) {
      if (incoming.abortSignal?.aborted) {
        throw new DOMException("M365 Copilot turn aborted", "AbortError");
      }
      const message = err instanceof Error ? err.message : String(err);
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
