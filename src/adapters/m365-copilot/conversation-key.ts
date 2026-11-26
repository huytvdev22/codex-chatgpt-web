import type { CodexParsedRequest } from "../../types";
import { buildWebConversationKey } from "../web/conversation/conversation-key";

/**
 * Tạo khóa định danh ổn định cho một hội thoại M365 theo `(provider, source)`
 * mà không làm lộ thread id nguyên bản sang Launcher; giữ nguyên link chat khi
 * đổi model hoặc capability mode trong cùng provider.
 */
export function m365ConversationKey(
  _parsed: CodexParsedRequest,
  rawConversationKey?: string,
): string | undefined {
  return buildWebConversationKey({
    provider: "m365-copilot",
    source: rawConversationKey,
  });
}
