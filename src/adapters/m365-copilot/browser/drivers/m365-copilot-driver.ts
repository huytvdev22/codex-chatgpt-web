import type { Page } from "playwright-core";
import { logFunctionInput } from "../../debug-logger";
import { ensureM365CapabilityMode } from "../capability-picker";
import { resolveM365CapabilityMode } from "../../../../m365-models";
import type {
  BaselineState,
  DriverTurnOptions,
  PageDriver,
  ScrapeProgressResult,
} from "../contracts/page-driver";

export const CHAT_SELECTORS = {
  editor: "#m365-chat-editor-target-element",
  inputWrapper: ".fai-BebopLiteChatInput__inputWrapper",
  actions: ".fai-BebopLiteChatInput__actions",
  sendButton:
    'button[type="submit"][aria-label="Send"]:not([aria-label*="Stop"]):not(:has(.fai-SendButton__stopIcon)), button[aria-label="Send"]:not([aria-label*="Stop"]):not(:has(.fai-SendButton__stopIcon)), .fai-BebopLiteChatInput__actions button[type="submit"]:has(.fai-SendButton__sendIcon):not(:has(.fai-SendButton__stopIcon))',
  stopButton:
    'button[type="submit"][aria-label="Stop generating"], button[aria-label="Stop generating"], button[aria-label*="Stop generating" i], button[aria-label*="Dừng tạo" i], .fai-SendButton__stopIcon, [data-testid="stop-button"]',
  dictationButton: 'button[aria-label="Start dictation"]',
};

/**
 * Driver cho giao diện Microsoft 365 Copilot Web (m365.cloud.microsoft/chat).
 * Quản lý toàn bộ DOM, ProseMirror editor, selector và scraper đặc thù của M365 Copilot.
 */
export class M365CopilotDriver implements PageDriver {
  readonly id = "m365-copilot";
  readonly name = "Microsoft 365 Copilot";
  readonly selectors = CHAT_SELECTORS;

  private readonly conversationThreads = new Map<string, string>();
  private currentActiveKey: string | null = null;

  recordConversationThread(conversationKey: string, threadUrl: string): void {
    if (conversationKey && threadUrl && threadUrl.startsWith("http") && !threadUrl.endsWith("/chat")) {
      this.conversationThreads.set(conversationKey, threadUrl);
      console.log(`[m365-driver] Đã ghi nhớ URL thread cho cửa sổ [${conversationKey}]: ${threadUrl}`);
    }
  }

  getSavedThreadUrl(conversationKey: string): string | undefined {
    return this.conversationThreads.get(conversationKey);
  }

