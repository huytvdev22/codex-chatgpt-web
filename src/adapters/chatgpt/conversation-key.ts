import type { CodexParsedRequest } from "../../types";
import { buildWebConversationKey } from "../web/conversation/conversation-key";

/**
 * Tạo khóa định danh ổn định (SHA-256 hex) cho hội thoại ChatGPT Web,
 * tách biệt theo model và mức reasoning để tránh dùng nhầm luồng khi chuyển mode.
 */
export function chatGptConversationKey(
  parsed: CodexParsedRequest,
  rawConversationKey?: string,
): string | undefined {
  return buildWebConversationKey({
    provider: "chatgpt",
    source: rawConversationKey,
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    includeReasoning: true,
  });
}
