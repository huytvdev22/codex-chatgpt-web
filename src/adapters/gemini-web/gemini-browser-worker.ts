import type { Page } from "playwright-core";
import { GEMINI_SELECTORS, type GeminiDomSelectors } from "./selectors";
import { ensureGeminiCapabilityMode } from "./capability-picker";

export interface GeminiBrowserRunOptions {
  prompt: string;
  onChunk: (text: string) => void;
  signal?: AbortSignal;
  modelSlug?: string;
  reasoningEffort?: "low" | "medium" | "high";
  customSelectors?: Partial<GeminiDomSelectors>;
  timeoutMs?: number;
}

export interface GeminiTurnResult {
  rawResponse: string;
}

/**
 * Worker điều khiển trình duyệt Playwright tương tác với Google Gemini Web.
 * Thiết kế gọn nhẹ, tập trung vào các hành động đặc thù của giao diện Gemini.
 */
export class GeminiBrowserWorker {
  private selectors: GeminiDomSelectors;

  constructor(customSelectors?: Partial<GeminiDomSelectors>) {
    this.selectors = { ...GEMINI_SELECTORS, ...customSelectors };
  }

  /**
   * Cập nhật các selector khi nhận được thông tin mới từ người dùng
   */
  updateSelectors(newSelectors: Partial<GeminiDomSelectors>): void {
    this.selectors = { ...this.selectors, ...newSelectors };
  }