  async ensureReady(page: Page, _options: DriverTurnOptions): Promise<void> {
    logFunctionInput("browser:drivers:m365-copilot", "ensureReady");
    const currentUrl = page.url();
    if (!currentUrl.includes("m365.cloud.microsoft")) {
      await page.goto("https://m365.cloud.microsoft/chat", {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
    }
  }

  async prepareNewChat(page: Page, options: DriverTurnOptions): Promise<void> {
    logFunctionInput("browser:drivers:m365-copilot", "prepareNewChat", { options });
    const isTemporaryMode = Boolean(options.forceTemporaryChat);
    const conversationKey = options.conversationKey;
    const savedThreadUrl = conversationKey ? this.conversationThreads.get(conversationKey) : undefined;

    // Nếu cuộc hội thoại này đã có thread URL đã lưu và đang không ở đúng thread đó:
    if (!isTemporaryMode && !options.isNewConversation && savedThreadUrl) {
      const currentUrl = page.url();
      if (!currentUrl.includes(savedThreadUrl)) {
        console.log(`[m365-driver] Khôi phục chính xác phiên của cửa sổ [${conversationKey}] tại: ${savedThreadUrl}`);
        await page.goto(savedThreadUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 400));
        this.currentActiveKey = conversationKey || null;
      }
      return;
    }

    const shouldStartNewChat =
      isTemporaryMode ||
      options.isNewConversation ||
      (conversationKey && !savedThreadUrl);

    console.log(
      `[m365-driver] Trạng thái phiên: isTemporaryMode=${isTemporaryMode}, shouldStartNewChat=${shouldStartNewChat}`
    );

    if (shouldStartNewChat) {
      if (page.url().includes("/chat/c/")) {
        console.log(`[m365-driver] Điều hướng về /chat từ thread cũ: ${page.url()}`);
        await page
          .goto("https://m365.cloud.microsoft/chat", {
            waitUntil: "domcontentloaded",
            timeout: 15_000,
          })
          .catch(() => {});
        await new Promise((r) => setTimeout(r, 400));
      }

      await page
        .evaluate(() => {
          const newChatBtn = document.querySelector(
            'a[aria-label*="New chat" i], button[aria-label*="New chat" i], [aria-label*="New chat" i], [aria-label*="Cuộc trò chuyện mới" i], [aria-label*="New topic" i], [title*="New chat" i]'
          ) as HTMLElement | null;
          if (newChatBtn) {
            newChatBtn.click();
            newChatBtn.dispatchEvent(
              new MouseEvent("click", { bubbles: true, cancelable: true })
            );
            return;
          }

          const tempBtn = document.querySelector(
            'button[aria-label*="Temporary chat" i], button[aria-label*="Cuộc trò chuyện tạm thời" i]'
          ) as HTMLButtonElement | null;
          if (tempBtn) {
            tempBtn.click();
            setTimeout(() => {
              if (tempBtn.getAttribute("aria-pressed") !== "true") {
                tempBtn.click();
              }
            }, 200);
          }
        })
        .catch(() => {});

      await new Promise((r) => setTimeout(r, 400));

      if (isTemporaryMode) {
        await page
          .evaluate(() => {
            const tempBtn = document.querySelector(
              'button[aria-label*="Temporary chat" i], button[aria-label*="Cuộc trò chuyện tạm thời" i]'
            ) as HTMLButtonElement | null;
            if (tempBtn && tempBtn.getAttribute("aria-pressed") !== "true") {
              tempBtn.click();
              tempBtn.dispatchEvent(
                new MouseEvent("click", { bubbles: true, cancelable: true })
              );
            }
          })
          .catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
      }

      this.currentActiveKey = options.conversationKey || null;
    } else if (options.conversationKey) {
      this.currentActiveKey = options.conversationKey;
    }

    // Đảm bảo editor đã xuất hiện
    const editorSelector =
      "#m365-chat-editor-target-element, div[contenteditable='true'], [role='textbox']";
    await page.waitForSelector(editorSelector, { timeout: 15_000 });

    if (isTemporaryMode) {
      await page
        .evaluate(() => {
          const tempBtn = document.querySelector(
            'button[aria-label="Temporary chat"]'
          ) as HTMLButtonElement | null;
          if (tempBtn && tempBtn.getAttribute("aria-pressed") !== "true") {
            tempBtn.click();
          }
        })
        .catch(() => {});
    }
  }

  async ensureModelMode(page: Page, modelSlug?: string): Promise<void> {
    logFunctionInput("browser:drivers:m365-copilot", "ensureModelMode", { modelSlug });
    if (modelSlug) {
      const targetMode = resolveM365CapabilityMode(modelSlug);
      await ensureM365CapabilityMode(page, targetMode).catch((err) => {
        console.warn(
          `[m365-driver] Warning: Failed to ensure capability mode '${targetMode}':`,
          err
        );
      });
    }
  }

  async waitForIdle(page: Page, _signal?: AbortSignal): Promise<void> {
    logFunctionInput("browser:drivers:m365-copilot", "waitForIdle");
    await page
      .evaluate(async () => {
        const isIdle = () => {
          const stopBtn = document.querySelector(
            'button[aria-label="Stop generating"], button[aria-label*="Stop" i], button[aria-label*="Dừng" i], .fai-SendButton__stopIcon, [data-testid="stop-button"]'
          );
          const editor = document.querySelector(
            '#m365-chat-editor-target-element, div[contenteditable="true"], [role="textbox"]'
          );
          const isEditorDisabled = editor?.getAttribute("aria-disabled") === "true";
          return !stopBtn && !isEditorDisabled;
        };

        if (isIdle()) return;

        const start = Date.now();
        while (Date.now() - start < 12_000) {
          await new Promise((r) => setTimeout(r, 250));
          if (isIdle()) return;
        }

        const stopBtn = document.querySelector(
          'button[aria-label="Stop generating"], button[aria-label*="Stop" i], button[aria-label*="Dừng" i], .fai-SendButton__stopIcon, [data-testid="stop-button"]'
        ) as HTMLButtonElement | null;
        if (stopBtn) {
          stopBtn.click();
          const stopClickAt = Date.now();
          while (Date.now() - stopClickAt < 3000) {
            await new Promise((r) => setTimeout(r, 200));
            if (isIdle()) break;
          }
          await new Promise((r) => setTimeout(r, 800));
        }
      })
      .catch(() => {});
  }

  async captureBaseline(page: Page): Promise<BaselineState> {
    logFunctionInput("browser:drivers:m365-copilot", "captureBaseline");
    return page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']"
        )
      );
      const aiList: HTMLElement[] = [];
      for (const el of candidates) {
        if (
          el.matches("[data-content='user-message']") ||
          el.querySelector("[data-content='user-message']")
        ) {
          continue;
        }
        const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
        if (ariaLabel.includes("you said") || ariaLabel.includes("bạn đã nói")) {
          continue;
        }
        const isExplicitAi = el.matches(".fai-CopilotMessage, [data-content='ai-message']");
        const hasAiMarkers = Boolean(
          el.querySelector(
            ".fai-CopilotMessage, [data-content='ai-message'], [data-testid='markdown-reply'], .fai-CopilotMessage__content, .fai-Shimmer, [role='progressbar']"
          )
        );
        const heading = el.querySelector(
          ".fai-CopilotMessage__accessibleHeading, [class*='heading' i], h2, h3, h4"
        );
        const headingText = (heading?.textContent || "").toLowerCase();
        const isCopilotHeading = headingText.includes("copilot");

        if (isExplicitAi || hasAiMarkers || isCopilotHeading) {
          aiList.push(el);
        }
      }
      const aiMessages = aiList.filter(
        (msg, idx, all) => !all.some((other, oIdx) => oIdx !== idx && other.contains(msg))
      );

