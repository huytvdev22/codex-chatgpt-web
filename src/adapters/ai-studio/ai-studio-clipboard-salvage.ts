import type { Page } from "playwright-core";
import { AI_STUDIO_DOM_SELECTORS } from "./ai-studio-dom-observer";

const ANSWER_TURN_SELECTOR = `${AI_STUDIO_DOM_SELECTORS.modelTurnContainer}:not(:has(${AI_STUDIO_DOM_SELECTORS.thoughtPanel}))`;
const OPEN_OPTIONS_BUTTON_SELECTOR = 'button[aria-label="Open options"]';
const CODE_COPY_BUTTON_SELECTOR = 'ms-code-block button[aria-label="Copy code to clipboard"]';

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
 * `Open options -> Copy as markdown` (fallback sang nút `Copy code to clipboard`
 * của `ms-code-block`) với clipboard hook đa tầng.
 */
export class AiStudioClipboardSalvage {
  public async tryExtractMarkdown(
    page: Page,
    baselineAnswerCount: number,
  ): Promise<string | null> {
    try {
      await page.bringToFront().catch(() => {});
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
      await this.installClipboardHooks(page);

      const answerTurns = page.locator(ANSWER_TURN_SELECTOR);
      const count = await answerTurns.count();
      if (count <= baselineAnswerCount) {
        return null;
      }

      const targetTurn = answerTurns.nth(count - 1);
      await targetTurn.scrollIntoViewIfNeeded().catch(() => {});
      await targetTurn.hover({ position: { x: 24, y: 24 }, timeout: 2_000 }).catch(() => {});

      const viaMenu = await this.tryCopyViaOptionsMenu(page, targetTurn);
      if (viaMenu) {
        return viaMenu;
      }

      const codeBlocksCount = await targetTurn.locator("ms-code-block").count();
      if (codeBlocksCount === 1) {
        const copyCodeBtn = targetTurn.locator(CODE_COPY_BUTTON_SELECTOR).first();
        if (await copyCodeBtn.count() > 0) {
          await copyCodeBtn.scrollIntoViewIfNeeded().catch(() => {});
          await copyCodeBtn.click({ force: true, timeout: 2_000 }).catch(() => {});
          const copiedCode = await this.readCapturedClipboard(page);
          if (copiedCode) {
            return normalizeCopiedAiStudioCodeSnippet(copiedCode);
          }
        }
      }

      return null;
    } catch {
      await page.keyboard.press("Escape").catch(() => {});
      return null;
    }
  }

  private async tryCopyViaOptionsMenu(
    page: Page,
    targetTurn: ReturnType<Page["locator"]>,
  ): Promise<string | null> {
    try {
      const openOptionsBtn = targetTurn.locator(OPEN_OPTIONS_BUTTON_SELECTOR).first();
      if (await openOptionsBtn.count() === 0) return null;

      if (await page.locator('div.mat-mdc-menu-panel[role="menu"]').count() > 0) {
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(80);
      }

      await openOptionsBtn.scrollIntoViewIfNeeded().catch(() => {});
      await openOptionsBtn.click({ force: true, timeout: 2_000 });

      const menuPanel = page.locator('div.mat-mdc-menu-panel[role="menu"]').last();
      await menuPanel.waitFor({ state: "visible", timeout: 2_000 });
      const menuItems = menuPanel.locator('button.mat-mdc-menu-item');

      const itemCount = await menuItems.count();
      const labels: string[] = [];
      for (let i = 0; i < itemCount; i += 1) {
        const item = menuItems.nth(i);
        const text = (await item.innerText().catch(() => "")) || (await item.getAttribute("aria-label").catch(() => "")) || "";
        labels.push(text);
      }

      const chosenIndex = resolveClipboardMenuItemIndex(labels);
      if (chosenIndex < 0) {
        await page.keyboard.press("Escape").catch(() => {});
        return null;
      }

      await menuItems.nth(chosenIndex).click({ timeout: 2_000 });
      return await this.readCapturedClipboard(page);
    } catch {
      await page.keyboard.press("Escape").catch(() => {});
      return null;
    }
  }

  private async installClipboardHooks(page: Page): Promise<void> {
    await page.evaluate(() => {
      const win = window as unknown as Record<string, unknown>;
      win.__aistudio_last_copied_markdown = null;

      if (!win.__aistudio_clipboard_hooked) {
        win.__aistudio_clipboard_hooked = true;

        if (navigator.clipboard) {
          const origWriteText = navigator.clipboard.writeText?.bind(navigator.clipboard);
          navigator.clipboard.writeText = async (text: string) => {
            win.__aistudio_last_copied_markdown = text;
            if (!origWriteText) return;
            try {
              await origWriteText(text);
            } catch {
              // Giữ nguyên giá trị đã bắt nếu Chromium chặn ghi clipboard hệ thống.
            }
          };

          const origWrite = navigator.clipboard.write?.bind(navigator.clipboard);
          if (origWrite) {
            navigator.clipboard.write = async (items: ClipboardItems) => {
              try {
                for (const item of items) {
                  if (item.types.includes("text/plain")) {
                    const blob = await item.getType("text/plain");
                    const text = await blob.text();
                    if (text) win.__aistudio_last_copied_markdown = text;
                    break;
                  }
                }
              } catch {}
              try {
                await origWrite(items);
              } catch {}
            };
          }
        }

        document.addEventListener("copy", (event: ClipboardEvent) => {
          const clipText = event.clipboardData?.getData("text/plain");
          const activeEl = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null;
          const activeValue =
            activeEl && (activeEl.tagName === "TEXTAREA" || activeEl.tagName === "INPUT")
              ? activeEl.value
              : "";
          const selected = window.getSelection()?.toString() || "";
          const captured = clipText || selected || activeValue;
          if (captured) {
            win.__aistudio_last_copied_markdown = captured;
          }
        }, { capture: true });
      }
    });
  }

  private async readCapturedClipboard(page: Page): Promise<string | null> {
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      await page.waitForTimeout(100);
      const copied = await page.evaluate(async () => {
        const win = window as unknown as Record<string, unknown>;
        if (
          typeof win.__aistudio_last_copied_markdown === "string" &&
          win.__aistudio_last_copied_markdown.trim().length > 0
        ) {
          return win.__aistudio_last_copied_markdown.trim();
        }
        try {
          if (navigator.clipboard && typeof navigator.clipboard.readText === "function") {
            const sys = await navigator.clipboard.readText();
            if (sys && sys.trim().length > 0) return sys.trim();
          }
        } catch {}
        return null;
      }).catch(() => null);

      if (copied) return copied;
    }
    return null;
  }
}

