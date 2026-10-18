import type { Page } from "playwright-core";
import { CHATGPT_SELECTORS } from "./selectors";
import { ensureChatGptThinkingMode } from "./capability-picker";

export interface ChatGptBrowserRunOptions {
  prompt: string;
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
  reasoningEffort?: string;
  conversationId?: string;
  isNewConversation?: boolean;
  timeoutMs?: number;
}

export interface ChatGptTurnResult {
  rawResponse: string;
  conversationId?: string;
}

export const CHATGPT_CONVERSATION_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;

export function isValidChatGptConversationId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  const trimmed = id.trim();
  return CHATGPT_CONVERSATION_ID_PATTERN.test(trimmed) && trimmed !== "local-chatgpt";
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
export class ChatGptBrowserWorker {
  /**
   * Cài đặt Clipboard Hook trên trang để đón lấy payload copy code trực tiếp
   */
  private async setupClipboardHook(page: Page): Promise<void> {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    await page.evaluate(() => {
      const win = window as any;
      win.__chatgpt_last_copied_code = null;
      const origWriteText = navigator.clipboard ? navigator.clipboard.writeText : null;
      if (navigator.clipboard) {
        navigator.clipboard.writeText = async (text: string) => {
          win.__chatgpt_last_copied_code = text;
          try {
            if (origWriteText) return await origWriteText.call(navigator.clipboard, text);
          } catch {
            return Promise.resolve();
          }
        };
      }
      const onCopy = (e: ClipboardEvent) => {
        const text = e.clipboardData?.getData("text/plain") || window.getSelection()?.toString();
        if (text) win.__chatgpt_last_copied_code = text;
      };
      document.addEventListener("copy", onCopy, { capture: true });
    });
  }

  /**
   * Nhập nội dung prompt vào ProseMirror editor an toàn bằng Plain-text Injection
   * để không bị kích hoạt Markdown parser tự động làm vỡ định dạng và ghi đè chữ
   */
  private async insertPromptSafely(page: Page, promptText: string): Promise<void> {
    console.log(`[chatgpt-worker] Đang nhập prompt an toàn (${promptText.length} ký tự)...`);

    await page.waitForSelector(CHATGPT_SELECTORS.composer, { timeout: 15_000, state: "visible" });

    // Focus vào composer
    const composerLocator = page.locator(CHATGPT_SELECTORS.composer).first();
    await composerLocator.click();

    // Plain-text injection qua DataTransfer paste kết hợp execCommand và fallback locator.fill
    await page.evaluate(
      ({ selector, text }) => {
        const editor = document.querySelector(selector) as HTMLElement | null;
        if (!editor) return false;

        editor.focus();

        // 1. Xóa nội dung cũ trong editor nếu có
        try {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(editor);
          sel?.removeAllRanges();
          sel?.addRange(range);
          document.execCommand("delete", false, undefined);
        } catch {
          editor.innerHTML = "";
        }

        // 2. Chèn qua DataTransfer paste event (ProseMirror handlePaste chính thức của ChatGPT)
        try {
          const dt = new DataTransfer();
          dt.setData("text/plain", text);
          editor.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
          );
        } catch {}

        // 3. Nếu DataTransfer paste chưa đưa đủ text vào DOM, thử execCommand
        const currentLen = (editor.textContent || "").trim().length;
        if (currentLen < text.trim().length * 0.8) {
          try {
            document.execCommand("insertText", false, text);
          } catch {}
        }

        // 4. Dispatch sự kiện input và change để ProseMirror và React đồng bộ state
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        editor.dispatchEvent(new Event("change", { bubbles: true }));

        return true;
      },
      { selector: CHATGPT_SELECTORS.composer, text: promptText }
    );

    // Kiểm tra độ dài nội dung thực tế trong editor
    const actualLength = await page.evaluate(
      (sel) => (document.querySelector(sel)?.textContent || "").trim().length,
      CHATGPT_SELECTORS.composer
    );

    // Nếu editor nhận thiếu ký tự (bị cắt xén), dùng fallback fill của Playwright để đảm bảo đủ 100%
    if (actualLength < promptText.trim().length * 0.8) {
      console.warn(`[chatgpt-worker] Editor chỉ nhận ${actualLength}/${promptText.trim().length} ký tự, kích hoạt Playwright fill để chèn đầy đủ 100%...`);
      await composerLocator.fill(promptText);
    }

