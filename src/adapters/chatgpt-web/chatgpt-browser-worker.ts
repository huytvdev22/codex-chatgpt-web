import type { Page } from "playwright-core";
import { CHATGPT_SELECTORS, type ChatGptDomSelectors } from "./selectors";
import { ensureChatGptModelAndEffort } from "./capability-picker";

export interface ChatGptTurnExecutionOptions {
  prompt: string;
  signal?: AbortSignal;
  modelSlug?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  customSelectors?: Partial<ChatGptDomSelectors>;
  onChunk?: (chunk: string) => void;
  timeoutMs?: number;
}

export interface ChatGptTurnResult {
  rawResponse: string;
  isCompleted: boolean;
}

/**
 * Đảm bảo câu trả lời thô được bọc trọn vẹn trong khối ````markdown ... ````
 * để tương thích hoàn toàn với bộ phân tích nghiêm ngặt parseStrictM365Response.
 */
export function ensureMarkdownTransportFence(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("````markdown") && trimmed.endsWith("````")) {
    return trimmed;
  }
  if (trimmed.startsWith("```markdown") && trimmed.endsWith("```")) {
    const inner = trimmed.slice("```markdown".length, -3).trim();
    return `\`\`\`\`markdown\n${inner}\n\`\`\`\``;
  }
  return `\`\`\`\`markdown\n${trimmed}\n\`\`\`\``;
}

export class ChatGptBrowserWorker {
  private selectors: ChatGptDomSelectors;

  constructor(selectors: ChatGptDomSelectors = CHATGPT_SELECTORS) {
    this.selectors = selectors;
  }

