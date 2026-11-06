import type { Page } from "playwright-core";
import {
  BaseWebBrowserWorker,
  type BaseBrowserRunOptions,
  type BrowserCompletionContext,
  type BrowserObservation,
} from "../web/browser";
import { QWEN_SELECTORS, extractConversationIdFromUrl, isValidQwenConversationId } from "./selectors";

export interface QwenBrowserRunOptions extends BaseBrowserRunOptions {
  reasoningEffort?: string;
}

export interface QwenTurnResult {
  rawResponse: string;
  conversationId?: string;
}

interface QwenResponseBaseline {
  assistantCount: number;
  previousLatestText: string;
  hasSeenGenerating: boolean;
  stableCount: number;
}

interface QwenResponseObservation extends BrowserObservation {
  assistantCount: number;
  completedState: boolean;
}

/**
 * Worker điều khiển trình duyệt Playwright tương tác với Qwen Web (https://chat.qwen.ai)
 */
export class QwenBrowserWorker extends BaseWebBrowserWorker<
  QwenBrowserRunOptions,
  QwenTurnResult,
  QwenResponseBaseline,
  QwenResponseObservation
> {
  protected readonly logPrefix = "qwen-worker";

  /**
   * Thiết lập chế độ Thinking Mode trên giao diện Qwen Web dựa theo tùy chọn
   * - wantThinking = true: Chọn "Thinking"
   * - wantThinking = false: Chọn "Fast" (hoặc "Auto" - không suy nghĩ)
   */
  public async setThinkingMode(page: Page, wantThinking: boolean): Promise<void> {
    try {
      const thinkingEl = await page.$(QWEN_SELECTORS.thinkingSelector);
      if (!thinkingEl) {
        // Có thể trang chưa load xong hoặc đang ở giao diện không hỗ trợ selector
        return;
      }

      // Đọc nhãn trạng thái hiện tại
      const currentLabel = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return (el?.textContent || "").trim();
      }, QWEN_SELECTORS.thinkingLabel);

      const isCurrentThinking = currentLabel.toLowerCase().includes("thinking") || currentLabel.toLowerCase().includes("think");

      if (wantThinking === isCurrentThinking) {
        console.log(`[qwen-worker] Chế độ Thinking đã sẵn sàng ở trạng thái mong muốn: "${currentLabel}" (thinking=${isCurrentThinking})`);
        return;
      }

      console.log(`[qwen-worker] Đang chuyển đổi Thinking mode: hiện tại="${currentLabel}", mong muốn=${wantThinking ? "Thinking" : "Fast (Không thinking)"}...`);

      // 1. Click vào trigger để mở dropdown menu
      const trigger = page.locator(QWEN_SELECTORS.thinkingTrigger).first();
      await trigger.click({ timeout: 2000 }).catch(async () => {
        await page.locator(QWEN_SELECTORS.thinkingSelectButton).first().click().catch(() => {});
      });

      // 2. Chờ popup menu xuất hiện
      await page.waitForSelector(QWEN_SELECTORS.thinkingPopup, { state: "visible", timeout: 2000 }).catch(() => {});

      // 3. Tìm và click vào item mong muốn trong popup
      const targetName = wantThinking ? "Thinking" : "Fast";
      const clicked = await page.evaluate(
        ({ popupSel, itemSel, labelSel, wantThink }) => {
          const popups = Array.from(document.querySelectorAll(popupSel));
          const visiblePopup = popups.find(p => (p as HTMLElement).offsetParent !== null) || popups[popups.length - 1];
          if (!visiblePopup) return false;

          const items = Array.from(visiblePopup.querySelectorAll(itemSel));
          let matchedItem: HTMLElement | null = null;

          for (const item of items) {
            const labelEl = item.querySelector(labelSel);
            const text = (labelEl?.textContent || item.textContent || "").trim().toLowerCase();
            if (wantThink) {
              if (text.includes("thinking") || text.includes("think")) {
                matchedItem = item as HTMLElement;
                break;
              }
            } else {
              if (text.includes("fast")) {
                matchedItem = item as HTMLElement;
                break;
              }
            }
          }

          // Fallback cho chế độ không thinking nếu không tìm thấy "Fast"
          if (!matchedItem && !wantThink) {
            for (const item of items) {
              const labelEl = item.querySelector(labelSel);
              const text = (labelEl?.textContent || item.textContent || "").trim().toLowerCase();
              if (text.includes("auto") || (!text.includes("thinking") && !text.includes("think"))) {
                matchedItem = item as HTMLElement;
                break;
              }
            }
          }

          if (matchedItem) {
            matchedItem.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
            matchedItem.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
            matchedItem.click();
            return true;
          }
          return false;
        },
        {
          popupSel: QWEN_SELECTORS.thinkingPopup,
          itemSel: QWEN_SELECTORS.thinkingMenuItem,
          labelSel: QWEN_SELECTORS.thinkingMenuItemLabel,
          wantThink: wantThinking,
        }
      );

      await page.waitForTimeout(300);

      const finalLabel = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return (el?.textContent || "").trim();
      }, QWEN_SELECTORS.thinkingLabel);

      console.log(`[qwen-worker] Đã chuyển đổi Thinking mode thành: "${finalLabel}" (thành công=${clicked})`);
    } catch (err) {
      console.warn(`[qwen-worker] Không thể chuyển đổi Thinking mode (sẽ tiếp tục thực hiện):`, err);
    }
  }

  /**
   * Cài đặt Clipboard Hook trên trang để đón lấy payload copy code trực tiếp từ Qwen
   */
  private async setupClipboardHook(page: Page): Promise<void> {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    await page.evaluate(() => {
      const win = window as any;
      win.__qwen_last_copied_code = null;
      const origWriteText = navigator.clipboard ? navigator.clipboard.writeText : null;
      if (navigator.clipboard && !win.__qwen_clipboard_hook_installed) {
        win.__qwen_clipboard_hook_installed = true;
        navigator.clipboard.writeText = async (text: string) => {
          win.__qwen_last_copied_code = text;
          try {
            if (origWriteText) return await origWriteText.call(navigator.clipboard, text);
          } catch {
            return Promise.resolve();
          }
        };
      }
      if (!win.__qwen_copy_listener_installed) {
        win.__qwen_copy_listener_installed = true;
        const onCopy = (e: ClipboardEvent) => {
          const text = e.clipboardData?.getData("text/plain") || window.getSelection()?.toString();
          if (text) win.__qwen_last_copied_code = text;
        };
        document.addEventListener("copy", onCopy, { capture: true });
      }
    });
  }

  /**
   * Nhập nội dung prompt vào ô textarea an toàn bằng Native OS Clipboard Paste
   * kết hợp dispatch sự kiện input để React state của Qwen nhận diện ngay lập tức
   */
  protected async insertPrompt(
    page: Page,
    promptText: string,
  ): Promise<void> {
    console.log(`[qwen-worker] Đang nhập prompt an toàn qua Native Clipboard Paste (${promptText.length} ký tự)...`);

    await page.waitForSelector(QWEN_SELECTORS.composer, { timeout: 15_000, state: "visible" });

    // Focus vào composer textarea
    const composerLocator = page.locator(QWEN_SELECTORS.composer).first();
    await composerLocator.click();

    // 1. Xóa sạch nội dung cũ bằng phím tắt chuẩn OS (Meta+a / Control+a -> Backspace)
    const isMac = process.platform === "darwin";
    const selectAllKey = isMac ? "Meta+a" : "Control+a";
    await page.keyboard.press(selectAllKey);
    await page.keyboard.press("Backspace");

    // 2. Ghi prompt vào Clipboard của browser
    let clipboardSuccess = false;
    try {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
      await page.evaluate((text) => {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          return navigator.clipboard.writeText(text);
        }
        return Promise.reject(new Error("Clipboard API không khả dụng"));
      }, promptText);
      clipboardSuccess = true;
    } catch {
      clipboardSuccess = false;
    }

    if (clipboardSuccess) {
      // 3. Kích hoạt phím tắt Dán Native của OS (Meta+v / Control+v)
      const pasteKey = isMac ? "Meta+v" : "Control+v";
      await page.keyboard.press(pasteKey);
    } else {
      // Fallback: Sử dụng set value và dispatch input event
      console.warn("[qwen-worker] Không thể ghi vào Clipboard API, kích hoạt textarea value injection fallback...");
      await page.evaluate(
        ({ selector, text }) => {
          const textarea = document.querySelector(selector) as HTMLTextAreaElement | null;
          if (!textarea) return;
          textarea.focus();
          textarea.value = text;
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          textarea.dispatchEvent(new Event("change", { bubbles: true }));
        },
        { selector: QWEN_SELECTORS.composer, text: promptText }
      );
    }

    // Đợi 400ms để React cập nhật DOM và kích hoạt nút Send
    await page.waitForTimeout(400);

    // Kích hoạt thêm sự kiện input để đảm bảo nút Send chắc chắn enabled
    await page.evaluate((sel) => {
      const textarea = document.querySelector(sel) as HTMLTextAreaElement | null;
      if (textarea) {
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, QWEN_SELECTORS.composer);

    // Kiểm tra độ dài nội dung thực tế trong textarea
    const actualLength = await page.evaluate(
      (sel) => ((document.querySelector(sel) as HTMLTextAreaElement)?.value || "").trim().length,
      QWEN_SELECTORS.composer
    );

    if (actualLength < promptText.trim().length * 0.8) {
      console.warn(`[qwen-worker] Cảnh báo: Textarea đang có ${actualLength}/${promptText.trim().length} ký tự. Thử dùng Playwright fill fallback...`);
      await composerLocator.fill(promptText);
      await page.waitForTimeout(300);
    } else {
      console.log(`[qwen-worker] Đã nhập thành công toàn bộ prompt (${actualLength} ký tự) vào ô chat Qwen.`);
    }
  }

  /**
   * Thực hiện gửi tin nhắn và xác nhận chắc chắn tin nhắn đã được gửi đi
   */
  protected async submitPrompt(
    page: Page,
    options: QwenBrowserRunOptions,
  ): Promise<void> {
    console.log("[qwen-worker] Đang nhấn nút gửi...");

    const composerLocator = page.locator(QWEN_SELECTORS.composer).first();
    const sendBtn = page.locator(QWEN_SELECTORS.sendButton).first();

    // Chờ tối đa 3s cho nút Send xuất hiện và enabled
    let canClickSend = false;
    try {
      await sendBtn.waitFor({ state: "visible", timeout: 3000 });
      canClickSend = await sendBtn.isEnabled({ timeout: 1000 }).catch(() => false);
    } catch {
      canClickSend = false;
    }

    if (canClickSend) {
      console.log("[qwen-worker] Nút gửi đã sẵn sàng, thực hiện click Send...");
      await sendBtn.click().catch(() => {});
    } else {
      console.log("[qwen-worker] Nút gửi chưa enabled, nhấn Enter trên composer...");
      await composerLocator.press("Enter").catch(() => {});
    }

    // Vòng lặp xác nhận chắc chắn tin nhắn đã được gửi đi
    const submitDeadline = Date.now() + 10_000;
    while (Date.now() < submitDeadline) {
      if (options.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const isSubmitted = await page.evaluate(
        ({ stopSelector, composerSelector }) => {
          const stopBtn = document.querySelector(stopSelector);
          if (stopBtn) return true; // Đang sinh câu trả lời => đã gửi thành công

          const textarea = document.querySelector(composerSelector) as HTMLTextAreaElement | null;
          const text = (textarea?.value || "").trim();
          return text.length === 0;
        },
        { stopSelector: QWEN_SELECTORS.stopButton, composerSelector: QWEN_SELECTORS.composer }
      );

      if (isSubmitted) {
        console.log("[qwen-worker] Tin nhắn đã được gửi thành công sang Qwen!");
        return;
      }

      await page.waitForTimeout(200);
    }

    console.warn("[qwen-worker] Hết thời gian chờ xác nhận gửi, tiếp tục theo dõi phản hồi...");
  }

  /**
   * Đọc nội dung phản hồi stream hiện tại từ DOM
   */
  private async readLatestAssistantStreamText(
    page: Page,
    minimumAssistantCount = 0,
  ): Promise<string> {
    return await page.evaluate(
      ({
        assistantSelector,
        phaseAnswerSelector,
        codeBlockSelector,
        minimumCount,
      }) => {
        const messages = Array.from(document.querySelectorAll(assistantSelector));
        if (messages.length <= minimumCount) return "";
        const latestMsg = messages[messages.length - 1] as HTMLElement;

        // 1. Ưu tiên đọc từ code block nếu đã xuất hiện
        const codeBlock = latestMsg.querySelector(codeBlockSelector);
        if (codeBlock) {
          const text = (codeBlock.textContent || "").trim();
          if (text.includes("<webResponse>") || text.includes("<tool_call>")) {
            return text;
          }
        }

        // 2. Lấy từ khối câu trả lời thực tế (phase-answer)
        const answerRoot = latestMsg.querySelector(phaseAnswerSelector) || latestMsg;
        return (answerRoot.textContent || "").trim();
      },
      {
        assistantSelector: QWEN_SELECTORS.assistantMessage,
        phaseAnswerSelector: QWEN_SELECTORS.phaseAnswer,
        codeBlockSelector: QWEN_SELECTORS.codeBlock,
        minimumCount: minimumAssistantCount,
      }
    );
  }

  /**
   * Trích xuất kết quả hoàn chỉnh qua cơ chế Copy-Salvage (Clipboard Hook)
   */
  protected async extractCompletedResponse(
    page: Page,
    context: BrowserCompletionContext<
      QwenResponseBaseline,
      QwenResponseObservation
    >,
  ): Promise<string> {
    console.log("[qwen-worker] [copy-salvage] Đang tìm và click nút Copy code...");

    // Cố gắng click nút "Copy" của code block trong tin nhắn cuối
    const clicked = await page.evaluate(
      ({
        assistantSelector,
        copyCodeSelector,
        copyResponseSelector,
        minimumCount,
      }) => {
        const win = window as any;
        win.__qwen_last_copied_code = null;

        const messages = Array.from(document.querySelectorAll(assistantSelector));
        if (messages.length <= minimumCount) return false;
        const latestMsg = messages[messages.length - 1] as HTMLElement | null;
        if (!latestMsg) return false;

        // 1. Ưu tiên nút "Copy" trên codeblock markdown header
        let copyBtn = latestMsg.querySelector(copyCodeSelector) as HTMLElement | null;
        if (!copyBtn) {
          // 2. Fallback: nút "Copy" toàn bộ tin nhắn ở footer
          copyBtn = latestMsg.querySelector(copyResponseSelector) as HTMLElement | null;
        }

        if (!copyBtn) return false;

        copyBtn.scrollIntoView({ block: "center", inline: "center" });
        copyBtn.focus();
        copyBtn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
        copyBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        copyBtn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
        copyBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        copyBtn.click();
        return true;
      },
      {
        assistantSelector: QWEN_SELECTORS.assistantMessage,
        copyCodeSelector: QWEN_SELECTORS.codeCopyButton,
        copyResponseSelector: QWEN_SELECTORS.responseCopyButton,
        minimumCount: context.baseline.assistantCount,
      }
    );

    if (clicked) {
      // Chờ clipboard hook nhận được nội dung (tối đa 2.5s)
      const readDeadline = Date.now() + 2_500;
      while (Date.now() < readDeadline) {
        await page.waitForTimeout(100);
        const copied = await page.evaluate(async () => {
          const win = window as any;
          if (win.__qwen_last_copied_code) {
            return win.__qwen_last_copied_code as string;
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
          console.log(`[qwen-worker] [copy-salvage] Đã lấy thành công payload sạch từ Clipboard (${copied.length} ký tự)!`);
          return copied.trim();
        }
      }
    }

    console.warn("[qwen-worker] [copy-salvage] Không bắt được từ Clipboard, fallback trích xuất DOM text...");
    return await this.readLatestAssistantStreamText(
      page,
      context.baseline.assistantCount,
    );
  }

  protected async navigate(
    page: Page,
    options: QwenBrowserRunOptions,
  ): Promise<void> {
    const { conversationId, isNewConversation } = options;
    const currentUrl = page.url();
    if (isNewConversation) {
      if (currentUrl.includes("/c/")) {
        console.log("[qwen-worker] Phiên chat mới hoàn toàn, điều hướng về https://chat.qwen.ai/");
        await page.goto("https://chat.qwen.ai/", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
      } else if (!currentUrl.includes("chat.qwen.ai")) {
        console.log("[qwen-worker] Điều hướng đến https://chat.qwen.ai/");
        await page.goto("https://chat.qwen.ai/", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
      }
    } else {
      if (conversationId) {
        if (!currentUrl.includes(`/c/${conversationId}`)) {
          console.log(`[qwen-worker] Điều hướng đến cuộc trò chuyện hiện có: https://chat.qwen.ai/c/${conversationId}`);
          await page.goto(`https://chat.qwen.ai/c/${conversationId}`, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          });
        } else {
          console.log(`[qwen-worker] Tab đã ở sẵn cuộc trò chuyện https://chat.qwen.ai/c/${conversationId}, tiếp tục gửi tin nhắn.`);
        }
      } else {
        // Nếu chưa lưu conversationId nhưng tab đang ở sẵn /c/<id>, TUYỆT ĐỐI GIỮ NGUYÊN!
        if (currentUrl.includes("/c/")) {
          console.log(`[qwen-worker] Giữ nguyên tab cuộc hội thoại hiện tại (${currentUrl}), không mở chat mới.`);
        }
      }
    }
  }

  protected async prepareProvider(
    page: Page,
    options: QwenBrowserRunOptions,
  ): Promise<void> {
    await this.setupClipboardHook(page);
    const wantThinking =
      options.reasoningEffort === "high" ||
      options.reasoningEffort === "think";
    await this.setThinkingMode(page, wantThinking);
  }

  protected async captureResponseBaseline(
    page: Page,
  ): Promise<QwenResponseBaseline> {
    const state = await page.evaluate(
      ({ assistantSelector, phaseAnswerSelector }) => {
        const messages = Array.from(
          document.querySelectorAll(assistantSelector),
        );
        const latestMessage = messages[messages.length - 1] as
          | HTMLElement
          | undefined;
        const answerRoot =
          latestMessage?.querySelector(phaseAnswerSelector) || latestMessage;
        return {
          assistantCount: messages.length,
          previousLatestText: (answerRoot?.textContent || "").trim(),
        };
      },
      {
        assistantSelector: QWEN_SELECTORS.assistantMessage,
        phaseAnswerSelector: QWEN_SELECTORS.phaseAnswer,
      },
    );

    return {
      ...state,
      hasSeenGenerating: false,
      stableCount: 0,
    };
  }

  protected async observeResponse(
    page: Page,
    baseline: QwenResponseBaseline,
  ): Promise<QwenResponseObservation> {
    const status = await page.evaluate(
      ({
        stopSelector,
        disabledSendSelector,
        assistantSelector,
      }) => {
        const isStopVisible = Boolean(document.querySelector(stopSelector));
        const isDisabledSendVisible = Boolean(document.querySelector(disabledSendSelector));
        return {
          isGenerating: isStopVisible,
          isCompletedState: !isStopVisible && isDisabledSendVisible,
          assistantCount: document.querySelectorAll(assistantSelector).length,
        };
      },
      {
        stopSelector: QWEN_SELECTORS.stopButton,
        disabledSendSelector: QWEN_SELECTORS.sendButtonDisabled,
        assistantSelector: QWEN_SELECTORS.assistantMessage,
      },
    );

    if (status.isGenerating) baseline.hasSeenGenerating = true;

    const currentText = await this.readLatestAssistantStreamText(
      page,
      baseline.assistantCount,
    );
    if (currentText && currentText !== baseline.previousLatestText) {
      baseline.previousLatestText = currentText;
      baseline.stableCount = 0;
    } else if (currentText) {
      baseline.stableCount += 1;
    }

    const hasNewResponse = status.assistantCount > baseline.assistantCount;
    const normalCompletion =
      hasNewResponse &&
      baseline.hasSeenGenerating &&
      !status.isGenerating &&
      baseline.stableCount >= 4;
    const fastCompletion =
      hasNewResponse &&
      !baseline.hasSeenGenerating &&
      currentText.length > 50 &&
      baseline.stableCount >= 8 &&
      status.isCompletedState;

    return {
      text: currentText,
      isGenerating: status.isGenerating,
      isCompleted: normalCompletion || fastCompletion,
      assistantCount: status.assistantCount,
      completedState: status.isCompletedState,
      activityKey: [
        status.assistantCount,
        status.isGenerating,
        status.isCompletedState,
        currentText.length,
      ].join(":"),
    };
  }

  protected async resolveConversationId(
    page: Page,
    options: QwenBrowserRunOptions,
  ): Promise<string | undefined> {
    let currentConversationId =
      extractConversationIdFromUrl(page.url()) || undefined;
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
        const activeLink = document.querySelector('nav a[href*="/c/"], .sidebar a[href*="/c/"], a[href*="/c/"]');
        const href = activeLink?.getAttribute("href") || "";
        const m = href.match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        return m ? m[1] : null;
      }).catch(() => null);
      if (sidebarId && isValidQwenConversationId(sidebarId)) {
        currentConversationId = sidebarId;
      }
    }

    const finalConversationId = isValidQwenConversationId(
      currentConversationId || "",
    )
      ? currentConversationId
      : isValidQwenConversationId(options.conversationId || "")
        ? options.conversationId
        : undefined;

    console.log(`[qwen-worker] Lượt hoàn tất thành công. URL: ${page.url()}, Conversation ID: ${finalConversationId || "chưa xác định"}`);
    return finalConversationId;
  }

  protected async stopGeneration(page: Page): Promise<boolean> {
    return await page
      .locator(QWEN_SELECTORS.stopButton)
      .first()
      .click({ timeout: 1_000 })
      .then(() => true)
      .catch(() => false);
  }
}
