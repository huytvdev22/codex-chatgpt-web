import type { Page } from "playwright-core";

const COPY_LOCATOR_TIMEOUT_MS = 1_500;
const EDITOR_MOUNT_TIMEOUT_MS = 2_500;
const CLIPBOARD_POLL_TIMEOUT_MS = 1_800;

/**
 * Cứu hộ toàn bộ mã nguồn/văn bản từ Scriptor Code Block của Microsoft 365 Copilot.
 *
 * Ưu tiên đọc trực tiếp trong bộ nhớ (React Fiber Props & Monaco Global Model) để tránh
 * thao tác UI/clipboard/focus trên cửa sổ ẩn Windows; chỉ fallback sang chuyển chế độ
 * Code View, nút Copy Code (có timeout cứng 1.5s) và `[data-line-index]` khi cần.
 */
export class M365ClipboardSalvage {
  private async tryExtractInMemory(
    page: Page,
  ): Promise<{ text: string; source: string } | null> {
    return await page
      .evaluate(() => {
        const findTargetMsg = (): HTMLElement => {
          const candidates = Array.from(
            document.querySelectorAll<HTMLElement>(
              ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']",
            ),
          ).filter((el) => {
            if (
              el.matches("[data-content='user-message']") ||
              el.querySelector("[data-content='user-message']")
            ) {
              return false;
            }
            const aria = (el.getAttribute("aria-label") || "").toLowerCase();
            return !aria.includes("you said") && !aria.includes("bạn đã nói");
          });
          const aiList = candidates.filter(
            (msg, idx, all) =>
              !all.some((other, oIdx) => oIdx !== idx && other.contains(msg)),
          );
          const freshList = aiList.filter(
            (m) => !m.hasAttribute("data-codex-turn-baseline"),
          );
          return (
            (freshList.length > 0
              ? freshList[freshList.length - 1]
              : aiList[aiList.length - 1]) || document.body
          );
        };

        const isRichCodePayload = (val: unknown): val is string =>
          typeof val === "string" &&
          val.length > 20 &&
          /<(?:web|m365)Response\b|<custom_tool_call|\*{3}\s*Begin Patch/i.test(
            val,
          );

        // 1. Tầng A: Đọc trực tiếp từ React Fiber Props của tin nhắn mới nhất
        try {
          const targetMsg = findTargetMsg();
          const nodes = [
            targetMsg,
            ...Array.from(targetMsg.querySelectorAll<HTMLElement>("*")),
          ];
          for (const el of nodes) {
            const fiberKey = Object.keys(el).find(
              (k) =>
                k.startsWith("__reactFiber$") ||
                k.startsWith("__reactInternalInstance$"),
            );
            if (!fiberKey) continue;
            let fiber = (el as unknown as Record<string, any>)[fiberKey];
            let depth = 0;
            while (fiber && depth < 20) {
              const p = fiber.memoizedProps;
              if (p) {
                for (const propName of [
                  "code",
                  "text",
                  "content",
                  "value",
                  "rawCode",
                  "fileContent",
                ]) {
                  if (isRichCodePayload(p[propName])) {
                    return {
                      text: p[propName].trim(),
                      source: `React Fiber Props (${propName})`,
                    };
                  }
                }
              }
              fiber = fiber.return;
              depth++;
            }
          }
        } catch {}

        // 2. Tầng B: Đọc từ Monaco Editor Global Model
        try {
          const win = window as unknown as {
            monaco?: { editor?: { getModels?: () => Array<{ getValue: () => string }> } };
          };
          const models = win.monaco?.editor?.getModels?.();
          if (Array.isArray(models)) {
            for (let i = models.length - 1; i >= 0; i--) {
              const val = models[i]?.getValue?.();
              if (isRichCodePayload(val)) {
                return {
                  text: val.trim(),
                  source: `Monaco Editor Model [${i}]`,
                };
              }
            }
          }
        } catch {}

        return null;
      })
      .catch(() => null);
  }