  /**
   * Thực thi một lượt trao đổi hoàn chỉnh trên ChatGPT Web
   */
  async executeTurn(page: Page, options: ChatGptTurnExecutionOptions): Promise<ChatGptTurnResult> {
    const { prompt, signal, modelSlug, reasoningEffort, timeoutMs = 180_000 } = options;

    if (signal?.aborted) {
      throw new DOMException("ChatGpt turn aborted before start", "AbortError");
    }

    // 1. Chờ khung nhập prompt sẵn sàng
    console.log("[chatgpt-worker] Đang chờ khung soạn thảo prompt...");
    const composerLocator = page.locator(this.selectors.composerInput).filter({ visible: true }).first();
    await composerLocator.waitFor({ state: "visible", timeout: 30_000 });

    // 2. Cấu hình Model & Cấp độ tư duy (Kế thừa từ adapter cũ)
    await ensureChatGptModelAndEffort(page, {
      modelSlug,
      reasoningEffort,
      customSelectors: options.customSelectors,
    });

    // 3. Cài đặt Clipboard Hook đón nhận payload từ nút "Copy code" (Tầng 1 Copy Button Salvage)
    await page.evaluate(() => {
      const win = window as any;
      win.__chatgpt_last_copied_code = null;

      if (navigator.clipboard) {
        const originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = (text: string) => {
          win.__chatgpt_last_copied_code = text;
          try {
            return originalWriteText(text);
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

    // 4. Nhập prompt vào khung soạn thảo
    console.log(`[chatgpt-worker] Đang nhập prompt (${prompt.length} ký tự)...`);
    await composerLocator.click();

    // Dọn dẹp văn bản cũ nếu có
    await page.keyboard.press("Meta+A").catch(() => page.keyboard.press("Control+A"));
    await page.keyboard.press("Backspace");

    // Điền prompt qua insertText để kích hoạt các event Lexical/React tự nhiên
    await page.keyboard.insertText(prompt);
    await page.waitForTimeout(200);

    // Ghi nhận số lượng turn và nút copy ban đầu trước khi gửi
    const initialTurnCount = await page.locator(this.selectors.responseContainer).count();
    const initialCodeCopyCount = await page.locator(this.selectors.codeCopyButton).count();
    console.log(`[chatgpt-worker] Số lượng turn trước khi gửi: ${initialTurnCount}, code copy: ${initialCodeCopyCount}`);

    // 5. Nhấn nút Gửi
    console.log("[chatgpt-worker] Đang nhấn nút gửi...");
    const sendBtn = page.locator(this.selectors.sendButton).filter({ visible: true }).first();
    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click();
    } else {
      console.log("[chatgpt-worker] Không tìm thấy nút gửi, dùng phím Enter...");
      await page.keyboard.press("Enter");
    }

    // 6. Theo dõi Streaming & Completion
    console.log("[chatgpt-worker] Đang chờ ChatGPT bắt đầu trả lời...");
    const startTime = Date.now();
    let streamStarted = false;
    let lastRenderedText = "";

    // Chờ tối đa 30s để nút stop xuất hiện hoặc lượt mới thực sự xuất hiện
    const startDeadline = Date.now() + 30_000;
    while (Date.now() < startDeadline) {
      if (signal?.aborted) throw new DOMException("ChatGpt turn aborted", "AbortError");

      const stopBtn = page.locator(this.selectors.stopButton).filter({ visible: true }).first();
      const hasStop = await stopBtn.isVisible().catch(() => false);
      if (hasStop) {
        streamStarted = true;
        break;
      }

      const currentTurnCount = await page.locator(this.selectors.responseContainer).count();
      if (currentTurnCount > initialTurnCount) {
        streamStarted = true;
        break;
      }

      await page.waitForTimeout(300);
    }

    console.log("[chatgpt-worker] Phản hồi đang được sinh. Bắt đầu theo dõi hoàn tất...");

    // Polling cho tới khi streaming kết thúc
    const maxDeadline = Date.now() + timeoutMs;
    let consecutiveIdleCount = 0;

    while (Date.now() < maxDeadline) {
      if (signal?.aborted) throw new DOMException("ChatGpt turn aborted", "AbortError");

      const currentTurnCount = await page.locator(this.selectors.responseContainer).count();

      // Đọc nội dung từ lượt MỚI để theo dõi tiến độ
      if (currentTurnCount > initialTurnCount) {
        try {
          const newTurn = page.locator(this.selectors.responseContainer).nth(currentTurnCount - 1);
          if (await newTurn.isVisible().catch(() => false)) {
            const currentText = await newTurn.innerText();
            if (currentText && currentText.length > 0) {
              if (currentText === lastRenderedText) {
                consecutiveIdleCount++;
              } else {
                consecutiveIdleCount = 0;
                lastRenderedText = currentText;
              }
            }
          }
        } catch {}
      }

      // Kiểm tra nút Stop còn hiển thị không
      const stopBtn = page.locator(this.selectors.stopButton).filter({ visible: true }).first();
      const isGenerating = await stopBtn.isVisible().catch(() => false);

      // Kiểm tra nút hoàn tất của lượt mới
      const completeAction = page.locator(this.selectors.completionAction).filter({ visible: true }).last();
      const hasCompleteAction = await completeAction.isVisible().catch(() => false);

      // Điều kiện hoàn thành:
      // 1. Phải có turn mới (currentTurnCount > initialTurnCount) hoặc streamStarted
      // 2. Không còn nút Stop
      // 3. Có nút hoàn thành HOẶC nội dung lượt mới không thay đổi liên tục
      if (!isGenerating && streamStarted) {
        if (currentTurnCount > initialTurnCount) {
          if (hasCompleteAction || consecutiveIdleCount >= 4) {
            console.log("[chatgpt-worker] Phản hồi đã hoàn tất!");
            break;
          }
        } else {
          // Chưa kịp tăng turn count nhưng stop button đã biến mất
          if (consecutiveIdleCount >= 8) {
            break;
          }
        }
      }

      await page.waitForTimeout(500);
    }

    // Nghỉ 500ms để DOM ổn định hoàn toàn
    await page.waitForTimeout(500);

    // 7. BÓC TÁCH NỘI DUNG ĐA TẦNG (COPY BUTTON SALVAGE)
    let extractedText: string | null = null;

    // TẦNG 1 (ƯU TIÊN SỐ 1 - 100% NGUYÊN BẢN): Click nút "Copy code" của khối Markdown trong lượt MỚI
    try {
      console.log("[chatgpt-worker] [copy-salvage] Tìm kiếm nút Sao chép mã của khối Markdown...");
      const copyBtns = page.locator(this.selectors.codeCopyButton);
      const copyCount = await copyBtns.count();

      if (copyCount > initialCodeCopyCount) {
        // Chỉ click nút copy mới thuộc lượt này (từ initialCodeCopyCount trở đi)
        for (let i = copyCount - 1; i >= initialCodeCopyCount; i--) {
          const btn = copyBtns.nth(i);
          if (!(await btn.isVisible().catch(() => false))) continue;

          await btn.click({ timeout: 2_000 });
          await page.waitForTimeout(200);

          const text = await page.evaluate(async () => {
            const win = window as any;
            if (win.__chatgpt_last_copied_code && typeof win.__chatgpt_last_copied_code === "string") {
              return win.__chatgpt_last_copied_code.trim();
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
            console.log(`[chatgpt-worker] [copy-salvage] THÀNH CÔNG: Đã lấy được payload qua nút Copy (${text.length} ký tự).`);
            break;
          }
        }
      }
    } catch (err) {
      console.warn("[chatgpt-worker] [copy-salvage] Lỗi khi click nút copy:", err);
    }

    // TẦNG 2: Fallback đọc từ DOM của lượt mới nếu Tầng 1 không bắt được
    if (!extractedText) {
      console.log("[chatgpt-worker] [fallback] Sử dụng nội dung trích xuất từ DOM.");
      try {
        const currentTurnCount = await page.locator(this.selectors.responseContainer).count();
        if (currentTurnCount > initialTurnCount) {
          const newTurn = page.locator(this.selectors.responseContainer).nth(currentTurnCount - 1);
          if (await newTurn.isVisible().catch(() => false)) {
            extractedText = await newTurn.evaluate((el: HTMLElement) => {
              const clone = el.cloneNode(true) as HTMLElement;
              clone.querySelectorAll('.code-block__wrapper > div:first-child, button, nav').forEach(n => n.remove());
              return clone.innerText.trim();
            });
          }
        }
      } catch (domErr) {
        console.warn("[chatgpt-worker] Lỗi đọc DOM fallback:", domErr);
      }

      if (!extractedText) {
        extractedText = lastRenderedText;
      }
    }

    const normalizedRaw = ensureMarkdownTransportFence(extractedText);
    return {
      rawResponse: normalizedRaw,
      isCompleted: true,
    };
  }
}

export const chatGptBrowserWorker = new ChatGptBrowserWorker();
