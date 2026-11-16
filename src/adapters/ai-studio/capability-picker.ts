import type { Page } from "playwright-core";
import { AiStudioModelProvider, type AiStudioThinkingLevel } from "./model-provider";

const THINKING_LEVEL_SELECT = 'mat-select[role="combobox"][aria-label="Thinking Level"], #mat-select-0[aria-label="Thinking Level"]';
const SELECT_OPTION_SELECTOR = '.mat-mdc-select-panel [role="option"], [role="listbox"] [role="option"]';

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
  page: Page,
  targetLevel: AiStudioThinkingLevel,
): Promise<void> {
  const select = page.locator(THINKING_LEVEL_SELECT).first();
  const visible = await select.isVisible().catch(() => false);
  if (!visible) return;

  const currentText = ((await select.innerText().catch(() => "")) || "").trim().toLowerCase();
  if (currentText === targetLevel.toLowerCase()) return;

  await select.click({ timeout: 3_000 });
  const options = page.locator(SELECT_OPTION_SELECTOR);
  await options.first().waitFor({ state: "visible", timeout: 3_000 });

  const count = await options.count();
  for (let i = 0; i < count; i += 1) {
    const option = options.nth(i);
    const label = ((await option.innerText().catch(() => "")) || "").trim();
    if (label.toLowerCase() === targetLevel.toLowerCase()) {
      await option.click({ timeout: 2_000 });
      await page.waitForTimeout(150);
      return;
    }
  }

  await page.keyboard.press("Escape").catch(() => {});
}

