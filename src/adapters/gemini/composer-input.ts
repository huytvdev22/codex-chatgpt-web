import type { Locator, Page } from "playwright-core";

/**
 * Click và focus vào ô nhập liệu Gemini, tự thoát overlay/tooltip `.cdk-overlay-container`
 * nếu đang che pointer events thay vì fail timeout sau 3s.
 */
export async function focusGeminiComposer(
  page: Page,
  composerLocator: Locator,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await composerLocator.click({ timeout: 3_000 });
  } catch (error) {
    if (signal?.aborted) throw error;
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(150);
    try {
      await composerLocator.click({ timeout: 1_500 });
    } catch {
      if (signal?.aborted) throw error;
      await composerLocator.click({ force: true, timeout: 1_500 }).catch(() => {});
    }
  }
  await composerLocator.focus({ timeout: 2_000 }).catch(() => {});
}
