import type { Page } from "playwright-core";
import { QWEN_SELECTORS, extractConversationIdFromUrl, isValidQwenConversationId } from "./selectors";

export interface QwenBrowserRunOptions {
  prompt: string;
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
  reasoningEffort?: string;
  conversationId?: string;
  isNewConversation?: boolean;
  timeoutMs?: number;
}

export interface QwenTurnResult {
  rawResponse: string;
  conversationId?: string;
}

/**
 * Worker điều khiển trình duyệt Playwright tương tác với Qwen Web (https://chat.qwen.ai)
 */
export class QwenBrowserWorker {
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
      if (navigator.clipboard) {
        navigator.clipboard.writeText = async (text: string) => {
          win.__qwen_last_copied_code = text;
          try {
            if (origWriteText) return await origWriteText.call(navigator.clipboard, text);
          } catch {
            return Promise.resolve();
          }
        };
      }
      const onCopy = (e: ClipboardEvent) => {
        const text = e.clipboardData?.getData("text/plain") || window.getSelection()?.toString();
        if (text) win.__qwen_last_copied_code = text;
      };
      document.addEventListener("copy", onCopy, { capture: true });
    });
  }

  /**
   * Nhập nội dung prompt vào ô textarea an toàn bằng Native OS Clipboard Paste
   * kết hợp dispatch sự kiện input để React state của Qwen nhận diện ngay lập tức
   */
  private async insertPromptSafely(page: Page, promptText: string): Promise<void> {
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
  private async submitPrompt(page: Page, signal?: AbortSignal): Promise<void> {
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
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

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
  private async readLatestAssistantStreamText(page: Page): Promise<string> {
    return await page.evaluate(
      ({ assistantSelector, phaseAnswerSelector, codeBlockSelector }) => {
        const messages = Array.from(document.querySelectorAll(assistantSelector));
        if (messages.length === 0) return "";
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
      }
    );
  }

  /**
   * Trích xuất kết quả hoàn chỉnh qua cơ chế Copy-Salvage (Clipboard Hook)
   */
  private async extractCompletedResponse(page: Page): Promise<string> {
    console.log("[qwen-worker] [copy-salvage] Đang tìm và click nút Copy code...");

    // Cố gắng click nút "Copy" của code block trong tin nhắn cuối
    const clicked = await page.evaluate(
      ({ assistantSelector, copyCodeSelector, copyResponseSelector }) => {
        const win = window as any;
        win.__qwen_last_copied_code = null;

        const messages = Array.from(document.querySelectorAll(assistantSelector));
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
    return await this.readLatestAssistantStreamText(page);
  }

  /**
   * Thực thi một lượt gửi câu hỏi và nhận câu trả lời từ Qwen Web
   */
  public async executeTurn(
    page: Page,
    options: QwenBrowserRunOptions
  ): Promise<QwenTurnResult> {
    const { prompt, onChunk, signal, conversationId, isNewConversation, timeoutMs = 180_000 } = options;
    let currentConversationId = isValidQwenConversationId(conversationId || "") ? conversationId : undefined;

    if (signal?.aborted) {
      throw new DOMException("Qwen turn aborted before start", "AbortError");
    }

    // 1. Quản lý URL & Điều hướng
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
      }
    }

    // 2. Thiết lập Clipboard Hook để bắt payload code sạch
    await this.setupClipboardHook(page);

    // 3. Thiết lập chế độ Thinking Mode (mặc định tắt giống chatgpt-web, chỉ bật khi effort là "high" hoặc "think")
    const wantThinking = options.reasoningEffort === "high" || options.reasoningEffort === "think";
    await this.setThinkingMode(page, wantThinking);

    // 4. Nhập prompt an toàn
    await this.insertPromptSafely(page, prompt);

    // 5. Nhấn nút gửi
    await this.submitPrompt(page, signal);

    // 5. Theo dõi quá trình Qwen trả lời và bắt nội dung hoàn chỉnh
    console.log("[qwen-worker] Đang theo dõi quá trình sinh câu trả lời của Qwen...");
    const startTime = Date.now();
    let hasSeenGenerating = false;
    let lastChunkText = "";
    let stableCount = 0;
    const requiredStableCount = 4; // 4 lần liên tiếp không đổi text (khoảng 1.2s)

    while (Date.now() - startTime < timeoutMs) {
      if (signal?.aborted) {
        // Cố gắng bấm nút Stop nếu bị hủy
        await page.locator(QWEN_SELECTORS.stopButton).first().click().catch(() => {});
        throw new DOMException("Qwen turn was aborted during execution", "AbortError");
      }

      // Kiểm tra trạng thái đang sinh câu trả lời
      const status = await page.evaluate(({ stopSelector, disabledSendSelector }) => {
        const isStopVisible = Boolean(document.querySelector(stopSelector));
        const isDisabledSendVisible = Boolean(document.querySelector(disabledSendSelector));
        return {
          isGenerating: isStopVisible,
          isCompletedState: !isStopVisible && isDisabledSendVisible,
        };
      }, {
        stopSelector: QWEN_SELECTORS.stopButton,
        disabledSendSelector: QWEN_SELECTORS.sendButtonDisabled,
      });

      if (status.isGenerating) {
        hasSeenGenerating = true;
      }

      // Đọc text stream hiện tại
      const currentText = await this.readLatestAssistantStreamText(page);

      if (currentText.length > 0 && currentText !== lastChunkText) {
        stableCount = 0;
        const delta = currentText.startsWith(lastChunkText)
          ? currentText.slice(lastChunkText.length)
          : currentText;
        lastChunkText = currentText;

        if (delta.length > 0 && onChunk) {
          onChunk(delta);
        }
      } else if (currentText.length > 0 && currentText === lastChunkText) {
        stableCount++;
      }

      // Điều kiện hoàn thành:
      // 1. Đã từng thấy Qwen bắt đầu sinh câu trả lời (hasSeenGenerating)
      // 2. Nút Stop đã biến mất
      // 3. Text đã ổn định ít nhất 4 vòng lặp (1.2 giây)
      if (hasSeenGenerating && !status.isGenerating && stableCount >= requiredStableCount) {
        console.log(`[qwen-worker] Qwen đã hoàn tất câu trả lời (${lastChunkText.length} ký tự).`);
        break;
      }

      // Fallback: nếu chưa kịp bắt gặp nút stop (trả lời quá nhanh) nhưng text đã ổn định và có nội dung hoàn chỉnh
      if (!hasSeenGenerating && currentText.length > 50 && stableCount >= 8 && status.isCompletedState) {
        console.log("[qwen-worker] [fast-path] Bắt được phản hồi hoàn tất trực tiếp mà không qua stop-button.");
        break;
      }

      await page.waitForTimeout(300);
    }

    // 6. Cập nhật conversation ID mới từ URL sau khi Qwen điều hướng
    const newConversationId = extractConversationIdFromUrl(page.url());
    if (newConversationId && isValidQwenConversationId(newConversationId)) {
      currentConversationId = newConversationId;
      console.log(`[qwen-worker] Đã ghi nhận Conversation ID của Qwen: ${currentConversationId}`);
    }

    // 7. Trích xuất phản hồi hoàn chỉnh
    const rawResponse = await this.extractCompletedResponse(page);

    return {
      rawResponse: rawResponse || lastChunkText,
      conversationId: currentConversationId,
    };
  }
}
