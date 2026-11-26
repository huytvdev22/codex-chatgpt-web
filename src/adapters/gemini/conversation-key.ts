import type { CodexParsedRequest } from "../../types";
import { buildWebConversationKey } from "../web/conversation/conversation-key";

/**
 * Tạo khóa định danh ổn định (SHA-256 hex) cho hội thoại Gemini Web theo `(provider, source)`,
 * giữ nguyên tab Launcher & link chat khi đổi model hoặc mức reasoning trong cùng provider.
 */
export function geminiConversationKey(
  _parsed: CodexParsedRequest,
  rawConversationKey?: string,
): string | undefined {
  return buildWebConversationKey({
    provider: "gemini",
    source: rawConversationKey,
  });
}