  /**
   * Thử trích xuất toàn bộ nội dung từ Code Block của tin nhắn AI mới nhất.
   */
  public async tryExtractCodeViaCopyButton(page: Page): Promise<string | null> {
    try {
      // Fast-path: Đọc ngay trong bộ nhớ trước khi đụng tới toggle/clipboard/focus
      const fastMemory = await this.tryExtractInMemory(page);
      if (fastMemory && fastMemory.text.length > 0) {
        console.log(
          `[m365-worker] [copy-salvage] Fast-path bộ nhớ [${fastMemory.source}] (${fastMemory.text.length} ký tự).`,
        );
        return fastMemory.text;
      }

      // Kiểm tra trạng thái Code Block của tin nhắn AI mới nhất
      const blockState = await page.evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']",
          ),
        ).filter((el) => {
          if (
            el.matches("[data-content='user-message']") ||
            el.querySelector("[data-content='user-message']")
          ) {
            return false;
          }
          const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
          return (
            !ariaLabel.includes("you said") &&
            !ariaLabel.includes("bạn đã nói")
          );
        });
        const aiList = candidates.filter(
          (msg, idx, all) =>
            !all.some((other, oIdx) => oIdx !== idx && other.contains(msg)),
        );
        const freshList = aiList.filter(
          (m) => !m.hasAttribute("data-codex-turn-baseline"),
        );
        const targetMsg =
          (freshList.length > 0
            ? freshList[freshList.length - 1]
            : aiList[aiList.length - 1]) || document.body;

        const codeBlocks = Array.from(
          targetMsg.querySelectorAll<HTMLElement>(
            ".scriptor-component-code-block, [class*='code-block' i], [data-testid='one-copilot-code-identity'], .djlfcDli",
          ),
        );
        const targetBlock =
          codeBlocks.length > 0
            ? codeBlocks[codeBlocks.length - 1]
            : targetMsg;

        const codeCopyBtn = targetBlock.querySelector<HTMLButtonElement>(
          "button#copy-button, button[aria-label='Copy code']",
        );
        const previewToggleBtn = targetBlock.querySelector<HTMLButtonElement>(
          "button#preview-toggle-button, button[data-automation-id='codePreviewToggle'], button[aria-label='Code'], button[aria-label='Preview'], button[aria-label*='Code' i], button[aria-label*='Preview' i]",
        );
        const toggleAria = (
          previewToggleBtn?.getAttribute("aria-label") || ""
        ).toLowerCase();
        const isCurrentlyInCodeView =
          Boolean(codeCopyBtn) || toggleAria.includes("preview");

