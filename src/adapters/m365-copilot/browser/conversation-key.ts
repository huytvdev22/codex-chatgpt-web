import type { CodexParsedRequest } from "../../../types";
import { buildWebConversationKey } from "../../web/conversation/conversation-key";

/**
 * Tạo khóa định danh ổn định cho một hội thoại M365 mà không làm lộ thread id
 * nguyên bản sang Launcher. Model là một phần của identity vì đổi model có thể
 * làm thay đổi capability và prompt contract của hội thoại đang được giữ lại.
 */
export function m365ConversationKey(
  parsed: CodexParsedRequest,
  rawConversationKey?: string,
): string | undefined {
  return buildWebConversationKey({
    provider: "m365-copilot",
    source: rawConversationKey,
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    includeReasoning: true,
  });
}
