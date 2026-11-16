import type { Page } from "playwright-core";
import { AI_STUDIO_DOM_SELECTORS } from "./ai-studio-dom-observer";

const ANSWER_TURN_SELECTOR = `${AI_STUDIO_DOM_SELECTORS.modelTurnContainer}:not(:has(${AI_STUDIO_DOM_SELECTORS.thoughtPanel}))`;
const OPEN_OPTIONS_BUTTON_SELECTOR = 'button[aria-label="Open options"]';
const MENU_ITEM_SELECTOR = 'div.mat-mdc-menu-panel[role="menu"] button.mat-mdc-menu-item';

/**
 * Cứu hộ phản hồi Markdown nguyên bản của Google AI Studio thông qua action
 * `Open options -> Copy as markdown` với clipboard hook nội bộ (không làm bẩn OS clipboard).
 */
export class AiStudioClipboardSalvage {
  public async tryExtractMarkdown(
    page: Page,
    baselineAnswerCount: number,
  ): Promise<string | null> {
    try {
      await page.bringToFront().catch(() => {});
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});

      await page.evaluate(() => {
        const win = window as unknown as Record<string, unknown>;
        win.__aistudio_last_copied_markdown = null;
        if (!win.__aistudio_clipboard_hooked && navigator.clipboard) {
          win.__aistudio_clipboard_hooked = true;
          const origWriteText = navigator.clipboard.writeText?.bind(navigator.clipboard);
          navigator.clipboard.writeText = async (text: string) => {
            win.__aistudio_last_copied_markdown = text;
            if (!origWriteText) return;
            try {
              await origWriteText(text);
            } catch {
              // Hook đã giữ nguyên giá trị văn bản nếu trình duyệt từ chối ghi clipboard hệ thống.
            }
          };
        }
      });

      const answerTurns = page.locator(ANSWER_TURN_SELECTOR);
      const count = await answerTurns.count();
      if (count <= baselineAnswerCount) {
        return null;
      }

      const targetTurn = answerTurns.nth(count - 1);
      await targetTurn.scrollIntoViewIfNeeded().catch(() => {});
      await targetTurn.hover({ timeout: 2_000 });

      const openOptionsBtn = targetTurn.locator(OPEN_OPTIONS_BUTTON_SELECTOR).first();
      await openOptionsBtn.waitFor({ state: "visible", timeout: 2_000 });
      await openOptionsBtn.click({ timeout: 2_000 });

      const menuItems = page.locator(MENU_ITEM_SELECTOR);
      await menuItems.first().waitFor({ state: "visible", timeout: 2_000 });

      const itemCount = await menuItems.count();
      let markdownItemIndex = -1;
      let textFallbackIndex = -1;
      for (let i = 0; i < itemCount; i += 1) {
        const label = ((await menuItems.nth(i).innerText().catch(() => "")) || "").trim().toLowerCase();
        if (label === "copy as markdown") {
          markdownItemIndex = i;
          break;
        }
        if (label === "copy as text") {
          textFallbackIndex = i;
        }
      }

      const chosenIndex = markdownItemIndex >= 0 ? markdownItemIndex : textFallbackIndex;
      if (chosenIndex < 0) {
        await page.keyboard.press("Escape").catch(() => {});
        return null;
      }

      await menuItems.nth(chosenIndex).click({ timeout: 2_000 });
      await page.waitForTimeout(200);

      const copied = await page.evaluate(() => {
        const win = window as unknown as Record<string, unknown>;
        return typeof win.__aistudio_last_copied_markdown === "string"
          ? win.__aistudio_last_copied_markdown
          : null;
      });

      return copied && copied.trim().length > 0 ? copied.trim() : null;
    } catch {
      await page.keyboard.press("Escape").catch(() => {});
      return null;
    }
  }
}

