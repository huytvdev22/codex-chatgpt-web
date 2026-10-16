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
    let streamStarted = false;
    let lastRenderedText = "";
    let stableTextCycles = 0;

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

      // Kiểm tra có văn bản đang được tạo trong DOM
      const hasNewDomContent = await page.evaluate(() => {
        const turns = document.querySelectorAll('[data-turn-key], [data-virtualized-turn-content], article');
        return turns.length > 0;
      }).catch(() => false);

      if (hasNewDomContent) {
        streamStarted = true;
        break;
      }

      await page.waitForTimeout(300);
    }

    console.log("[chatgpt-worker] Phản hồi đang được sinh. Bắt đầu theo dõi hoàn tất...");

    // Polling cho tới khi streaming kết thúc
    const maxDeadline = Date.now() + timeoutMs;

    while (Date.now() < maxDeadline) {
      if (signal?.aborted) throw new DOMException("ChatGpt turn aborted", "AbortError");

      // Đọc trạng thái trực tiếp từ trang qua evaluate nhanh
      const pageState = await page.evaluate(() => {
        // 1. Kiểm tra nút stop
        const stopBtn = document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="Dừng" i]');
        const isStopVisible = stopBtn !== null && stopBtn.offsetParent !== null;

        // 2. Lấy turn mới nhất
        const turns = Array.from(document.querySelectorAll('[data-turn-key], [data-virtualized-turn-content], article[data-testid^="conversation-turn-"]'));
        const lastTurn = turns[turns.length - 1];
        
        let turnText = "";
        let hasClosedEnvelope = false;
        let hasCompleteButtons = false;

        if (lastTurn) {
          turnText = lastTurn.textContent || "";
          hasClosedEnvelope = turnText.includes("</webResponse>") || turnText.includes("</custom_tool_call>") || turnText.includes("</proposed_plan>");
          
          // Kiểm tra nút hoàn tất trong turn này
          const completeBtn = lastTurn.querySelector('button[aria-label="Copy"], button[aria-label="Regenerate response"], button[aria-label*="Share" i]');
          hasCompleteButtons = completeBtn !== null;
        }

        return {
          totalTurns: turns.length,
          isStopVisible,
          textLength: turnText.length,
          hasClosedEnvelope,
          hasCompleteButtons,
          turnTextSample: turnText.slice(-300),
        };
      }).catch(() => null);

      const isGenerating = pageState?.isStopVisible ?? false;
      const currentTextSample = pageState?.turnTextSample || "";

      // Theo dõi độ ổn định của text
      if (currentTextSample && currentTextSample === lastRenderedText) {
        stableTextCycles++;
      } else {
        stableTextCycles = 0;
        lastRenderedText = currentTextSample;
      }

      // ĐIỀU KIỆN HOÀN THÀNH THÔNG MINH:
      // Khi nút Stop không còn hiển thị:
      if (!isGenerating && streamStarted) {
        // Trường hợp 1: Đã thấy thẻ đóng giao thức (Bằng chứng chắc chắn 100% ChatGPT đã kết thúc)
        if (pageState?.hasClosedEnvelope) {
          console.log("[chatgpt-worker] Đã phát hiện thẻ đóng giao thức </webResponse> và nút Stop đã ẩn. Hoàn tất lượt!");
          break;
        }

        // Trường hợp 2: Có nút hoàn tất của turn (Copy turn / Regenerate) và text đã ổn định >= 1 chu kỳ (400ms)
        if (pageState?.hasCompleteButtons && stableTextCycles >= 1) {
          console.log("[chatgpt-worker] Phát hiện các nút điều khiển hoàn tất lượt và văn bản ổn định. Hoàn tất lượt!");
          break;
        }

        // Trường hợp 3: Nút Stop đã ẩn và văn bản ổn định liên tục >= 3 chu kỳ (1.200ms)
        if (stableTextCycles >= 3) {
          console.log("[chatgpt-worker] Nút Stop đã ẩn và văn bản hoàn toàn ổn định (>= 1.2s). Hoàn tất lượt!");
          break;
        }
      }

      await page.waitForTimeout(400);
    }

    // Nghỉ 400ms để DOM ổn định hoàn toàn
    await page.waitForTimeout(400);

    // 7. TỰ ĐỘNG BẤM TẤT CẢ NÚT "SHOW MORE" (XEM THÊM) ĐỂ MỞ RỘNG TRỌN VẸN FILE DÀI
    try {
      console.log("[chatgpt-worker] [show-more] Kiểm tra và tự động mở rộng các khối code dài bị thu gọn...");
      const expandedCount = await page.evaluate(() => {
        const turns = Array.from(document.querySelectorAll('[data-turn-key], [data-virtualized-turn-content], article'));
        const lastTurn = turns[turns.length - 1] || document.body;
        
        const showMoreBtns = Array.from(lastTurn.querySelectorAll('button')).filter(b => {
          const txt = (b.textContent || '').trim().toLowerCase();
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          return txt.includes('show more') || txt.includes('xem thêm') || aria.includes('show more') || aria.includes('xem thêm');
        });

        for (const btn of showMoreBtns) {
          btn.click();
        }
        return showMoreBtns.length;
      });

      if (expandedCount > 0) {
        console.log(`[chatgpt-worker] [show-more] Đã kích hoạt ${expandedCount} nút Show more để bung toàn bộ nội dung file dài.`);
        await page.waitForTimeout(300);
      }
    } catch (expandErr) {
      console.warn("[chatgpt-worker] [show-more] Cảnh báo khi kích hoạt Show more:", expandErr);
    }

    // 8. BÓC TÁCH NỘI DUNG ĐA TẦNG (MULTI-TIER EXTRACTION)
    let extractedText: string | null = null;

    // TẦNG 1 (ƯU TIÊN SỐ 1 - 100% NGUYÊN BẢN): Click nút "Copy code" của khối Markdown trong lượt mới
    try {
      console.log("[chatgpt-worker] [copy-salvage] [Tầng 1] Tìm kiếm nút Sao chép mã của khối Markdown...");
      const copyBtns = page.locator(this.selectors.codeCopyButton);
      const copyCount = await copyBtns.count();

      if (copyCount > 0) {
        // Duyệt từ nút copy mới nhất ở cuối trang
        const targetBtn = copyBtns.last();
        if (await targetBtn.isVisible().catch(() => false)) {
          await targetBtn.click({ timeout: 2_000 });
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

          if (text && text.length > 0) {
            extractedText = text;
            console.log(`[chatgpt-worker] [copy-salvage] [Tầng 1] THÀNH CÔNG: Đã lấy được payload qua nút Copy Code (${text.length} ký tự).`);
          }
        }
      }
    } catch (err) {
      console.warn("[chatgpt-worker] [copy-salvage] [Tầng 1] Lỗi khi click nút copy code:", err);
    }

    // TẦNG 2: Click nút "Copy" của toàn bộ lượt Assistant (Turn Copy Button)
    if (!extractedText) {
      try {
        console.log("[chatgpt-worker] [copy-salvage] [Tầng 2] Tìm kiếm nút Sao chép toàn bộ lượt trả lời (Copy Turn)...");
        const turnCopyBtns = page.locator(this.selectors.turnCopyButton);
        const turnCopyCount = await turnCopyBtns.count();

        if (turnCopyCount > 0) {
          const targetTurnCopyBtn = turnCopyBtns.last();
          if (await targetTurnCopyBtn.isVisible().catch(() => false)) {
            await targetTurnCopyBtn.click({ timeout: 2_000 });
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

            if (text && text.length > 0) {
              extractedText = text;
              console.log(`[chatgpt-worker] [copy-salvage] [Tầng 2] THÀNH CÔNG: Đã lấy được payload qua nút Copy Turn (${text.length} ký tự).`);
            }
          }
        }
      } catch (turnCopyErr) {
        console.warn("[chatgpt-worker] [copy-salvage] [Tầng 2] Lỗi khi click nút copy turn:", turnCopyErr);
      }
    }

    // TẦNG 3: Bóc tách trực tiếp từ DOM của turn mới nhất
    if (!extractedText) {
      console.log("[chatgpt-worker] [fallback] [Tầng 3] Trích xuất nội dung trực tiếp từ DOM của lượt mới.");
      try {
        extractedText = await page.evaluate(() => {
          const turns = Array.from(document.querySelectorAll('[data-turn-key], [data-virtualized-turn-content], article'));
          const lastTurn = turns[turns.length - 1];
          if (!lastTurn) return null;

          // 1. Nếu trong lastTurn có phần tử trợ lý riêng biệt (ví dụ .block-BQZwFn:nth-child(2) hoặc .markdown)
          const assistantBlock = lastTurn.querySelector('.block-BQZwFn:nth-child(2), [data-message-author-role="assistant"], .markdown');
          if (assistantBlock) {
            const clone = assistantBlock.cloneNode(true) as HTMLElement;
            clone.querySelectorAll('.code-block__wrapper > div:first-child, button, nav, [aria-label*="Copy" i]').forEach(n => n.remove());
            const text = clone.innerText?.trim() || clone.textContent?.trim();
            if (text && text.length > 0) return text;
          }

          // 2. Fallback bóc tách từ lastTurn
          const clone = lastTurn.cloneNode(true) as HTMLElement;
          // Loại bỏ phần tin nhắn của user nếu cùng nằm trong turn
          const userBlock = clone.querySelector('.block-BQZwFn:first-child');
          if (userBlock && clone.querySelectorAll('.block-BQZwFn').length > 1) {
            userBlock.remove();
          }
          clone.querySelectorAll('.code-block__wrapper > div:first-child, button, nav, [aria-label*="Copy" i]').forEach(n => n.remove());
          return clone.innerText?.trim() || clone.textContent?.trim() || null;
        });
      } catch (domErr) {
        console.warn("[chatgpt-worker] Lỗi đọc DOM fallback:", domErr);
      }
    }

    if (!extractedText) {
      extractedText = lastRenderedText;
    }

    const normalizedRaw = ensureMarkdownTransportFence(extractedText);
    return {
      rawResponse: normalizedRaw,
      isCompleted: true,
    };
  }
}

export const chatGptBrowserWorker = new ChatGptBrowserWorker();
