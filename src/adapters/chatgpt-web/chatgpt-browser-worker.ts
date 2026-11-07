import type { Locator, Page } from "playwright-core";
import {
  BaseWebBrowserWorker,
  type BaseBrowserRunOptions,
  type BrowserCompletionContext,
  type BrowserObservation,
} from "../web/browser";
import { CHATGPT_SELECTORS } from "./selectors";
import { isValidChatGptConversationId } from "./conversation-store";

export interface ChatGptBrowserRunOptions extends BaseBrowserRunOptions {}

export interface ChatGptTurnResult {
  rawResponse: string;
  conversationId?: string;
}

interface ChatGptResponseBaseline {
  assistantIds: string[];
  assistantCount: number;
  initialLatestText: string;
  previousLatestText: string;
  hasSeenGenerating: boolean;
  stableCount: number;
}

interface ChatGptResponseObservation extends BrowserObservation {
  responseId?: string;
  hasCopyControl: boolean;
}

/**
 * Trích xuất conversation ID từ URL ChatGPT (dạng https://chatgpt.com/c/<uuid>)
 */
export function extractConversationIdFromUrl(url: string): string | undefined {
  const match = url.match(/\/c\/([a-zA-Z0-9_-]+)/);
  const candidate = match ? match[1] : undefined;
  return isValidChatGptConversationId(candidate) ? candidate : undefined;
}

/**
 * Worker điều khiển trình duyệt Playwright tương tác với ChatGPT Web
 */
export class ChatGptBrowserWorker extends BaseWebBrowserWorker<
  ChatGptBrowserRunOptions,
  ChatGptTurnResult,
  ChatGptResponseBaseline,
  ChatGptResponseObservation