      aiMessages.forEach((msg) => {
        msg.setAttribute("data-codex-turn-baseline", "true");
      });

      const lastEl =
        aiMessages.length > 0 ? (aiMessages[aiMessages.length - 1] as HTMLElement) : null;
      return {
        aiCount: aiMessages.length,
        count: aiMessages.length,
        lastText: lastEl ? lastEl.textContent?.trim() || "" : "",
        lastHtml: lastEl ? lastEl.innerHTML || "" : "",
      };
    });
  }

  async submitPrompt(page: Page, promptText: string): Promise<boolean> {
    logFunctionInput("browser:drivers:m365-copilot", "submitPrompt", { promptTextLength: promptText.length });
    await page.evaluate((text: string) => {
      const editor = (document.getElementById("m365-chat-editor-target-element") ||
        document.querySelector("div[contenteditable='true']") ||
        document.querySelector("[role='textbox']")) as HTMLElement;
      if (!editor) throw new Error("Không tìm thấy ô nhập liệu của M365 Copilot!");

      delete (window as any).__m365_code_lines_cache;
      delete (window as any).__m365_code_lines_cache_by_block;
      editor.focus();

      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.execCommand("delete", false, undefined);

      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      editor.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        })
      );
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
    }, promptText);

    await new Promise((r) => setTimeout(r, 300));

    // Guaranteed Submission Loop
    let promptSubmitted = false;
    for (let submitAttempt = 0; submitAttempt < 10; submitAttempt++) {
      promptSubmitted = await page.evaluate(() => {
        const stopBtn = document.querySelector(
          'button[aria-label="Stop generating"], .fai-SendButton__stopIcon, [data-testid="stop-button"]'
        );
        const sendBtn = document.querySelector(
          'button[type="submit"][aria-label="Send"]:not([aria-label*="Stop"]):not(:has(.fai-SendButton__stopIcon)), button[aria-label="Send"]:not([aria-label*="Stop"]):not(:has(.fai-SendButton__stopIcon)), .fai-BebopLiteChatInput__actions button[type="submit"]:has(.fai-SendButton__sendIcon):not(:has(.fai-SendButton__stopIcon))'
        );
        const editor = document.querySelector(
          '#m365-chat-editor-target-element, div[contenteditable="true"], [role="textbox"]'
        );
        const editorText = editor?.textContent?.trim() || "";
        return Boolean(stopBtn) || (!sendBtn && editorText.length === 0);
      });

      if (promptSubmitted) {
        console.log(
          `[m365-driver] [send] Đã xác nhận prompt được gửi thành công ở lần thử ${submitAttempt + 1}`
        );
        break;
      }

      try {
        const sendLocator = page
          .locator(
            'button[type="submit"][aria-label="Send"]:not([aria-label*="Stop"]):not(:has(.fai-SendButton__stopIcon)), button[aria-label="Send"]:not([aria-label*="Stop"]):not(:has(.fai-SendButton__stopIcon)), .fai-BebopLiteChatInput__actions button[type="submit"]:has(.fai-SendButton__sendIcon):not(:has(.fai-SendButton__stopIcon))'
          )
          .first();
        if ((await sendLocator.count()) > 0 && (await sendLocator.isVisible())) {
          await sendLocator.click({ force: true, timeout: 500 });
          await new Promise((r) => setTimeout(r, 200));
          const isNowGenerating = await page.evaluate(() => {
            return Boolean(
              document.querySelector(
                'button[aria-label="Stop generating"], .fai-SendButton__stopIcon'
              )
            );
          });
          if (isNowGenerating) {
            console.log(
              `[m365-driver] [send] Playwright pointer click thành công ở lần thử ${submitAttempt + 1}`
            );
            promptSubmitted = true;
            break;
          }
        }
      } catch {}

      const domSendSuccess = await page
        .evaluate(() => {
          const sendBtn = document.querySelector(
            'button[type="submit"][aria-label="Send"]:not([aria-label*="Stop"]):not(:has(.fai-SendButton__stopIcon)), button[aria-label="Send"]:not([aria-label*="Stop"]):not(:has(.fai-SendButton__stopIcon)), .fai-BebopLiteChatInput__actions button[type="submit"]:has(.fai-SendButton__sendIcon):not(:has(.fai-SendButton__stopIcon))'
          ) as HTMLButtonElement | null;
          if (sendBtn && !sendBtn.disabled) {
            sendBtn.dispatchEvent(
              new PointerEvent("pointerdown", { bubbles: true, cancelable: true })
            );
            sendBtn.dispatchEvent(
              new MouseEvent("mousedown", { bubbles: true, cancelable: true })
            );
            sendBtn.dispatchEvent(
              new PointerEvent("pointerup", { bubbles: true, cancelable: true })
            );
            sendBtn.dispatchEvent(
              new MouseEvent("mouseup", { bubbles: true, cancelable: true })
            );
            sendBtn.click();
            const form = sendBtn.closest("form");
            if (form && typeof (form as any).requestSubmit === "function") {
              (form as any).requestSubmit(sendBtn);
            }
            return true;
          }
          return false;
        })
        .catch(() => false);

      if (domSendSuccess) {
        await new Promise((r) => setTimeout(r, 200));
        const isNowGenerating = await page.evaluate(() => {
          return Boolean(
            document.querySelector(
              'button[aria-label="Stop generating"], .fai-SendButton__stopIcon'
            )
          );
        });
        if (isNowGenerating) {
          console.log(
            `[m365-driver] [send] DOM send dispatch thành công ở lần thử ${submitAttempt + 1}`
          );
          promptSubmitted = true;
          break;
        }
      }

      const shouldPressEnter = await page.evaluate(() => {
        const isStopPresent = Boolean(
          document.querySelector(
            'button[aria-label="Stop generating"], .fai-SendButton__stopIcon'
          )
        );
        return !isStopPresent;
      });
      if (shouldPressEnter) {
        await page
          .evaluate(() => {
            const editor = document.querySelector(
              '#m365-chat-editor-target-element, div[contenteditable="true"], [role="textbox"]'
            ) as HTMLElement;
            if (editor) editor.focus();
          })
          .catch(() => {});
        await page.keyboard.press("Control+Enter");
        await page.keyboard.press("Enter");
      }

      await new Promise((r) => setTimeout(r, 300));
    }

    return promptSubmitted;
  }

  async scrapeTurnProgress(page: Page, baseline: BaselineState): Promise<ScrapeProgressResult> {
    return page.evaluate((before: BaselineState) => {
      const stopBtn = document.querySelector(
        'button[aria-label="Stop generating"], .fai-SendButton__stopIcon, [data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="Dừng" i]'
      );
      const editor = document.querySelector(
        '#m365-chat-editor-target-element, div[contenteditable="true"], [role="textbox"]'
      );
      const editorDisabled = editor?.getAttribute("aria-disabled") === "true";

      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']"
        )
      );
      const aiList: HTMLElement[] = [];
      for (const el of candidates) {
        if (
          el.matches("[data-content='user-message']") ||
          el.querySelector("[data-content='user-message']")
        ) {
          continue;
        }
        const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
        if (ariaLabel.includes("you said") || ariaLabel.includes("bạn đã nói")) {
          continue;
        }
        const isExplicitAi = el.matches(".fai-CopilotMessage, [data-content='ai-message']");
        const hasAiMarkers = Boolean(
          el.querySelector(
            ".fai-CopilotMessage, [data-content='ai-message'], [data-testid='markdown-reply'], .fai-CopilotMessage__content, .fai-Shimmer, [role='progressbar']"
          )
        );
        const heading = el.querySelector(
          ".fai-CopilotMessage__accessibleHeading, [class*='heading' i], h2, h3, h4"
        );
        const headingText = (heading?.textContent || "").toLowerCase();
        const isCopilotHeading = headingText.includes("copilot");

        if (isExplicitAi || hasAiMarkers || isCopilotHeading) {
          aiList.push(el);
        }
      }
      const aiMessages = aiList.filter(
        (msg, idx, all) => !all.some((other, oIdx) => oIdx !== idx && other.contains(msg))
      );

      let detectedWebError = "";
      const errorEl = document.querySelector(
        '[data-testid="error-message"], .fai-ErrorMessage, [role="alert"], [class*="errorMessage" i], [class*="error-banner" i]'
      );
      if (errorEl && errorEl.textContent?.trim()) {
        const errText = errorEl.textContent.trim();
        if (
          /something went wrong|try again|reached the limit|limit exceeded|đã xảy ra lỗi|vượt quá giới hạn/i.test(
            errText
          )
        ) {
          detectedWebError = errText;
        }
      }

      const baselineCount = typeof before.aiCount === "number" ? before.aiCount : before.count;

      if (aiMessages.length === 0) {
        return {
          isGenerating: Boolean(stopBtn),
          blocks: [],
          rawHtml: "",
          isNew: false,
          hasContent: false,
          detectedWebError,
          fastPathRawText: null,
        };
      }

      const lastMsg = aiMessages[aiMessages.length - 1] as HTMLElement;
      const currentLastText = lastMsg ? lastMsg.textContent?.trim() || "" : "";
      const currentLastHtml = lastMsg ? lastMsg.innerHTML || "" : "";
      const isGenerating = Boolean(stopBtn);

      const isCancellationMessage =
        /(?:I've stopped generating|stopped generating the response|đã dừng tạo phản hồi|dừng tạo câu trả lời)/i.test(
          currentLastText
        );
      const isMarkedBaseline = Boolean(
        lastMsg &&
          (lastMsg.hasAttribute("data-codex-turn-baseline") ||
            lastMsg.closest("[data-codex-turn-baseline]"))
      );
      const isContentUnchanged = Boolean(
        (!before.lastText || currentLastText === before.lastText) &&
          (!before.lastHtml || currentLastHtml === before.lastHtml)
      );
      const isLastMsgOld =
        (baselineCount > 0 && isMarkedBaseline && isContentUnchanged) ||
        isCancellationMessage;

      if (isLastMsgOld) {
        const isEditorBusy = isGenerating || editorDisabled;
        return {
          isGenerating: isEditorBusy,
          blocks: [],
          rawHtml: "",
          isNew: false,
          hasContent: false,
          detectedWebError,
          fastPathRawText: null,
        };
      }

      const markdownReplies = Array.from(
        lastMsg.querySelectorAll('[data-testid="markdown-reply"]')
      ) as HTMLElement[];
      const replyEl =
        markdownReplies.find(
          (el) => el.getAttribute("data-message-type") === "Chat" && el.textContent?.trim()
        ) ||
        markdownReplies.reverse().find((el) => el.textContent?.trim()) ||
        null;
      const contentEl =
        replyEl ||
        ((lastMsg.querySelector(
          ".fai-CopilotMessage__content, [data-content='content'], .fui-ChatMessage__body, .fai-ChatMessage__content"
        ) || lastMsg) as HTMLElement);

      const codeBlockQuery =
        "div[role='group'][aria-label='Code Preview'], .scriptor-component-code-block, [class*='scriptor-component-code-block']";
      const searchRoots = [lastMsg, contentEl].filter(Boolean) as HTMLElement[];
      const allLiveCodeElements: HTMLElement[] = [];
      searchRoots.forEach((root) => {
        root
          .querySelectorAll(codeBlockQuery)
          .forEach((el) => allLiveCodeElements.push(el as HTMLElement));
      });
      const liveCodeBlocks = allLiveCodeElements.filter(
        (el, idx, all) => all.indexOf(el) === idx && !all.some((other) => other !== el && other.contains(el))
      );

      let monacoModelsText: string[] = [];
      try {
        const win = window as any;
        const models = win.monaco?.editor?.getModels?.();
        if (Array.isArray(models) && models.length > 0) {
          monacoModelsText = models
            .map((m: any) => (typeof m.getValue === "function" ? m.getValue() : ""))
            .filter(Boolean);
        }
      } catch {}

      const win = window as any;
      if (!win.__m365_code_lines_cache_by_block) {
        win.__m365_code_lines_cache_by_block = new Map<number, Map<number, string>>();
      }

      const codeData = liveCodeBlocks.map((block, blockIdx) => {
        const langEl = block.querySelector(
          "[data-testid='one-copilot-code-identity'] span, [class*='code-identity' i] span"
        );
        let lang = langEl?.textContent?.trim().toLowerCase() || "";
        if (lang === "plain text" || lang === "text") lang = "plain";

        let blockCache = win.__m365_code_lines_cache_by_block.get(blockIdx);
        if (!blockCache) {
          blockCache = new Map<number, string>();
          win.__m365_code_lines_cache_by_block.set(blockIdx, blockCache);
        }

        const lineEls = Array.from(block.querySelectorAll("[data-line-index]"));
        let codeText = "";
        if (lineEls.length > 0) {
          lineEls.forEach((el) => {
            const idxAttr = el.getAttribute("data-line-index");
            if (idxAttr !== null) {
              const idx = parseInt(idxAttr, 10);
              if (!isNaN(idx)) {
                blockCache.set(idx, (el.textContent || "").replace(/\u00a0/g, " "));
              }
            }
          });

          const keys = (Array.from(blockCache.keys()) as number[]).sort((a, b) => a - b);
          if (keys.length > 0) {
            const minIdx = keys[0];
            const maxIdx = keys[keys.length - 1];
            const assembled: string[] = [];
            for (let i = minIdx; i <= maxIdx; i++) {
              assembled.push(blockCache.get(i) ?? "");
            }
            codeText = assembled.join("\n");
          } else {
            codeText = lineEls
              .map((el) => (el.textContent || "").replace(/\u00a0/g, " "))
              .join("\n");
          }
        } else {
          const findRoot =
            block.querySelector(
              "[data-virtualized-code-find-root='true'], [role='textbox'][aria-label*='Code editor' i]"
            ) || block.lastElementChild;
          codeText = (
            findRoot
              ? (findRoot as HTMLElement).innerText
              : (block as HTMLElement).innerText || ""
          ).replace(/\u00a0/g, " ");
        }

        if (monacoModelsText[blockIdx] && monacoModelsText[blockIdx].length >= codeText.length) {
          codeText = monacoModelsText[blockIdx];
        }

        codeText = codeText.replace(/^\n+|\n+$/g, "");
        return { lang, codeText };
      });

      let fastPathRawText: string | null = null;
      if (codeData.length === 1) {
        fastPathRawText = codeData[0].codeText;
      } else if (codeData.length > 1) {
        const mdBlock = codeData.find(
          (b) => b.lang === "markdown" || b.lang === "md" || b.lang === "plain" || !b.lang
        );
        fastPathRawText = mdBlock
          ? mdBlock.codeText
          : codeData.reduce((prev, curr) => (curr.codeText.length > prev.codeText.length ? curr : prev)).codeText;
      }

      const clone = contentEl.cloneNode(true) as HTMLElement;

      const allClonedCodeElements = Array.from(
        clone.querySelectorAll(codeBlockQuery)
      ) as HTMLElement[];
      const clonedCodeBlocks = allClonedCodeElements.filter(
        (el, _, all) => !all.some((other) => other !== el && other.contains(el))
      );

      clonedCodeBlocks.forEach((block, idx) => {
        const data = codeData[idx];
        if (!data) return;

        const pre = document.createElement("pre");
        const code = document.createElement("code");
        if (data.lang) {
          code.className = `language-${data.lang}`;
        }
        code.textContent = data.codeText;
        pre.appendChild(code);
        block.replaceWith(pre);
      });

      clone.querySelectorAll("pre").forEach((pre) => {
        if (!pre.querySelector("code")) {
          const code = document.createElement("code");
          code.textContent = pre.textContent || "";
          pre.textContent = "";
          pre.appendChild(code);
        }
      });

      clone
        .querySelectorAll(
          "[role='status'], [role='progressbar'], .fai-Shimmer, [class*='shimmer' i], .fai-StatusMessage, .fai-BebopMessageStatus, [role='toolbar'], .fai-CopilotMessage__actions, .fai-CopilotMessage__accessibleHeading, button, svg"
        )
        .forEach((el) => el.remove());

      if (!replyEl) {
        const statusPhrases = [
          "checking that now", "taking a look", "getting things ready", "digging in",
          "working on it", "searching the web", "searching work data", "searching",
          "thinking", "generating response", "putting it together", "putting things together",
          "gathering thoughts", "looking through your files",
          "đang xem xét", "đang kiểm tra", "đang chuẩn bị", "đang tìm kiếm",
          "đang đào sâu", "đang xử lý", "đang suy nghĩ", "đang tạo câu trả lời", "đang tổng hợp"
        ];
        clone.querySelectorAll("div, span, p").forEach((el) => {
          const text = el.textContent?.trim().toLowerCase() || "";
          for (const phrase of statusPhrases) {
            if (text.startsWith(phrase) && text.length < phrase.length + 35) {
              el.remove();
              break;
            }
          }
        });
      }

      const blockTags = new Set([
        "p", "h1", "h2", "h3", "h4", "h5", "h6",
        "pre", "code", "ul", "ol", "hr", "blockquote", "table"
      ]);
      const rawBlocks: Array<{ tag: string; html: string; text: string }> = [];
      const inlineNodes: Node[] = [];

      function flushInline() {
        if (inlineNodes.length === 0) return;
        const temp = document.createElement("p");
        for (const n of inlineNodes) {
          temp.appendChild(n.cloneNode(true));
        }
        inlineNodes.length = 0;
        const text = temp.textContent?.trim() || "";
        if (text.length > 0) {
          rawBlocks.push({
            tag: "p",
            html: temp.outerHTML,
            text,
          });
        }
      }

      function processNode(node: Node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          const tag = el.tagName.toLowerCase();
          if (blockTags.has(tag)) {
            flushInline();
            const text = el.textContent?.trim() || "";
            if (text.length > 0 || tag === "hr") {
              const html = tag === "code" ? `<pre>${el.outerHTML}</pre>` : el.outerHTML;
              rawBlocks.push({
                tag: tag === "code" ? "pre" : tag,
                html,
                text,
              });
            }
            return;
          }
          const hasNestedBlocks = Boolean(el.querySelector(Array.from(blockTags).join(",")));
          if (hasNestedBlocks) {
            flushInline();
            Array.from(el.childNodes).forEach((child) => processNode(child));
            flushInline();
            return;
          }
        }
        inlineNodes.push(node);
      }

      Array.from(clone.childNodes).forEach((child) => processNode(child));
      flushInline();

      const allStatusPhrases = [
        "checking that now", "taking a look", "getting things ready", "digging in",
        "working on it", "searching the web", "searching work data", "searching",
        "thinking", "generating response", "putting it together", "putting things together",
        "gathering thoughts", "looking through your files",
        "đang xem xét", "đang kiểm tra", "đang chuẩn bị", "đang tìm kiếm",
        "đang đào sâu", "đang xử lý", "đang suy nghĩ", "đang tạo câu trả lời", "đang tổng hợp"
      ];

      const filteredBlocks = rawBlocks.filter((b) => {
        const t = b.text.trim().toLowerCase();
        const isStatus = allStatusPhrases.some(
          (sp) => t.startsWith(sp) && t.length < sp.length + 35
        );
        return (b.text.length > 0 && !isStatus) || b.tag === "hr";
      });

      const signatureOccurrences = new Map<string, number>();
      const blocks = filteredBlocks.map((b, idx) => {
        const snippet = b.text.trim().slice(0, 50).replace(/\s+/g, " ");
        const signature = `${b.tag}::${snippet}`;
        const occurrence = (signatureOccurrences.get(signature) || 0) + 1;
        signatureOccurrences.set(signature, occurrence);
        const stableKey = `${signature}#${occurrence}`;

        return {
          key: stableKey,
          tag: b.tag,
          html: b.html,
          text: b.text,
          streamable: idx < filteredBlocks.length - 1,
        };
      });

      const actionsEl = document.querySelector(".fai-BebopLiteChatInput__actions");
      const hasSubmitBtn = Boolean(
        actionsEl?.querySelector('button[type="submit"], .fai-SendButton')
      );
      const isInputActionsIdle = Boolean(actionsEl) && !hasSubmitBtn && !stopBtn;

      const rawHtml = clone.innerHTML || "";
      const hasContent =
        (blocks.length > 0 || Boolean(fastPathRawText && fastPathRawText.length > 0)) &&
        !isCancellationMessage;
      const isNew = !isLastMsgOld;
      return {
        isGenerating,
        blocks,
        rawHtml,
        isNew,
        hasContent,
        detectedWebError,
        fastPathRawText,
        isInputActionsIdle,
      };
    }, baseline);
  }

  async abortGeneration(page: Page): Promise<void> {
    logFunctionInput("browser:drivers:m365-copilot", "abortGeneration");
    await page
      .evaluate(() => {
        const stopBtn = document.querySelector(
          'button[aria-label*="Stop" i], button[aria-label*="Dừng" i], button[aria-label="Stop generating"], [data-testid="stop-button"], button[aria-label*="Cancel" i]'
        ) as HTMLButtonElement | null;
        if (stopBtn) stopBtn.click();
      })
      .catch(() => {});
  }

  async periodicAction(page: Page, attempt: number): Promise<void> {
    if (attempt % 4 === 0) {
      await page
        .evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
          document
            .querySelectorAll(
              "[role='group'][aria-label='Code Preview'], .monaco-scrollable-element, .scriptor-component-code-block"
            )
            .forEach((el) => {
              try {
                const scrollEl = el as HTMLElement;
                const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
                if (maxScroll > 0 && scrollEl.scrollTop < maxScroll) {
                  scrollEl.scrollTop = Math.min(maxScroll, scrollEl.scrollTop + 350);
                }
              } catch {}
            });
        })
        .catch(() => {});
    }
  }
}

/** Singleton instance mặc định của M365CopilotDriver */
export const m365CopilotDriver = new M365CopilotDriver();