    // Đợi 400ms để ProseMirror và React hoàn tất render và cập nhật trạng thái nút Send
    await page.waitForTimeout(400);
  }

  /**
   * Thực hiện gửi tin nhắn và xác nhận chắc chắn tin nhắn đã được gửi đi
   */
  private async submitPrompt(page: Page, signal?: AbortSignal): Promise<void> {
    console.log("[chatgpt-worker] Đang nhấn nút gửi...");

    const composerLocator = page.locator(CHATGPT_SELECTORS.composer).first();
    const sendBtn = page.locator(CHATGPT_SELECTORS.sendButton).first();

    // Chờ tối đa 3s cho nút Send xuất hiện và enabled
    let canClickSend = false;
    try {
      await sendBtn.waitFor({ state: "visible", timeout: 3000 });
      canClickSend = await sendBtn.isEnabled({ timeout: 1000 }).catch(() => false);
    } catch {
      canClickSend = false;
    }

    if (canClickSend) {
      await sendBtn.click().catch(() => {});
    } else {
      console.log("[chatgpt-worker] Nút gửi chưa enabled, nhấn Enter trên composer...");
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

          const editor = document.querySelector(composerSelector);
          const text = (editor?.textContent || "").trim();
          // Nếu editor đã trống hoặc placeholder xuất hiện trở lại
          return text.length === 0;
        },
        { stopSelector: CHATGPT_SELECTORS.stopButton, composerSelector: CHATGPT_SELECTORS.composer }
      );

      if (isSubmitted) {
        console.log("[chatgpt-worker] Tin nhắn đã được gửi thành công!");
        return;
      }

      await page.waitForTimeout(200);
    }

    console.warn("[chatgpt-worker] Hết thời gian chờ xác nhận gửi, tiếp tục theo dõi phản hồi...");
  }

  /**
   * Đọc nội dung phản hồi stream hiện tại từ DOM
   */
  private async readLatestAssistantStreamText(page: Page): Promise<string> {
    return await page.evaluate(
      ({ assistantSelector, codeBlockSelector }) => {
        const messages = Array.from(document.querySelectorAll(assistantSelector));
        if (messages.length === 0) return "";
        const latestMsg = messages[messages.length - 1] as HTMLElement;

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
      }
    );
  }

  /**
   * Trích xuất kết quả hoàn chỉnh qua cơ chế Copy-Salvage (Clipboard Hook)
   */
  private async extractCompletedResponse(page: Page): Promise<string> {
    console.log("[chatgpt-worker] [copy-salvage] Đang tìm và click nút Copy code...");

    // Cố gắng click nút "Copy code" của code block trong tin nhắn cuối
    const clicked = await page.evaluate(
      ({ assistantSelector, copyCodeSelector, copyMessageSelector }) => {
        const win = window as any;
        win.__chatgpt_last_copied_code = null;

        const messages = Array.from(document.querySelectorAll(assistantSelector));
        const latestMsg = messages[messages.length - 1] as HTMLElement | null;
        if (!latestMsg) return false;

        // 1. Ưu tiên nút "Copy code"
        let copyBtn = latestMsg.querySelector(copyCodeSelector) as HTMLElement | null;
        if (!copyBtn) {
          // 2. Fallback: nút "Copy" toàn bộ tin nhắn
          copyBtn = latestMsg.querySelector(copyMessageSelector) as HTMLElement | null;
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
        assistantSelector: CHATGPT_SELECTORS.assistantMessage,
        copyCodeSelector: CHATGPT_SELECTORS.copyCodeButton,
        copyMessageSelector: CHATGPT_SELECTORS.copyMessageButton,
      }
    );

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

    console.warn("[chatgpt-worker] [copy-salvage] Không bắt được từ Clipboard, fallback trích xuất DOM text...");
    return await this.readLatestAssistantStreamText(page);
  }

  /**
   * Thực thi một lượt gửi câu hỏi và nhận câu trả lời từ ChatGPT Web
   */
  public async executeTurn(
    page: Page,
    options: ChatGptBrowserRunOptions
  ): Promise<ChatGptTurnResult> {
    const { prompt, onChunk, signal, reasoningEffort, conversationId, isNewConversation, timeoutMs = 180_000 } = options;
    let currentConversationId = isValidChatGptConversationId(conversationId) ? conversationId : undefined;

    if (signal?.aborted) {
      throw new DOMException("ChatGpt turn aborted before start", "AbortError");
    }

    // 1. Quản lý URL & Điều hướng chuẩn xác như M365 Copilot
    const currentUrl = page.url();
    if (isNewConversation) {
      // CHỈ KHI LÀ LƯỢT ĐẦU TIÊN CỦA PHIÊN MỚI: Điều hướng về https://chatgpt.com/ để mở thread mới
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
      // CÁC LƯỢT TIẾP THEO CỦA CÙNG CUỘC TRÒ CHUYỆN:
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
      } else {
        // Nếu chưa lưu conversationId nhưng tab đang ở sẵn /c/<id>, TUYỆT ĐỐI GIỮ NGUYÊN!
        if (currentUrl.includes("/c/")) {
          console.log(`[chatgpt-worker] Giữ nguyên tab cuộc hội thoại hiện tại (${currentUrl}), không mở chat mới.`);
        }
      }
    }

    // Chờ ô soạn thảo xuất hiện
    await page.waitForSelector(CHATGPT_SELECTORS.composer, { timeout: 20_000, state: "visible" });

    // 2. Thiết lập chế độ Thinking theo cấu hình
    if (reasoningEffort) {
      await ensureChatGptThinkingMode(page, { reasoningEffort });
    }

    // 3. Cài đặt Clipboard Hook
    await this.setupClipboardHook(page);

    // 4. Nhập prompt an toàn
    await this.insertPromptSafely(page, prompt);

    // 5. Gửi prompt
    await this.submitPrompt(page, signal);

    // 6. Theo dõi sinh phản hồi (Streaming & Polling)
    console.log("[chatgpt-worker] Đang theo dõi ChatGPT trả lời...");
    const startTime = Date.now();
    let lastRenderedText = "";
    let isStreaming = true;

    // Đợi tối đa 10s để xem nút Stop có xuất hiện không
    await page.waitForSelector(CHATGPT_SELECTORS.stopButton, { timeout: 10_000 }).catch(() => {});

    while (isStreaming) {
      if (signal?.aborted) {
        const stopBtn = await page.$(CHATGPT_SELECTORS.stopButton);
        if (stopBtn) await stopBtn.click().catch(() => {});
        throw new DOMException("ChatGpt turn aborted during execution", "AbortError");
      }

      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`[chatgpt-worker] Quá thời gian chờ phản hồi (${timeoutMs}ms).`);
      }

      // Đọc stream text
      const currentText = await this.readLatestAssistantStreamText(page);
      if (currentText.length > lastRenderedText.length) {
        const delta = currentText.slice(lastRenderedText.length);
        if (onChunk) {
          onChunk(delta);
        }
        lastRenderedText = currentText;
      }

      // Kiểm tra trạng thái hoàn tất:
      // Tín hiệu 1: Nút "Stop" biến mất VÀ Nút "Start Voice" xuất hiện (theo HTML thực tế)
      // Tín hiệu 2: Nút "Stop" biến mất VÀ Nút "Copy code" xuất hiện
      const completionCheck = await page.evaluate(
        ({ stopSel, startVoiceSel, copyCodeSel }) => {
          const stopBtn = document.querySelector(stopSel);
          if (stopBtn) return { done: false, hasStop: true };

          const startVoiceBtn = document.querySelector(startVoiceSel);
          const copyCodeBtn = document.querySelector(copyCodeSel);

          if (startVoiceBtn || copyCodeBtn) {
            return { done: true, hasStop: false };
          }

          return { done: false, hasStop: false };
        },
        {
          stopSel: CHATGPT_SELECTORS.stopButton,
          startVoiceSel: CHATGPT_SELECTORS.startVoiceButton,
          copyCodeSel: CHATGPT_SELECTORS.copyCodeButton,
        }
      );

      if (completionCheck.done && lastRenderedText.length > 0) {
        console.log("[chatgpt-worker] Phát hiện tín hiệu hoàn tất (nút Stop biến mất, Start Voice/Copy xuất hiện).");
        // Chờ thêm 500ms để DOM ổn định hoàn toàn
        await page.waitForTimeout(500);
        isStreaming = false;
        break;
      }

      // Nếu không có nút Stop và đã có text nhưng chưa thấy Start Voice, chờ thêm chút
      if (!completionCheck.hasStop && lastRenderedText.length > 0) {
        const idleDeadline = Date.now() + 2000;
        let isStillIdle = true;
        while (Date.now() < idleDeadline) {
          await page.waitForTimeout(300);
          const checkText = await this.readLatestAssistantStreamText(page);
          if (checkText !== lastRenderedText) {
            isStillIdle = false;
            break;
          }
        }
        if (isStillIdle) {
          console.log("[chatgpt-worker] Phản hồi đã dừng stream ổn định.");
          isStreaming = false;
          break;
        }
      }

      // Theo dõi xem ChatGPT đã đổi URL sang /c/<id> chưa
      if (!currentConversationId) {
        currentConversationId = extractConversationIdFromUrl(page.url());
      }

      await page.waitForTimeout(250);
    }

    // 7. Trích xuất phản hồi hoàn chỉnh bằng Copy-Salvage
    const rawResponse = await this.extractCompletedResponse(page);

    // 8. Trích xuất conversation ID từ URL sau khi hoàn thành lượt
    const immediateUrlId = extractConversationIdFromUrl(page.url());
    if (immediateUrlId) {
      currentConversationId = immediateUrlId;
    }

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
      : (isValidChatGptConversationId(conversationId) ? conversationId : undefined);
    console.log(`[chatgpt-worker] Lượt hoàn tất thành công. URL: ${page.url()}, Conversation ID: ${finalConversationId || "chưa xác định"}`);

    return {
      rawResponse,
      conversationId: finalConversationId,
    };
  }
}
