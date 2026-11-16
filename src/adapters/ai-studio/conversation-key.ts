import type { CodexParsedRequest } from "../../types";
import { buildWebConversationKey } from "../web/conversation";

/**
 * Tạo khóa định danh ổn định (SHA-256 hex) cho một hội thoại AI Studio trên Launcher
 * mà không để lộ `threadId` gốc của Codex.
 */
export function aiStudioConversationKey(
  parsed: CodexParsedRequest,
  rawConversationKey?: string,
): string | undefined {
  return buildWebConversationKey({
    provider: "ai-studio",
    source: rawConversationKey,
    modelId: parsed.modelId,
  });
}
