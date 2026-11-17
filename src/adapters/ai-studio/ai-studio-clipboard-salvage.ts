import type { ElectronSurfaceClient } from "../web/electron-surface-client";
import { AI_STUDIO_DOM_SELECTORS } from "./ai-studio-dom-observer";

/**
 * Tìm vị trí menu item `Copy as markdown` (ưu tiên) hoặc `Copy as text`
 * sau khi loại bỏ chữ icon ligature của Angular Material (`<mat-icon>`).
 */
export function resolveClipboardMenuItemIndex(labels: readonly string[]): number {
  let textFallbackIndex = -1;
  for (let i = 0; i < labels.length; i += 1) {
    const normalized = (labels[i] || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!normalized) continue;
    if (/\bcopy as markdown\b/.test(normalized)) {
      return i;
    }
    if (textFallbackIndex < 0 && /\bcopy as text\b/.test(normalized)) {
      textFallbackIndex = i;
    }
  }
  return textFallbackIndex;
}

/**
 * Bọc lại transport fence 4-backtick nếu nút copy code block trả về trực tiếp
 * `<webResponse>...</webResponse>` không có wrapper ngoài.
 */
export function normalizeCopiedAiStudioCodeSnippet(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^`{4}markdown\b/i.test(trimmed)) return trimmed;
  if (/^<webResponse\b/i.test(trimmed)) {
    return `\`\`\`\`markdown\n${trimmed}\n\`\`\`\``;
  }
  return trimmed;
}

/**
 * Cứu hộ phản hồi Markdown nguyên bản của Google AI Studio thông qua action
 * `Open options -> Copy as markdown` trên Electron surface.
 */
export class AiStudioClipboardSalvage {
  public async tryExtractMarkdown(
    client: ElectronSurfaceClient,
    baselineAnswerCount: number,
  ): Promise<string | null> {
    try {
      const result = await client.call<{ text?: string | null }>(
        "aiStudioCopyMarkdown",
        {
          baselineAnswerCount,
          modelTurnContainer: AI_STUDIO_DOM_SELECTORS.modelTurnContainer,
          thoughtPanel: AI_STUDIO_DOM_SELECTORS.thoughtPanel,
        },
      );
      return result?.text?.trim() || null;
    } catch {
      return null;
    }
  }
}

