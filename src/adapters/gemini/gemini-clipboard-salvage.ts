import type { Page } from "playwright-core";
import { browserFocusMutex } from "../web/browser/browser-focus-mutex";
import {
  normalizeCopiedGeminiSnippet,
  type GeminiResponseBaseline,
} from "./gemini-dom-observer";
import { GEMINI_SELECTORS } from "./selectors";

export { normalizeCopiedGeminiSnippet };

export function selectPreferredGeminiResponse(
  copiedMarkdown: string | null,
  domMarkdown: string,
): { rawResponse: string; source: "clipboard" | "dom" } {
  const cleanCopied = copiedMarkdown
    ? normalizeCopiedGeminiSnippet(copiedMarkdown)
    : "";
  const cleanDom = normalizeCopiedGeminiSnippet(domMarkdown);
  if (!cleanCopied) {
    return { rawResponse: cleanDom, source: "dom" };
  }

  const domHasCompleteEnvelope =
    cleanDom.includes("<webResponse>") && cleanDom.includes("</webResponse>");
  const copiedHasCompleteEnvelope =
    cleanCopied.includes("<webResponse>") &&
    cleanCopied.includes("</webResponse>");

  if (domHasCompleteEnvelope && !copiedHasCompleteEnvelope) {
    return { rawResponse: cleanDom, source: "dom" };
  }

  return { rawResponse: cleanCopied, source: "clipboard" };
}

/**
 * Trích xuất câu trả lời hoàn chỉnh qua clipboard hook nội bộ trang trên Gemini Web
 * (`gem-copy-button` ở code block ngoài cùng hoặc `button[aria-label="Copy"]` ở footer).
 */
export class GeminiClipboardSalvage {
  public async setupHook(page: Page): Promise<void> {
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"])
      .catch(() => {});
    await page.evaluate(() => {
      const win = window as unknown as Record<string, unknown>;
      win.__gemini_last_copied_code = null;

      if (!win.__gemini_hook_installed) {
        win.__gemini_hook_installed = true;
        document.addEventListener(
          "copy",
          (event: ClipboardEvent) => {
            const text =
              event.clipboardData?.getData("text/plain") ||
              window.getSelection()?.toString();
            if (text && text.trim()) {
              win.__gemini_last_copied_code = text;
            }
          },
          { capture: true },
        );

        const origWriteText = navigator.clipboard?.writeText?.bind(
          navigator.clipboard,
        );
        if (navigator.clipboard && origWriteText) {
          navigator.clipboard.writeText = async (text: string) => {
            if (text && text.trim()) {
              win.__gemini_last_copied_code = text;
            }
            if (win.__codex_suppress_os_clipboard_write) return undefined;
            try {
              return await origWriteText(text);
            } catch {
              return undefined;
            }
          };
        }

        const origWrite = navigator.clipboard?.write?.bind(navigator.clipboard);
        if (navigator.clipboard && origWrite) {
          navigator.clipboard.write = async (items: ClipboardItems) => {
            try {
              for (const item of items) {
                if (item.types?.includes("text/plain")) {
                  const blob = await item.getType("text/plain");
                  const text = await blob.text();
                  if (text && text.trim()) {
                    win.__gemini_last_copied_code = text;
                    break;
                  }
                }
              }
            } catch {}
            if (win.__codex_suppress_os_clipboard_write) return undefined;
            try {
              return await origWrite(items);
            } catch {
              return undefined;
            }
          };
        }
      }
    });
  }

