import { createHash } from "node:crypto";
import type { CodexParsedRequest } from "../../../types";

/**
 * Tạo khóa định danh ổn định cho một hội thoại M365 mà không làm lộ thread id
 * nguyên bản sang Launcher. Model là một phần của identity vì đổi model có thể
 * làm thay đổi capability và prompt contract của hội thoại đang được giữ lại.
 */
export function m365ConversationKey(
  parsed: CodexParsedRequest,
  rawConversationKey?: string,
): string | undefined {
  const source = rawConversationKey?.trim();
  if (!source) return undefined;

  return createHash("sha256").update(JSON.stringify({
    provider: "m365-copilot",
    source,
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
  })).digest("hex");
}
