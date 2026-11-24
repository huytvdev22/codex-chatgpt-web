import type { Page } from "playwright-core";
import {
  normalizeCopiedChatGptSnippet,
  type ChatGptResponseBaseline,
} from "./chatgpt-dom-observer";
import { CHATGPT_SELECTORS } from "./selectors";

export { normalizeCopiedChatGptSnippet };

export function selectPreferredChatGptResponse(
  copiedMarkdown: string | null,
  domMarkdown: string,
): { rawResponse: string; source: "clipboard" | "dom" } {
  const cleanCopied = copiedMarkdown
    ? normalizeCopiedChatGptSnippet(copiedMarkdown)
    : "";
  const cleanDom = normalizeCopiedChatGptSnippet(domMarkdown);
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
 * Trích xuất câu trả lời hoàn chỉnh qua clipboard hook nội bộ trang
 * bằng Playwright trusted click (đưa tab lên trước để tránh lỗi focus clipboard).
 */
export class ChatGptClipboardSalvage {
  public async setupHook(page: Page): Promise<void> {
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"])
      .catch(() => {});
    await page.evaluate(() => {
      const win = window as unknown as Record<string, unknown>;
      win.__chatgpt_last_copied_code = null;

      if (!win.__chatgpt_hook_installed) {
        win.__chatgpt_hook_installed = true;
        document.addEventListener(
          "copy",
          (event: ClipboardEvent) => {
            const text =
              event.clipboardData?.getData("text/plain") ||
              window.getSelection()?.toString();
            if (text && text.trim()) {
              win.__chatgpt_last_copied_code = text;
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
              win.__chatgpt_last_copied_code = text;
            }
            return await origWriteText(text);
          };
        }
      }
    });
  }

  public async extractCopiedResponse(
    page: Page,
    baseline: ChatGptResponseBaseline,
  ): Promise<string | null> {
    await page.bringToFront().catch(() => {});
    const targetToken = `codex-copy-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    try {
      const markInfo = await page.evaluate(
        ({ selectors, baselineIds, baselineCount, baselineLatestText, token }) => {
          const win = window as unknown as Record<string, unknown>;
          win.__chatgpt_last_copied_code = null;

          const knownIds = new Set(baselineIds);
          const messages = Array.from(
            document.querySelectorAll<HTMLElement>(selectors.assistantMessage),
          );
          const newMessages = messages.filter((message, index) => {
            const wrapper = message.closest<HTMLElement>(
              selectors.responseBodyWrapper,
            );
            const messageId =
              wrapper?.getAttribute("data-chatgpt-selection-message-id") ||
              wrapper?.getAttribute("data-response-body");
            return messageId
              ? !knownIds.has(messageId)
              : index >= baselineCount;
          });

          let latestMsg = newMessages[newMessages.length - 1];
          if (!latestMsg) {
            const latestExisting = messages[messages.length - 1];
            const latestText = (latestExisting?.textContent || "").trim();
            if (latestText && latestText !== baselineLatestText) {
              latestMsg = latestExisting;
            }
          }
          if (!latestMsg) {
            return { marked: false, singleCodeBlock: false };
          }

          const responseWrapper =
            latestMsg.closest<HTMLElement>(selectors.responseBodyWrapper) ||
            latestMsg.parentElement;
          const turnWrapper =
            latestMsg.closest<HTMLElement>(selectors.turnContainer) ||
            responseWrapper;
          if (!responseWrapper || !turnWrapper) {
            return { marked: false, singleCodeBlock: false };
          }

          responseWrapper.setAttribute("data-codex-response-target", token);
          turnWrapper.setAttribute("data-codex-turn-target", token);
          const codeBlocks = responseWrapper.querySelectorAll(
            selectors.codeBlock,
          );
          return {
            marked: true,
            singleCodeBlock: codeBlocks.length === 1,
          };
        },
        {
          selectors: CHATGPT_SELECTORS,
          baselineIds: baseline.assistantIds,
          baselineCount: baseline.assistantCount,
          baselineLatestText: baseline.initialLatestText,
          token: targetToken,
        },
      );

      if (!markInfo.marked) return null;

      const responseTarget = page.locator(
        `[data-codex-response-target="${targetToken}"]`,
      );
      const turnTarget = page.locator(
        `[data-codex-turn-target="${targetToken}"]`,
      );
      const codeCopyBtn = responseTarget
        .locator(CHATGPT_SELECTORS.copyCodeButton)
        .last();
      const assistantCopyBtn = turnTarget
        .locator(CHATGPT_SELECTORS.copyAssistantMessageButton)
        .last();

      let usedCodeCopy = false;
      let copyButton = undefined;
      if (
        markInfo.singleCodeBlock &&
        (await codeCopyBtn.isVisible().catch(() => false))
      ) {
        copyButton = codeCopyBtn;
        usedCodeCopy = true;
      } else if (await assistantCopyBtn.isVisible().catch(() => false)) {
        copyButton = assistantCopyBtn;
      } else if (await codeCopyBtn.isVisible().catch(() => false)) {
        copyButton = codeCopyBtn;
        usedCodeCopy = true;
      }

      if (!copyButton) return null;

      const clicked = await copyButton
        .scrollIntoViewIfNeeded()
        .then(() => copyButton.click({ timeout: 2_000 }))
        .then(() => true)
        .catch(() => false);
      if (!clicked) return null;

      const readDeadline = Date.now() + 2_200;
      while (Date.now() < readDeadline) {
        await page.waitForTimeout(100);
        const copied = await page
          .evaluate(async () => {
            const win = window as unknown as Record<string, unknown>;
            if (
              typeof win.__chatgpt_last_copied_code === "string" &&
              win.__chatgpt_last_copied_code.trim().length > 0
            ) {
              return win.__chatgpt_last_copied_code.trim();
            }
            try {
              if (navigator.clipboard?.readText) {
                const sysText = await navigator.clipboard.readText();
                if (sysText && sysText.trim().length > 0) {
                  return sysText.trim();
                }
              }
            } catch {}
            return null;
          })
          .catch(() => null);

        if (copied) {
          return usedCodeCopy ? normalizeCopiedChatGptSnippet(copied) : copied;
        }
      }
      return null;
    } finally {
      await page
        .evaluate((token) => {
          document
            .querySelector(`[data-codex-response-target="${token}"]`)
            ?.removeAttribute("data-codex-response-target");
          document
            .querySelector(`[data-codex-turn-target="${token}"]`)
            ?.removeAttribute("data-codex-turn-target");
        }, targetToken)
        .catch(() => {});
    }
  }
}