        return {
          hasCodeCopyBtn: Boolean(codeCopyBtn),
          hasPreviewToggle: Boolean(previewToggleBtn),
          isCurrentlyInCodeView,
        };
      });

      // Chuyển sang Code View nếu đang ở Preview để mount Monaco Model & nút Copy Code
      if (!(blockState.isCurrentlyInCodeView && blockState.hasCodeCopyBtn)) {
        const domToggleClicked = await page.evaluate(() => {
          const candidates = Array.from(
            document.querySelectorAll<HTMLElement>(
              ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']",
            ),
          ).filter((el) => {
            if (
              el.matches("[data-content='user-message']") ||
              el.querySelector("[data-content='user-message']")
            ) {
              return false;
            }
            const aria = (el.getAttribute("aria-label") || "").toLowerCase();
            return !aria.includes("you said") && !aria.includes("bạn đã nói");
          });
          const aiList = candidates.filter(
            (msg, idx, all) =>
              !all.some((other, oIdx) => oIdx !== idx && other.contains(msg)),
          );
          const freshList = aiList.filter(
            (m) => !m.hasAttribute("data-codex-turn-baseline"),
          );
          const targetMsg =
            (freshList.length > 0
              ? freshList[freshList.length - 1]
              : aiList[aiList.length - 1]) || document.body;

          const toggleBtn =
            targetMsg.querySelector<HTMLButtonElement>(
              "button#preview-toggle-button, button[data-automation-id='codePreviewToggle'], button[aria-label='Code'], button[aria-label*='Code' i]",
            ) ||
            Array.from(
              document.querySelectorAll<HTMLButtonElement>(
                "button#preview-toggle-button, button[data-automation-id='codePreviewToggle'], button[aria-label='Code'], button[aria-label*='Code' i]",
              ),
            ).pop();

          if (toggleBtn) {
            toggleBtn.scrollIntoView({ block: "center", inline: "center" });
            toggleBtn.focus();
            toggleBtn.dispatchEvent(
              new PointerEvent("pointerdown", { bubbles: true, cancelable: true }),
            );
            toggleBtn.dispatchEvent(
              new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
            );
            toggleBtn.dispatchEvent(
              new PointerEvent("pointerup", { bubbles: true, cancelable: true }),
            );
            toggleBtn.dispatchEvent(
              new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
            );
            toggleBtn.click();
            return true;
          }
          return false;
        });

        if (!domToggleClicked && blockState.hasPreviewToggle) {
          const toggleLocator = page
            .locator(
              ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']",
            )
            .last()
            .locator(
              "button#preview-toggle-button, button[data-automation-id='codePreviewToggle'], button[aria-label='Code']",
            )
            .last();
          if ((await toggleLocator.count().catch(() => 0)) > 0) {
            await toggleLocator
              .click({ timeout: COPY_LOCATOR_TIMEOUT_MS, force: true })
              .catch(() => {});
          }
        }

        const waitStart = Date.now();
        while (Date.now() - waitStart < EDITOR_MOUNT_TIMEOUT_MS) {
          await page.waitForTimeout(100);
          const checkReady = await page
            .evaluate(() => {
              const candidates = Array.from(
                document.querySelectorAll<HTMLElement>(
                  ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']",
                ),
              ).filter((el) => {
                if (
                  el.matches("[data-content='user-message']") ||
                  el.querySelector("[data-content='user-message']")
                ) {
                  return false;
                }
                const aria = (el.getAttribute("aria-label") || "").toLowerCase();
                return (
                  !aria.includes("you said") && !aria.includes("bạn đã nói")
                );
              });
              const aiList = candidates.filter(
                (msg, idx, all) =>
                  !all.some((other, oIdx) => oIdx !== idx && other.contains(msg)),
              );
              const freshList = aiList.filter(
                (m) => !m.hasAttribute("data-codex-turn-baseline"),
              );
              const targetMsg =
                (freshList.length > 0
                  ? freshList[freshList.length - 1]
                  : aiList[aiList.length - 1]) || document.body;

              const copyBtn = targetMsg.querySelector<HTMLButtonElement>(
                "button#copy-button, button[aria-label='Copy code']",
              );
              const toggleBtn = targetMsg.querySelector<HTMLButtonElement>(
                "button#preview-toggle-button, button[data-automation-id='codePreviewToggle']",
              );
              const toggleLabel = (
                toggleBtn?.getAttribute("aria-label") || ""
              ).toLowerCase();
              return Boolean(copyBtn || toggleLabel.includes("preview"));
            })
            .catch(() => false);

          if (checkReady) {
            await page.waitForTimeout(250);
            break;
          }
        }

        const postToggleMemory = await this.tryExtractInMemory(page);
        if (postToggleMemory && postToggleMemory.text.length > 0) {
          console.log(
            `[m365-worker] [copy-salvage] Đọc bộ nhớ sau toggle [${postToggleMemory.source}] (${postToggleMemory.text.length} ký tự).`,
          );
          return postToggleMemory.text;
        }
      }

      // Fallback Tầng C: Cài Clipboard Hook và click Copy Code (không gọi page.bringToFront() trên cửa sổ ẩn)
      await page
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"])
        .catch(() => {});

      await page
        .evaluate(() => {
          try {
            window.focus();
            document.body?.focus();
          } catch {}
          const win = window as any;
          win.__m365_last_copied_code = null;
          if (!win.__m365_clipboard_hooked) {
            win.__m365_clipboard_hooked = true;
            const origWriteText = navigator.clipboard
              ? navigator.clipboard.writeText
              : null;
            if (navigator.clipboard) {
              navigator.clipboard.writeText = async (text: string) => {
                win.__m365_last_copied_code = text;
                try {
                  if (origWriteText) {
                    return await origWriteText.call(navigator.clipboard, text);
                  }
                } catch {
                  return Promise.resolve();
                }
              };
            }
            document.addEventListener(
              "copy",
              (e: ClipboardEvent) => {
                const text =
                  e.clipboardData?.getData("text/plain") ||
                  window.getSelection()?.toString();
                if (text) win.__m365_last_copied_code = text;
              },
              { capture: true },
            );
          }
        })
        .catch(() => {});

      const domCopyClicked = await page
        .evaluate(() => {
          const candidates = Array.from(
            document.querySelectorAll<HTMLElement>(
              ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']",
            ),
          ).filter((el) => {
            if (
              el.matches("[data-content='user-message']") ||
              el.querySelector("[data-content='user-message']")
            ) {
              return false;
            }
            const aria = (el.getAttribute("aria-label") || "").toLowerCase();
            return !aria.includes("you said") && !aria.includes("bạn đã nói");
          });
          const aiList = candidates.filter(
            (msg, idx, all) =>
              !all.some((other, oIdx) => oIdx !== idx && other.contains(msg)),
          );
          const freshList = aiList.filter(
            (m) => !m.hasAttribute("data-codex-turn-baseline"),
          );
          const targetMsg =
            (freshList.length > 0
              ? freshList[freshList.length - 1]
              : aiList[aiList.length - 1]) || document.body;

          const codeCopyBtn =
            targetMsg.querySelector<HTMLButtonElement>(
              "button#copy-button, button[aria-label='Copy code']",
            ) ||
            Array.from(
              document.querySelectorAll<HTMLButtonElement>(
                "button#copy-button, button[aria-label='Copy code']",
              ),
            ).pop();

          if (codeCopyBtn) {
            codeCopyBtn.scrollIntoView({ block: "center", inline: "center" });
            codeCopyBtn.focus();
            codeCopyBtn.dispatchEvent(
              new PointerEvent("pointerdown", { bubbles: true, cancelable: true }),
            );
            codeCopyBtn.dispatchEvent(
              new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
            );
            codeCopyBtn.dispatchEvent(
              new PointerEvent("pointerup", { bubbles: true, cancelable: true }),
            );
            codeCopyBtn.dispatchEvent(
              new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
            );
            codeCopyBtn.click();
            return true;
          }
          return false;
        })
        .catch(() => false);

      if (!domCopyClicked) {
        try {
          const lastCopyLocator = page
            .locator(
              ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']",
            )
            .last()
            .locator("button#copy-button, button[aria-label='Copy code']")
            .last();
          if ((await lastCopyLocator.count().catch(() => 0)) > 0) {
            await lastCopyLocator
              .scrollIntoViewIfNeeded({ timeout: COPY_LOCATOR_TIMEOUT_MS })
              .catch(() => {});
            await lastCopyLocator
              .click({
                delay: 30,
                force: true,
                timeout: COPY_LOCATOR_TIMEOUT_MS,
              })
              .catch(() => {});
          }
        } catch {}
      }

      const readStart = Date.now();
      while (Date.now() - readStart < CLIPBOARD_POLL_TIMEOUT_MS) {
        await page.waitForTimeout(100);
        const hookResult = await page
          .evaluate(async () => {
            const win = window as any;
            if (
              typeof win.__m365_last_copied_code === "string" &&
              win.__m365_last_copied_code.trim().length > 0
            ) {
              return {
                text: win.__m365_last_copied_code.trim(),
                source: "Window Hook (writeText)",
              };
            }
            try {
              if (
                navigator.clipboard &&
                typeof navigator.clipboard.readText === "function"
              ) {
                const sys = await navigator.clipboard.readText();
                if (sys && sys.trim().length > 0) {
                  return {
                    text: sys.trim(),
                    source: "System Clipboard (readText)",
                  };
                }
              }
            } catch {}
            return null;
          })
          .catch(() => null);

        if (hookResult && hookResult.text.length > 0) {
          console.log(
            `[m365-worker] [copy-salvage] Thu thập qua [${hookResult.source}] (${hookResult.text.length} ký tự).`,
          );
          return hookResult.text;
        }
      }

      // Fallback Tầng D: DOM Virtualized [data-line-index]
      const domLinesResult = await page
        .evaluate(() => {
          try {
            const candidates = Array.from(
              document.querySelectorAll<HTMLElement>(
                ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']",
              ),
            ).filter((el) => {
              if (
                el.matches("[data-content='user-message']") ||
                el.querySelector("[data-content='user-message']")
              ) {
                return false;
              }
              const aria = (el.getAttribute("aria-label") || "").toLowerCase();
              return !aria.includes("you said") && !aria.includes("bạn đã nói");
            });
            const aiList = candidates.filter(
              (msg, idx, all) =>
                !all.some((other, oIdx) => oIdx !== idx && other.contains(msg)),
            );
            const freshList = aiList.filter(
              (m) => !m.hasAttribute("data-codex-turn-baseline"),
            );
            const targetMsg =
              (freshList.length > 0
                ? freshList[freshList.length - 1]
                : aiList[aiList.length - 1]) || document.body;

            const lineEls = Array.from(
              targetMsg.querySelectorAll<HTMLElement>("[data-line-index]"),
            );
            if (lineEls.length > 10) {
              lineEls.sort((a, b) => {
                const idxA = parseInt(
                  a.getAttribute("data-line-index") || "0",
                  10,
                );
                const idxB = parseInt(
                  b.getAttribute("data-line-index") || "0",
                  10,
                );
                return idxA - idxB;
              });
              const joined = lineEls.map((el) => el.textContent || "").join("\n");
              if (joined.length > 100) return joined.trim();
            }
          } catch {}
          return null;
        })
        .catch(() => null);

      return domLinesResult || null;
    } catch (err: any) {
      console.warn(
        `[m365-worker] [copy-salvage] Ngoại lệ không mong muốn: ${err?.message || err}`,
      );
      return null;
    }
  }
}