> {
  protected readonly logPrefix = "chatgpt-worker";

  /**
   * ChatGPT có thể giữ đồng thời composer hoặc control ẩn để phục vụ responsive
   * layout. Luôn chọn phần tử đang hiển thị thay vì mặc định lấy phần tử đầu tiên.
   */
  private async findVisibleLocator(
    page: Page,
    selector: string,
  ): Promise<Locator | undefined> {
    const locators = page.locator(selector);
    const count = await locators.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = locators.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }
    return undefined;
  }

  /**
   * Cài đặt Clipboard Hook trên trang để đón lấy payload copy code trực tiếp
   */
  private async setupClipboardHook(page: Page): Promise<void> {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    await page.evaluate(() => {
      const win = window as any;
      win.__chatgpt_last_copied_code = null;

      // Lắng nghe sự kiện copy chuẩn từ DOM (khi click nút Copy code của ChatGPT)
      const onCopy = (e: ClipboardEvent) => {
        const text = e.clipboardData?.getData("text/plain") || window.getSelection()?.toString();
        if (text) win.__chatgpt_last_copied_code = text;
      };
      document.addEventListener("copy", onCopy, { capture: true });

      // Bọc navigator.clipboard.writeText để bắt nội dung khi click nút copy code của ChatGPT,
      // nhưng tuyệt đối không nuốt lỗi và không can thiệp vào các chuỗi không phải code block
      const origWriteText = navigator.clipboard ? navigator.clipboard.writeText : null;
      if (navigator.clipboard && origWriteText && !win.__chatgpt_hook_installed) {
        win.__chatgpt_hook_installed = true;
        navigator.clipboard.writeText = async (text: string) => {
          if (text && (text.includes("<webResponse>") || text.includes("<tool_call>") || text.includes("```"))) {
            win.__chatgpt_last_copied_code = text;
          }
          return await origWriteText.call(navigator.clipboard, text);
        };
      }
    });
  }

  /**
   * Nhập nội dung prompt trực tiếp vào editor dạng văn bản thuần túy (Plain Text)
   * TUYỆT ĐỐI KHÔNG dùng Clipboard / Paste (DataTransfer paste hoặc Meta+V) để ChatGPT
   * không bao giờ kích hoạt tính năng tự động chuyển văn bản thành file đính kèm "Pasted text.txt".
   */
  protected async insertPrompt(page: Page, promptText: string): Promise<void> {
    console.log(`[chatgpt-worker] Đang nhập prompt trực tiếp dạng văn bản thuần (${promptText.length} ký tự)...`);

    await page.waitForSelector(CHATGPT_SELECTORS.composer, { timeout: 15_000, state: "visible" });

    // Focus vào tab và composer
    await page.bringToFront().catch(() => {});
    const composerLocator = await this.findVisibleLocator(
      page,
      CHATGPT_SELECTORS.composer,
    );
    if (!composerLocator) {
      throw new Error(
        "[chatgpt-worker] Không tìm thấy composer đang hiển thị để nhập prompt.",
      );
    }
    await composerLocator.click();
    await composerLocator.focus();

    // 1. Xóa sạch mọi nội dung cũ bằng phím tắt chuẩn OS (Meta+a / Control+a -> Backspace)
    const isMac = process.platform === "darwin";
    const selectAllKey = isMac ? "Meta+a" : "Control+a";
    await page.keyboard.press(selectAllKey);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(100);

    // 2. Chèn văn bản trực tiếp bằng Playwright locator.fill()
    // fill() trên contenteditable thực hiện chèn qua Input stream nội bộ của trình duyệt,
    // hoàn toàn không bắn sự kiện paste nên ChatGPT Web không thể chuyển thành file đính kèm.
    let fillSuccess = false;
    try {
      await composerLocator.fill(promptText);
      fillSuccess = true;
    } catch {
      fillSuccess = false;
    }

    // 3. Fallback qua DOM Native InputEvent nếu locator.fill() chưa chèn đủ text
    let actualLength = (
      await composerLocator.textContent().catch(() => "")
    ).trim().length;

    if (!fillSuccess || actualLength < promptText.trim().length * 0.8) {
      console.warn(`[chatgpt-worker] locator.fill chưa đưa đủ ký tự (${actualLength}/${promptText.trim().length}), kích hoạt DOM text injection trực tiếp...`);
      await page.evaluate(
        ({ selector, text }) => {
          const editor = document.querySelector(selector) as HTMLElement | null;
          if (!editor) return;
          editor.focus();

          // Dọn sạch nội dung cũ
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(editor);
          sel?.removeAllRanges();
          sel?.addRange(range);
          document.execCommand("delete", false, undefined);

          // Chèn văn bản trực tiếp (Native input stream, không kích hoạt paste handler)
          document.execCommand("insertText", false, text);
          editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
          editor.dispatchEvent(new Event("input", { bubbles: true }));
          editor.dispatchEvent(new Event("change", { bubbles: true }));
        },
        { selector: CHATGPT_SELECTORS.composer, text: promptText }
      );
      await page.waitForTimeout(300);
    }

    // 4. Kích hoạt đồng bộ state cho React & ProseMirror để bật nút Send
    // Thao tác nhấn Space rồi Backspace thông qua bàn phím Playwright kích hoạt native key transaction,
    // giúp React nhận diện văn bản hợp lệ và gỡ bỏ thuộc tính disabled trên nút Send 100%.
    const sendLocator = await this.findVisibleLocator(
      page,
      CHATGPT_SELECTORS.sendButton,
    );
    let isSendEnabled = false;
    if (sendLocator) {
      isSendEnabled = await sendLocator.isEnabled({ timeout: 500 }).catch(() => false);
    }

    if (!isSendEnabled) {
      console.log("[chatgpt-worker] Nút gửi chưa enabled, kích hoạt micro-interaction bàn phím để đồng bộ state...");
      await composerLocator.focus().catch(() => {});
      await page.keyboard.press("Space").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
      await page.waitForTimeout(200);
    }

    const finalLength = (
      await composerLocator.textContent().catch(() => "")
    ).trim().length;
    console.log(`[chatgpt-worker] Đã nhập thành công toàn bộ prompt (${finalLength}/${promptText.trim().length} ký tự) trực tiếp vào ô chat.`);
  }

  /**
   * Thực hiện gửi tin nhắn và xác nhận chắc chắn tin nhắn đã được gửi đi
   * Triển khai cơ chế Guaranteed Submission Loop toàn diện tương tự M365 Copilot
   */
  protected async submitPrompt(
    page: Page,
    options: ChatGptBrowserRunOptions,
  ): Promise<void> {
    console.log("[chatgpt-worker] Bắt đầu quá trình gửi tin nhắn...");

    const composerLocator = await this.findVisibleLocator(
      page,
      CHATGPT_SELECTORS.composer,
    );
    if (!composerLocator) {
      throw new Error(
        "[chatgpt-worker] Không tìm thấy composer đang hiển thị để gửi prompt.",
      );
    }

    const submitDeadline = Date.now() + 15_000;
    let attempt = 0;

    while (Date.now() < submitDeadline) {
      if (options.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      attempt++;

      // 1. Kiểm tra xem tin nhắn đã được gửi đi thành công chưa:
      // Tín hiệu A: Nút Stop xuất hiện (ChatGPT đang sinh câu trả lời)
      // Tín hiệu B: Chính composer đang hiển thị đã trống sau thao tác click.
      // Không dùng document.querySelector vì ChatGPT có thể giữ composer ẩn rỗng.
      const stopVisible = await this.findVisibleLocator(
        page,
        CHATGPT_SELECTORS.stopButton,
      );
      const composerText = (
        await composerLocator.textContent().catch(() => "")
      ).trim();
      const isSubmitted = Boolean(stopVisible) || composerText.length === 0;

      if (isSubmitted) {
        console.log(
          `[chatgpt-worker] Tin nhắn đã được gửi thành công ở lần thử ${attempt} (stopVisible=${Boolean(stopVisible)}, composerLength=${composerText.length})!`,
        );
        return;
      }

      // 2. Thử kích hoạt nút Send nếu hiển thị và enabled
      const sendLocator = await this.findVisibleLocator(
        page,
        CHATGPT_SELECTORS.sendButton,
      );
      const canClickSend = sendLocator
        ? await sendLocator.isEnabled({ timeout: 300 }).catch(() => false)
        : false;

      if (sendLocator && canClickSend) {
        console.log(`[chatgpt-worker] [send] Nút gửi đã sẵn sàng ở lần thử ${attempt}, thực hiện click Send...`);
        await sendLocator.click({ timeout: 1_000 }).catch(error => {
          console.warn(
            `[chatgpt-worker] [send] Click Send thất bại ở lần thử ${attempt}, sẽ tìm lại control đang hiển thị:`,
            error,
          );
        });
      } else {
        // Không nhấn Enter vì ProseMirror multiline có thể chỉ chèn xuống dòng.
        console.log(
          `[chatgpt-worker] [send] Chưa tìm thấy nút Send visible/enabled ở lần thử ${attempt} (composerLength=${composerText.length}), chờ UI đồng bộ...`,
        );
        if (attempt >= 2 && attempt % 2 === 0) {
          await composerLocator.focus().catch(() => {});
          await page.keyboard.press("Space").catch(() => {});
          await page.keyboard.press("Backspace").catch(() => {});
        }
      }

      await page.waitForTimeout(400);
    }

    throw new Error(
      "[chatgpt-worker] Không thể xác nhận prompt đã được gửi trong 15 giây.",
    );
  }

  /**
   * Đọc nội dung phản hồi stream hiện tại từ DOM
   */
  private async readLatestAssistantStreamText(
    page: Page,
    baseline: ChatGptResponseBaseline,
  ): Promise<string> {
    return await page.evaluate(
      ({
        assistantSelector,
        codeBlockSelector,
        baselineIds,
        baselineCount,
        baselineLatestText,
      }) => {
        const knownIds = new Set(baselineIds);
        const messages = Array.from(document.querySelectorAll(assistantSelector));
        const newMessages = messages.filter((message, index) => {
          const wrapper = message.closest(
            "div[data-chatgpt-selection-message-id]",
          );
          const messageId = wrapper?.getAttribute(
            "data-chatgpt-selection-message-id",
          );
          return messageId
            ? !knownIds.has(messageId)
            : index >= baselineCount;
        });
        let latestMsg = newMessages[newMessages.length - 1] as
          | HTMLElement
          | undefined;

        if (!latestMsg) {
          const latestExisting = messages[messages.length - 1] as
            | HTMLElement
            | undefined;
          const latestText = (latestExisting?.textContent || "").trim();
          if (latestText && latestText !== baselineLatestText) {
            latestMsg = latestExisting;
          }
        }

        if (!latestMsg) return "";

        // Ưu tiên đọc từ code block nếu đã xuất hiện
        const codeBlock = latestMsg.querySelector(codeBlockSelector);
        if (codeBlock) {
          const text = (codeBlock.textContent || "").trim();
          if (text.includes("<webResponse>") || text.includes("<tool_call>")) {
            return text;
          }
        }

        // Lấy text hiển thị sạch
        const markdownRoot = latestMsg.querySelector('[data-markdown-text-style="assistant-message"]') || latestMsg;
        return (markdownRoot.textContent || "").trim();
      },
      {
        assistantSelector: CHATGPT_SELECTORS.assistantMessage,
        codeBlockSelector: CHATGPT_SELECTORS.codeBlock,
        baselineIds: baseline.assistantIds,
        baselineCount: baseline.assistantCount,
        baselineLatestText: baseline.initialLatestText,
      }
    );
  }

  /**
   * Trích xuất kết quả hoàn chỉnh qua cơ chế Copy-Salvage (Clipboard Hook)
   */
  protected async extractCompletedResponse(
    page: Page,
    context: BrowserCompletionContext<
      ChatGptResponseBaseline,
      ChatGptResponseObservation
    >,
  ): Promise<string> {
    const { baseline } = context;
    console.log("[chatgpt-worker] [copy-salvage] Đang tìm và click nút Copy code...");

    await page.bringToFront().catch(() => {});
    const targetToken = `codex-copy-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    // Đánh dấu wrapper của assistant response mới để Playwright thực hiện
    // trusted click. Không gọi HTMLElement.click() trong page.evaluate vì
    // Chromium có thể từ chối clipboard nếu không có user activation.
    const targetMarked = await page.evaluate(
      ({
        assistantSelector,
        baselineIds,
        baselineCount,
        baselineLatestText,
        token,
      }) => {
        const win = window as any;
        win.__chatgpt_last_copied_code = null;

        const knownIds = new Set(baselineIds);
        const messages = Array.from(document.querySelectorAll(assistantSelector));
        const newMessages = messages.filter((message, index) => {
          const wrapper = message.closest(
            "div[data-chatgpt-selection-message-id]",
          );
          const messageId = wrapper?.getAttribute(
            "data-chatgpt-selection-message-id",
          );
          return messageId
            ? !knownIds.has(messageId)
            : index >= baselineCount;
        });
        let latestMsg = newMessages[newMessages.length - 1] as
          | HTMLElement
          | undefined;

        if (!latestMsg) {
          const latestExisting = messages[messages.length - 1] as
            | HTMLElement
            | undefined;
          const latestText = (latestExisting?.textContent || "").trim();
          if (latestText && latestText !== baselineLatestText) {
            latestMsg = latestExisting;
          }
        }

        if (!latestMsg) return false;

        const responseWrapper =
          latestMsg.closest("div[data-chatgpt-selection-message-id]") ||
          latestMsg.parentElement;
        if (!responseWrapper) return false;

        responseWrapper.setAttribute("data-codex-copy-target", token);
        return true;
      },
      {
        assistantSelector: CHATGPT_SELECTORS.assistantMessage,
        baselineIds: baseline.assistantIds,
        baselineCount: baseline.assistantCount,
        baselineLatestText: baseline.initialLatestText,
        token: targetToken,
      }
    );

    let clicked = false;
    if (targetMarked) {
      const responseWrapper = page.locator(
        `[data-codex-copy-target="${targetToken}"]`,
      );
      const codeCopyButton = responseWrapper
        .locator(CHATGPT_SELECTORS.copyCodeButton)
        .last();
      const messageCopyButton = responseWrapper
        .locator(CHATGPT_SELECTORS.copyMessageButton)
        .last();
      const copyButton = await codeCopyButton
        .isVisible()
        .catch(() => false)
        ? codeCopyButton
        : await messageCopyButton.isVisible().catch(() => false)
          ? messageCopyButton
          : undefined;

      if (copyButton) {
        clicked = await copyButton
          .scrollIntoViewIfNeeded()
          .then(() => copyButton.click({ timeout: 2_000 }))
          .then(() => true)
          .catch(error => {
            console.warn(
              "[chatgpt-worker] [copy-salvage] Trusted click nút Copy thất bại, fallback DOM:",
              error,
            );
            return false;
          });
      }
    }

    if (clicked) {
      // Chờ clipboard hook nhận được nội dung (tối đa 2.5s)
      const readDeadline = Date.now() + 2_500;
      while (Date.now() < readDeadline) {
        await page.waitForTimeout(100);
        const copied = await page.evaluate(async () => {
          const win = window as any;
          if (win.__chatgpt_last_copied_code) {
            return win.__chatgpt_last_copied_code as string;
          }
          if (navigator.clipboard && typeof navigator.clipboard.readText === "function") {
            try {
              const text = await navigator.clipboard.readText();
              if (text && text.trim().length > 0) return text;
            } catch {}
          }
          return null;
        });

        if (copied && copied.trim().length > 0) {
          console.log(`[chatgpt-worker] [copy-salvage] Đã lấy thành công payload sạch từ Clipboard (${copied.length} ký tự)!`);
          return copied.trim();
        }
      }
    }

    await page
      .evaluate(token => {
        document
          .querySelector(`[data-codex-copy-target="${token}"]`)
          ?.removeAttribute("data-codex-copy-target");
      }, targetToken)
      .catch(() => {});

    console.warn("[chatgpt-worker] [copy-salvage] Không bắt được từ Clipboard, fallback trích xuất DOM text...");
    return await this.readLatestAssistantStreamText(page, baseline);
  }

  protected async navigate(
    page: Page,
    options: ChatGptBrowserRunOptions,
  ): Promise<void> {
    const { conversationId, isNewConversation } = options;
    const currentUrl = page.url();
    if (isNewConversation) {
      if (currentUrl.includes("/c/")) {
        console.log("[chatgpt-worker] Phiên chat mới hoàn toàn, điều hướng về https://chatgpt.com/");
        await page.goto("https://chatgpt.com/", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
      } else if (!currentUrl.includes("chatgpt.com")) {
        console.log("[chatgpt-worker] Điều hướng đến https://chatgpt.com/");
        await page.goto("https://chatgpt.com/", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
      }
    } else {
      if (conversationId) {
        if (!currentUrl.includes(`/c/${conversationId}`)) {
          console.log(`[chatgpt-worker] Điều hướng đến cuộc trò chuyện hiện có: https://chatgpt.com/c/${conversationId}`);
          await page.goto(`https://chatgpt.com/c/${conversationId}`, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          });
        } else {
          console.log(`[chatgpt-worker] Tab đã ở sẵn cuộc trò chuyện https://chatgpt.com/c/${conversationId}, tiếp tục gửi tin nhắn.`);
        }
      } else if (currentUrl.includes("/c/")) {
        console.log(`[chatgpt-worker] Giữ nguyên tab cuộc hội thoại hiện tại (${currentUrl}), không mở chat mới.`);
      }
    }
  }

  protected async prepareProvider(page: Page): Promise<void> {
    await page.bringToFront().catch(() => {});
    await page.waitForSelector(CHATGPT_SELECTORS.composer, {
      timeout: 20_000,
      state: "visible",
    });
    await this.setupClipboardHook(page);
  }

  protected async captureResponseBaseline(
    page: Page,
  ): Promise<ChatGptResponseBaseline> {
    const responseBaseline = await page.evaluate(assistantSelector => {
      const messages = Array.from(document.querySelectorAll(assistantSelector));
      const latestMessage = messages[messages.length - 1];
      return {
        assistantIds: messages
          .map(message =>
            message
              .closest("div[data-chatgpt-selection-message-id]")
              ?.getAttribute("data-chatgpt-selection-message-id"),
          )
          .filter((value): value is string => Boolean(value)),
        assistantCount: messages.length,
        initialLatestText: (latestMessage?.textContent || "").trim(),
      };
    }, CHATGPT_SELECTORS.assistantMessage);

    return {
      ...responseBaseline,
      previousLatestText: responseBaseline.initialLatestText,
      hasSeenGenerating: false,
      stableCount: 0,
    };
  }

  protected async observeResponse(
    page: Page,
    baseline: ChatGptResponseBaseline,
  ): Promise<ChatGptResponseObservation> {
    const status = await page.evaluate(
      ({
        stopSelector,
        assistantSelector,
        copyCodeSelector,
        copyMessageSelector,
        baselineIds,
        baselineCount,
        baselineLatestText,
      }) => {
        const knownIds = new Set(baselineIds);
        const isGenerating = Boolean(document.querySelector(stopSelector));
        const messages = Array.from(
          document.querySelectorAll(assistantSelector),
        );
        const newMessages = messages.filter((message, index) => {
          const wrapper = message.closest(
            "div[data-chatgpt-selection-message-id]",
          );
          const messageId = wrapper?.getAttribute(
            "data-chatgpt-selection-message-id",
          );
          return messageId
            ? !knownIds.has(messageId)
            : index >= baselineCount;
        });
        let latestMessage = newMessages[newMessages.length - 1] as
          | HTMLElement
          | undefined;

        if (!latestMessage) {
          const latestExisting = messages[messages.length - 1] as
            | HTMLElement
            | undefined;
          const latestText = (latestExisting?.textContent || "").trim();
          if (latestText && latestText !== baselineLatestText) {
            latestMessage = latestExisting;
          }
        }

        const responseWrapper =
          latestMessage?.closest(
            "div[data-chatgpt-selection-message-id]",
          ) || latestMessage?.parentElement;
        const responseId =
          responseWrapper?.getAttribute(
            "data-chatgpt-selection-message-id",
          ) || undefined;
        const hasCopyControl = Boolean(
          responseWrapper?.querySelector(copyCodeSelector) ||
            responseWrapper?.querySelector(copyMessageSelector),
        );

        return {
          isGenerating,
          hasNewResponse: Boolean(latestMessage),
          responseId,
          hasCopyControl,
        };
      },
      {
        stopSelector: CHATGPT_SELECTORS.stopButton,
        assistantSelector: CHATGPT_SELECTORS.assistantMessage,
        copyCodeSelector: CHATGPT_SELECTORS.copyCodeButton,
        copyMessageSelector: CHATGPT_SELECTORS.copyMessageButton,
        baselineIds: baseline.assistantIds,
        baselineCount: baseline.assistantCount,
        baselineLatestText: baseline.initialLatestText,
      },
    );

    if (status.isGenerating) baseline.hasSeenGenerating = true;

    const currentText = await this.readLatestAssistantStreamText(
      page,
      baseline,
    );
    if (currentText && currentText !== baseline.previousLatestText) {
      baseline.previousLatestText = currentText;
      baseline.stableCount = 0;
    } else if (currentText) {
      baseline.stableCount += 1;
    }

    const completedWithCopy =
      status.hasNewResponse &&
      !status.isGenerating &&
      status.hasCopyControl &&
      currentText.length > 0;
    const completedByStability =
      status.hasNewResponse &&
      !status.isGenerating &&
      currentText.length > 0 &&
      baseline.stableCount >= (baseline.hasSeenGenerating ? 4 : 8);

    return {
      text: currentText,
      isGenerating: status.isGenerating,
      isCompleted: completedWithCopy || completedByStability,
      responseId: status.responseId,
      hasCopyControl: status.hasCopyControl,
      activityKey: [
        status.responseId ||
          (status.hasNewResponse
            ? "new-response-without-id"
            : "no-new-response"),
        status.isGenerating,
        status.hasCopyControl,
        currentText.length,
      ].join(":"),
    };
  }

  protected async resolveConversationId(
    page: Page,
    options: ChatGptBrowserRunOptions,
  ): Promise<string | undefined> {
    let currentConversationId = extractConversationIdFromUrl(page.url());
    if (!currentConversationId) {
      const waitStart = Date.now();
      while (Date.now() - waitStart < 3000) {
        await page.waitForTimeout(300);
        const pollId = extractConversationIdFromUrl(page.url());
        if (pollId) {
          currentConversationId = pollId;
          break;
        }
      }
    }

    if (!currentConversationId) {
      const sidebarId = await page.evaluate(() => {
        const activeLink = document.querySelector('nav a[href*="/c/"]');
        const href = activeLink?.getAttribute("href") || "";
        const m = href.match(/\/c\/([a-zA-Z0-9_-]+)/);
        return m ? m[1] : null;
      }).catch(() => null);
      if (sidebarId && isValidChatGptConversationId(sidebarId)) {
        currentConversationId = sidebarId;
      }
    }

    const finalConversationId = isValidChatGptConversationId(currentConversationId)
      ? currentConversationId
      : isValidChatGptConversationId(options.conversationId)
        ? options.conversationId
        : undefined;
    console.log(`[chatgpt-worker] Lượt hoàn tất thành công. URL: ${page.url()}, Conversation ID: ${finalConversationId || "chưa xác định"}`);
    return finalConversationId;
  }

  protected async stopGeneration(page: Page): Promise<boolean> {
    return await page
      .locator(CHATGPT_SELECTORS.stopButton)
      .first()
      .click({ timeout: 1_000 })
      .then(() => true)
      .catch(() => false);
  }
}