  public async extractCopiedResponse(
    page: Page,
    baseline: GeminiResponseBaseline,
  ): Promise<string | null> {
    const targetToken = `codex-gemini-copy-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    try {
      const markInfo = await page.evaluate(
        ({ selectors, baselineIds, baselineCount, baselineLatestText, token }) => {
          const win = window as unknown as Record<string, unknown>;
          win.__gemini_last_copied_code = null;
          win.__codex_suppress_os_clipboard_write = true;

          const knownIds = new Set(baselineIds);
          const responses = Array.from(
            document.querySelectorAll<HTMLElement>(selectors.assistantResponse),
          );
          const newResponses = responses.filter((resp, index) => {
            const panel = resp.querySelector<HTMLElement>(".markdown-main-panel");
            const respId = panel?.id;
            return respId ? !knownIds.has(respId) : index >= baselineCount;
          });

          let latestResp = newResponses[newResponses.length - 1];
          if (!latestResp && responses.length > 0) {
            const latestExisting = responses[responses.length - 1]!;
            const panel =
              latestExisting.querySelector<HTMLElement>(
                "message-content .markdown-main-panel",
              ) || latestExisting;
            const text = (panel.textContent || "").trim();
            if (text && text !== baselineLatestText) {
              latestResp = latestExisting;
            }
          }
          if (!latestResp) {
            return { marked: false, singleCodeBlock: false };
          }

          latestResp.setAttribute("data-codex-gemini-target", token);
          const panel =
            latestResp.querySelector<HTMLElement>(
              "message-content .markdown-main-panel",
            ) || latestResp;
          const codeBlocks = panel.querySelectorAll(selectors.codeBlock);
          return {
            marked: true,
            singleCodeBlock: codeBlocks.length === 1,
          };
        },
        {
          selectors: GEMINI_SELECTORS,
          baselineIds: baseline.responseIds,
          baselineCount: baseline.responseCount,
          baselineLatestText: baseline.initialLatestText,
          token: targetToken,
        },
      );

      if (!markInfo.marked) return null;

      const targetResp = page.locator(
        `[data-codex-gemini-target="${targetToken}"]`,
      );
      const codeCopyBtn = targetResp
        .locator(GEMINI_SELECTORS.copyCodeButton)
        .last();
      const footerCopyBtn = targetResp
        .locator(GEMINI_SELECTORS.copyAssistantResponseButton)
        .last();

      let usedCodeCopy = false;
      let copyButton = undefined;
      if (
        markInfo.singleCodeBlock &&
        (await codeCopyBtn.isVisible().catch(() => false))
      ) {
        copyButton = codeCopyBtn;
        usedCodeCopy = true;
      } else if (await footerCopyBtn.isVisible().catch(() => false)) {
        copyButton = footerCopyBtn;
      } else if (await codeCopyBtn.isVisible().catch(() => false)) {
        copyButton = codeCopyBtn;
        usedCodeCopy = true;
      }

      if (!copyButton) return null;

      const clicked = await browserFocusMutex
        .runExclusive(
          async () => {
            await page.bringToFront().catch(() => {});
            await copyButton.scrollIntoViewIfNeeded();
            await copyButton.click({ timeout: 2_000 });
            return true;
          },
          { timeoutMs: 3_000 },
        )
        .catch(() => false);
      if (!clicked) return null;

      // Chỉ đọc từ in-page clipboard hook của chính tab này; không fallback `navigator.clipboard.readText()`.
      const readDeadline = Date.now() + 2_200;
      while (Date.now() < readDeadline) {
        await page.waitForTimeout(100);
        const copied = await page
          .evaluate(() => {
            const win = window as unknown as Record<string, unknown>;
            if (
              typeof win.__gemini_last_copied_code === "string" &&
              win.__gemini_last_copied_code.trim().length > 0
            ) {
              return win.__gemini_last_copied_code.trim();
            }
            return null;
          })
          .catch(() => null);

        if (copied) {
          return usedCodeCopy ? normalizeCopiedGeminiSnippet(copied) : copied;
        }
      }
      return null;
    } finally {
      await page
        .evaluate((token) => {
          const win = window as unknown as Record<string, unknown>;
          win.__codex_suppress_os_clipboard_write = false;
          document
            .querySelector(`[data-codex-gemini-target="${token}"]`)
            ?.removeAttribute("data-codex-gemini-target");
        }, targetToken)
        .catch(() => {});
    }
  }
}