  /**
   * Thực thi một lượt gửi câu hỏi và nhận câu trả lời từ Gemini Web
   */
  async executeTurn(
    page: Page,
    options: GeminiBrowserRunOptions
  ): Promise<GeminiTurnResult> {
    const { prompt, onChunk, signal, timeoutMs = 120_000 } = options;

    if (signal?.aborted) {
      throw new DOMException("Gemini turn aborted before start", "AbortError");
    }

    // 1. Kiểm tra trang hiện tại
    const currentUrl = page.url();
    if (!currentUrl.includes("gemini.google.com")) {
      console.log("[gemini-worker] Điều hướng đến https://gemini.google.com/app...");
      await page.goto("https://gemini.google.com/app", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    }

    // 2. Tự động chọn đúng Model và Thinking level
    if (options.modelSlug) {
      await ensureGeminiCapabilityMode(page, {
        modelSlug: options.modelSlug,
        reasoningEffort: options.reasoningEffort,
        selectors: this.selectors,
      });
    }

    // 3. Tìm ô nhập tin nhắn
    console.log("[gemini-worker] Đang tìm ô nhập liệu (editor)...");
    const editor = await page.waitForSelector(this.selectors.editor, {
      timeout: 15_000,
      state: "visible",
    }).catch(() => null);

    if (!editor) {
      throw new Error(
        `[GEMINI_SELECTOR_ERROR] Không tìm thấy ô nhập tin nhắn với selector: "${this.selectors.editor}". Vui lòng kiểm tra lại giao diện Gemini Web.`
      );
    }

    // 3. Nhập Prompt vào editor
    console.log(`[gemini-worker] Đang nhập prompt (${prompt.length} ký tự)...`);
    await editor.click();
    // Với nội dung dài, ưu tiên dùng clipboard hoặc set innerText/textContent để tránh giật
    try {
      await page.evaluate(({ selector, text }: { selector: string; text: string }) => {
        const el = document.querySelector(selector);
        if (el) {
          if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
            (el as HTMLInputElement).value = text;
            el.dispatchEvent(new Event("input", { bubbles: true }));
          } else {
            // Contenteditable (p hoặc div)
            el.textContent = text;
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
      }, { selector: this.selectors.editor, text: prompt });
    } catch {
      await editor.fill(prompt);
    }

    // Đợi 300ms để nút send chuyển sang trạng thái enabled
    await page.waitForTimeout(300);

    // Cài đặt Clipboard Window Hook trước khi gửi để đón nhận nội dung khi click nút copy
    await page.evaluate(() => {
      const win = window as any;
      win.__gemini_last_copied_code = null;
      const origWriteText = navigator.clipboard ? navigator.clipboard.writeText : null;
      if (navigator.clipboard) {
        navigator.clipboard.writeText = async (text: string) => {
          win.__gemini_last_copied_code = text;
          try {
            if (origWriteText) return await origWriteText.call(navigator.clipboard, text);
          } catch {
            return Promise.resolve();
          }
        };
      }
      const onCopy = (e: ClipboardEvent) => {
        const text = e.clipboardData?.getData("text/plain") || window.getSelection()?.toString();
        if (text) win.__gemini_last_copied_code = text;
      };
      document.addEventListener("copy", onCopy, { capture: true });
    });

    // 4. Nhấn nút Gửi
    console.log("[gemini-worker] Đang nhấn nút gửi...");
    const sendBtn = await page.$(this.selectors.sendButton);
    if (sendBtn) {
      await sendBtn.click();
    } else {
      // Fallback: Gửi phím Enter nếu không tìm thấy nút gửi
      console.warn("[gemini-worker] Không tìm thấy nút gửi, thử phím Enter...");
      await page.keyboard.press("Enter");
    }

    // 5. Lắng nghe phản hồi (Streaming & Completion)
    console.log("[gemini-worker] Đang chờ Gemini phản hồi...");
    const startTime = Date.now();
    let lastRenderedText = "";
    let isStreaming = true;

    // Đợi tối đa 10s để trạng thái streaming bắt đầu xuất hiện
    await page.waitForSelector(this.selectors.stopButton, { timeout: 10_000 }).catch(() => {
      // Nếu câu trả lời quá ngắn, có thể nút Stop không kịp xuất hiện
    });

    while (isStreaming) {
      if (signal?.aborted) {
        // Cố gắng bấm nút Stop nếu bị hủy
        const stopBtn = await page.$(this.selectors.stopButton);
        if (stopBtn) await stopBtn.click().catch(() => {});
        throw new DOMException("Gemini turn aborted during execution", "AbortError");
      }

      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`[gemini-worker] Quá thời gian chờ phản hồi (${timeoutMs}ms).`);
      }

      // Đọc nội dung phản hồi mới nhất
      const currentText = await page.evaluate(({
        containerSel,
        thinkingSel,
        codeSel,
        headerSel,
      }: {
        containerSel: string;
        thinkingSel?: string;
        codeSel?: string;
        headerSel?: string;
      }) => {
        const containers = Array.from(document.querySelectorAll(containerSel));
        if (containers.length === 0) return "";
        const latest = containers[containers.length - 1] as HTMLElement;

        // 1. Ưu tiên kiểm tra xem bên trong có code block chứa response envelope không
        if (codeSel) {
          const codeEls = Array.from(latest.querySelectorAll(codeSel));
          for (const codeEl of codeEls) {
            const text = (codeEl.textContent || "").trim();
            if (
              text.includes("<webResponse>") ||
              text.includes("<m365Response>") ||
              text.includes("<tool_call>") ||
              text.includes("<custom_tool_call")
            ) {
              return text;
            }
          }
        }

        // 2. Clone element để loại bỏ khối suy nghĩ và các header/button trang trí của code block
        const clone = latest.cloneNode(true) as HTMLElement;
        if (thinkingSel) {
          clone.querySelectorAll(thinkingSel).forEach((el) => el.remove());
        }
        if (headerSel) {
          clone.querySelectorAll(headerSel).forEach((el) => el.remove());
        }

        return (clone.innerText || clone.textContent || "").trim();
      }, {
        containerSel: this.selectors.responseContainer,
        thinkingSel: this.selectors.thinkingBlock,
        codeSel: this.selectors.codeContainer,
        headerSel: this.selectors.codeBlockHeader,
      });

      // Phát delta nếu có chữ mới
      if (currentText.length > lastRenderedText.length) {
        const delta = currentText.slice(lastRenderedText.length);
        onChunk(delta);
        lastRenderedText = currentText;
      }

      // Kiểm tra xem đã hoàn thành chưa:
      // Dấu hiệu 1: Nút Stop không còn trên DOM
      const stopBtnExists = await page.$(this.selectors.stopButton);
      // Dấu hiệu 2: Nút Copy xuất hiện ở message cuối
      const copyBtnExists = this.selectors.copyButton ? await page.$(this.selectors.copyButton) : null;

      if (!stopBtnExists && (copyBtnExists || lastRenderedText.length > 0)) {
        // Đợi thêm 500ms để đảm bảo text đã render hết
        await page.waitForTimeout(500);
        isStreaming = false;
        break;
      }

      await page.waitForTimeout(150);
    }

    console.log(`[gemini-worker] Quá trình sinh phản hồi kết thúc. Bắt đầu trích xuất đa tầng...`);

    // TẦNG 1: Trích xuất bằng cách Click nút Copy (Copy-Salvage)
    let extractedText: string | null = null;
    try {
      console.log("[gemini-worker] [copy-salvage] Đang tìm và click nút Copy (Sao chép mã)...");
      const copyClicked = await page.evaluate(({
        codeCopySel,
        copySel,
      }: {
        codeCopySel?: string;
        copySel?: string;
      }) => {
        const win = window as any;
        win.__gemini_last_copied_code = null;

        const containers = Array.from(document.querySelectorAll("model-response, message-content"));
        const latest = containers[containers.length - 1];
        if (!latest) return false;

        // 1. Ưu tiên nút Sao chép mã của code block
        let copyBtn = codeCopySel ? (latest.querySelector(codeCopySel) as HTMLElement | null) : null;
        if (!copyBtn && copySel) {
          copyBtn = latest.querySelector(copySel) as HTMLElement | null;
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
      }, {
        codeCopySel: this.selectors.codeCopyButton,
        copySel: this.selectors.copyButton,
      });

      if (copyClicked) {
        const readStart = Date.now();
        while (Date.now() - readStart < 2000) {
          await page.waitForTimeout(100);
          const text = await page.evaluate(async () => {
            const win = window as any;
            if (typeof win.__gemini_last_copied_code === "string" && win.__gemini_last_copied_code.trim().length > 0) {
              return win.__gemini_last_copied_code.trim();
            }
            try {
              if (navigator.clipboard && typeof navigator.clipboard.readText === "function") {
                const sys = await navigator.clipboard.readText();
                if (sys && sys.trim().length > 0) return sys.trim();
              }
            } catch {}
            return null;
          });

          if (text) {
            extractedText = text;
            console.log(`[gemini-worker] [copy-salvage] THÀNH CÔNG: Đã lấy được nội dung qua nút Copy (${text.length} ký tự).`);
            break;
          }
        }
      }
    } catch (err) {
      console.warn("[gemini-worker] [copy-salvage] Lỗi khi click nút copy:", err);
    }

    // TẦNG 2: Fallback đọc từ DOM nếu Tầng 1 không bắt được
    if (!extractedText) {
      console.log("[gemini-worker] [fallback] Sử dụng nội dung trích xuất từ DOM.");
      extractedText = lastRenderedText;
    }

    const normalizedRaw = ensureMarkdownTransportFence(extractedText);
    return {
      rawResponse: normalizedRaw,
    };
  }
}

/**
 * Đảm bảo bọc trọn vẹn trong transport wrapper 4-backtick markdown cho strict-parser
 */
export function ensureMarkdownTransportFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (/^````markdown[ \t]*\r?\n[\s\S]*\r?\n````$/.test(trimmed)) {
    return trimmed;
  }
  return `\`\`\`\`markdown\n${trimmed}\n\`\`\`\``;
}

export const geminiBrowserWorker = new GeminiBrowserWorker();
