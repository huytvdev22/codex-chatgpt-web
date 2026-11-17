import type { ElectronSurfaceClient } from "../web/electron-surface-client";
import { AiStudioModelProvider, type AiStudioThinkingLevel } from "./model-provider";

/**
 * Ánh xạ mức reasoning từ Codex (`low` | `medium` | `high`) sang `Thinking Level` trên AI Studio UI.
 */
export function resolveAiStudioThinkingLevel(
  modelId = "ai-studio/gemini-4-hydrogen",
  requestedEffort?: string,
): AiStudioThinkingLevel {
  return AiStudioModelProvider.getInstance().resolveThinkingLevel(modelId, requestedEffort);
}

/**
 * Chọn đúng mức `Thinking Level` (`Low` | `Medium` | `High`) trên panel Run settings của AI Studio.
 */
export async function ensureAiStudioThinkingLevel(
  client: ElectronSurfaceClient,
  targetLevel: AiStudioThinkingLevel,
): Promise<void> {
  await client.call("aiStudioSelectThinkingLevel", { targetLevel });
}

