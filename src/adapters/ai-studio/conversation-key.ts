import type { CodexParsedRequest } from "../../types";
import { buildWebConversationKey } from "../web/conversation";

/**
 * Tạo khóa định danh ổn định (SHA-256 hex) cho một hội thoại AI Studio trên Launcher
 * theo `(provider, source)`, giữ nguyên link chat khi đổi model hoặc reasoning trong cùng provider.
 */
export function aiStudioConversationKey(
  _parsed: CodexParsedRequest,
  rawConversationKey?: string,
): string | undefined {
  return buildWebConversationKey({
    provider: "ai-studio",
    source: rawConversationKey,
  });
}
