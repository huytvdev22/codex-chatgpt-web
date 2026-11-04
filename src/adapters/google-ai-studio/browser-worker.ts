import type { Page } from "playwright-core";
import {
  AI_STUDIO_SELECTORS,
  GOOGLE_AI_STUDIO_NEW_CHAT_URL,
  buildGoogleAIStudioPromptUrl,
  parseGoogleAIStudioPromptId,
  type GoogleAIStudioDomSelectors,
} from "./selectors";
import { ensureGoogleAIStudioThinkingLevel } from "./capability-picker";

export interface GoogleAIStudioBrowserRunOptions {
  prompt: string;
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
  reasoningEffort?: string;
  promptId?: string;
  isNewConversation?: boolean;
  timeoutMs?: number;
}

export interface GoogleAIStudioTurnResult {
  rawResponse: string;
  promptId?: string;
}

/**
 * Worker điều khiển trình duyệt Playwright tương tác với Google AI Studio (aistudio.google.com).
 * Bám sát cấu trúc của Browser Worker trong M365 Copilot và Qwen Web.
 */
export class GoogleAIStudioBrowserWorker {
  private selectors: GoogleAIStudioDomSelectors;

  constructor(customSelectors?: Partial<GoogleAIStudioDomSelectors>) {
    this.selectors = { ...AI_STUDIO_SELECTORS, ...customSelectors };
  }

