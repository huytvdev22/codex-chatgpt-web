import type { AdapterEvent, CodexParsedRequest } from "../../types";
import type { IncomingMeta, ProviderAdapter } from "../base";
import { isTitleRequest, generateTitleResponse } from "./title-guard";
import { compileM365Prompt } from "./prompt";
import { executeM365Turn } from "./browser-worker";

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
      const reply = await executeM365Turn(compiledPrompt, {
        onChunk: (delta) => {
          emit({ type: "text_delta", text: delta });
        },
        signal: incoming.abortSignal,
        traceId: incoming.headers.get("x-codex-trace-id") || undefined,
        conversationKey,
        isNewConversation,
      });

      const inputTokens = Math.ceil(compiledPrompt.length / 4);
      const outputTokens = Math.ceil(reply.length / 4);

      emit({
        type: "done",
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
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
