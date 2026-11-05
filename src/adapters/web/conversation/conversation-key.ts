import { createHash } from "node:crypto";

export interface WebConversationKeyInput {
  provider: string;
  source?: string;
  modelId: string;
  reasoning?: string;
  includeReasoning?: boolean;
}

/**
 * Tạo khóa định danh ổn định (SHA-256 hex) cho hội thoại của Web Provider
 * mà không làm lộ threadId nguyên bản sang Launcher.
 */
export function buildWebConversationKey(
  input: WebConversationKeyInput,
): string | undefined {
  const source = input.source?.trim();
  if (!source) return undefined;

  const payload: Record<string, unknown> = {
    provider: input.provider,
    source,
    modelId: input.modelId,
  };
  if (input.includeReasoning) {
    payload.reasoning = input.reasoning;
  }

  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}