  /**
   * Đảm bảo trình duyệt đang ở đúng URL đích (New Chat với model param hoặc tiếp tục Prompt ID cũ)
   */
  public async ensureTargetPage(
    page: Page,
    options: { promptId?: string; isNewConversation?: boolean }
  ): Promise<void> {
    const currentUrl = page.url();
    const currentPromptId = parseGoogleAIStudioPromptId(currentUrl);

    if (!options.isNewConversation && options.promptId) {
      if (currentPromptId === options.promptId) {
        console.log(`[ai-studio-worker] Đang ở sẵn trang hội thoại promptId: ${options.promptId}`);
        return;
      }
      const targetUrl = buildGoogleAIStudioPromptUrl(options.promptId);
      console.log(`[ai-studio-worker] Điều hướng đến hội thoại cũ: ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return;
    }

    // Hội thoại mới: Mở URL New Chat với model mặc định
    if (!currentUrl.includes("aistudio.google.com") || (!options.promptId && currentPromptId)) {
      console.log(`[ai-studio-worker] Điều hướng đến phiên tạo mới: ${GOOGLE_AI_STUDIO_NEW_CHAT_URL}`);
      await page.goto(GOOGLE_AI_STUDIO_NEW_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
  }

  /**
   * Nhập nội dung prompt vào ô textarea an toàn bằng OS Clipboard Paste kết hợp sự kiện Angular/DOM
   */
  private async insertPromptSafely(page: Page, promptText: string): Promise<void> {
    console.log(`[ai-studio-worker] Đang nhập prompt an toàn (${promptText.length} ký tự)...`);

    // Chờ ô composer hiển thị
    const composer = await page.waitForSelector(this.selectors.composer, {
      timeout: 15_000,
      state: "visible",
    }).catch(() => null);

    if (!composer) {
      // Fallback selector nếu giao diện thay đổi
      const fallback = await page.waitForSelector(this.selectors.composerFallback, {
        timeout: 5_000,
        state: "visible",
      }).catch(() => null);
      if (!fallback) {
        throw new Error(`[AI_STUDIO_SELECTOR_ERROR] Không tìm thấy ô nhập prompt trên Google AI Studio.`);
      }
    }

    const composerLocator = page.locator(this.selectors.composer).first();
    await composerLocator.click();

    // 1. Xóa nội dung cũ nếu có
    const isMac = process.platform === "darwin";
    const selectAllKey = isMac ? "Meta+a" : "Control+a";
    await page.keyboard.press(selectAllKey);
    await page.keyboard.press("Backspace");

    // 2. Ghi prompt vào Clipboard
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
      // Dán bằng phím tắt Native
      const pasteKey = isMac ? "Meta+v" : "Control+v";
      await page.keyboard.press(pasteKey);
    } else {
      // Fallback: tiêm giá trị trực tiếp và kích hoạt sự kiện input
      console.warn("[ai-studio-worker] Fallback tiêm giá trị trực tiếp vào textarea...");
      await page.evaluate(
        ({ sel, text }) => {
          const ta = document.querySelector(sel) as HTMLTextAreaElement | null;
          if (ta) {
            ta.focus();
            ta.value = text;
            ta.dispatchEvent(new Event("input", { bubbles: true }));
            ta.dispatchEvent(new Event("change", { bubbles: true }));
          }
        },
        { sel: this.selectors.composer, text: promptText }
      );
    }

    await page.waitForTimeout(300);

    // Kích hoạt thêm sự kiện input để Angular Change Detection nhận diện và enable nút Run
    await page.evaluate((sel) => {
      const ta = document.querySelector(sel) as HTMLTextAreaElement | null;
      if (ta) {
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, this.selectors.composer);
  }

  /**
   * Nhấn nút Run (hoặc phím tắt Control+Enter) và xác nhận tin nhắn đã được gửi
   */
  private async submitPrompt(page: Page, signal?: AbortSignal): Promise<void> {
    console.log("[ai-studio-worker] Đang kích hoạt lệnh Run...");

    const runBtn = page.locator(this.selectors.runButton).first();
    let canClickRun = false;
    try {
      await runBtn.waitFor({ state: "visible", timeout: 3000 });
      canClickRun = await runBtn.isEnabled({ timeout: 1000 }).catch(() => false);
    } catch {
      canClickRun = false;
    }

    if (canClickRun) {
      await runBtn.click().catch(() => {});
    } else {
      // Dùng phím tắt chuẩn của Google AI Studio: Ctrl+Enter
      console.log("[ai-studio-worker] Nút Run chưa enabled, nhấn phím tắt Control+Enter...");
      const composerLocator = page.locator(this.selectors.composer).first();
      await composerLocator.press("Control+Enter").catch(() => {});
    }

    // Vòng lặp xác nhận đã gửi: Chờ nút Stop xuất hiện hoặc composer sạch
    const submitDeadline = Date.now() + 10_000;
    while (Date.now() < submitDeadline) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const isSubmitted = await page.evaluate(
        ({ stopSel, composerSel }) => {
          const genericBtn = document.querySelector('ms-run-button button');
          if (genericBtn && (genericBtn.classList.contains('stoppable') || (genericBtn.textContent || '').includes('Stop'))) {
            return true;
          }
          const ta = document.querySelector(composerSel) as HTMLTextAreaElement | null;
          return ta ? ta.value.trim().length === 0 : false;
        },
        { stopSel: this.selectors.stopButton, composerSel: this.selectors.composer }
      );

      if (isSubmitted) {
        console.log("[ai-studio-worker] Tin nhắn đã được gửi thành công sang Google AI Studio!");
        return;
      }

      await page.waitForTimeout(200);
    }

    console.warn("[ai-studio-worker] Hết thời gian chờ xác nhận gửi, tiếp tục theo dõi phản hồi...");
  }

  /**
   * Đọc phản hồi mới nhất từ DOM, loại bỏ toàn bộ ms-thought-chunk (đúng chuẩn M365)
   */
  private async readLatestCleanResponse(page: Page): Promise<string> {
    return await page.evaluate(
      ({ textChunkSel, thoughtChunkSel, fallbackSel }) => {
        const textElements = Array.from(document.querySelectorAll(textChunkSel));
        if (textElements.length > 0) {
          // Lọc bỏ toàn bộ chunk nằm bên trong ms-thought-chunk
          const clean = textElements.filter((el) => !el.closest(thoughtChunkSel));
          return clean.map((el) => el.textContent || "").join("\n").trim();
        }

        const fallbackElements = Array.from(document.querySelectorAll(fallbackSel));
        if (fallbackElements.length > 0) {
          return fallbackElements.map((el) => el.textContent || "").join("\n").trim();
        }

        return "";
      },
      {
        textChunkSel: this.selectors.textChunk,
        thoughtChunkSel: this.selectors.thoughtChunk,
        fallbackSel: this.selectors.outputChunkFallback,
      }
    );
  }

  /**
   * Thực thi một lượt gửi câu hỏi và nhận câu trả lời từ Google AI Studio
   */
  public async executeTurn(
    page: Page,
    options: GoogleAIStudioBrowserRunOptions
  ): Promise<GoogleAIStudioTurnResult> {
    const { prompt, onChunk, signal, timeoutMs = 180_000 } = options;

    if (signal?.aborted) {
      throw new DOMException("Google AI Studio turn aborted before start", "AbortError");
    }

    // 1. Điều hướng đến đúng URL
    await this.ensureTargetPage(page, {
      promptId: options.promptId,
      isNewConversation: options.isNewConversation,
    });

    // 2. Thiết lập Thinking Level nếu được chỉ định
    if (options.reasoningEffort) {
      await ensureGoogleAIStudioThinkingLevel(page, {
        level: options.reasoningEffort,
        selectors: this.selectors,
      });
    }

    // 3. Nhập prompt an toàn
    await this.insertPromptSafely(page, prompt);

    // 4. Bấm Run / Gửi prompt
    await this.submitPrompt(page, signal);

    // 5. Theo dõi stream câu trả lời và chờ hoàn tất
    console.log("[ai-studio-worker] Bắt đầu theo dõi stream câu trả lời...");
    let lastEmittedLength = 0;
    let stableCount = 0;
    let fullResponse = "";
    const startTime = Date.now();
    const pollInterval = 300;

    while (Date.now() - startTime < timeoutMs) {
      if (signal?.aborted) {
        throw new DOMException("Google AI Studio turn aborted during streaming", "AbortError");
      }

      // Đọc trạng thái model đang sinh câu trả lời
      const isGenerating = await page.evaluate(() => {
        const btn = document.querySelector('ms-run-button button');
        return btn ? (btn.classList.contains('stoppable') || (btn.textContent || '').includes('Stop')) : false;
      });

      // Đọc văn bản sạch hiện tại
      const currentText = await this.readLatestCleanResponse(page);

      if (currentText.length > lastEmittedLength) {
        const delta = currentText.slice(lastEmittedLength);
        lastEmittedLength = currentText.length;
        fullResponse = currentText;
        stableCount = 0;
        if (onChunk) onChunk(delta);
      } else if (currentText.length > 0 && currentText.length === lastEmittedLength) {
        stableCount++;
      }

      // Khi model không còn ở trạng thái Generating (nút Stop đã biến mất)
      if (!isGenerating && fullResponse.length > 0) {
        // Chờ văn bản ổn định trong 2 nhịp (600ms) để đảm bảo render DOM xong
        if (stableCount >= 2) {
          console.log(`[ai-studio-worker] Model đã sinh xong hoàn tất (${fullResponse.length} ký tự).`);
          break;
        }
      }

      await page.waitForTimeout(pollInterval);
    }

    // 6. Kiểm tra xem URL có thay đổi và có Prompt ID mới không
    const finalUrl = page.url();
    const detectedPromptId = parseGoogleAIStudioPromptId(finalUrl);

    return {
      rawResponse: fullResponse,
      promptId: detectedPromptId,
    };
  }
}

export const googleAIStudioBrowserWorker = new GoogleAIStudioBrowserWorker();

