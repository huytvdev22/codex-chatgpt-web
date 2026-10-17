import type { Page } from "playwright-core";
import { CHATGPT_SELECTORS } from "./selectors";

export interface EnsureChatGptThinkingOptions {
  reasoningEffort?: string; // "low" = Off, "high" = Think
  timeoutMs?: number;
}

/**
 * Đảm bảo trạng thái chế độ Suy nghĩ (Think) trên ChatGPT Web khớp với cấu hình từ Codex
 *
 * Nút Think trên ChatGPT Web có dạng:
 * <button type="button" aria-pressed="false" class="..."><span>Think</span></button>
 * Khi được bật, aria-pressed chuyển thành "true".
 */
export async function ensureChatGptThinkingMode(
  page: Page,
  options: EnsureChatGptThinkingOptions
): Promise<boolean> {
  const { reasoningEffort, timeoutMs = 5_000 } = options;
  if (!reasoningEffort) return true;

  // "high", "medium", "max", "xhigh" được coi là bật Think; "low" hoặc "off" là tắt Think
  const shouldThink = reasoningEffort === "high" || reasoningEffort === "max" || reasoningEffort === "xhigh";

  console.log(`[chatgpt-capability] Kiểm tra chế độ Think: target=${shouldThink ? "BẬT (Think)" : "TẮT (Off)"}`);

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const result = await page.evaluate(
      ({ shouldThink, selector }) => {
        // Hàm tìm nút Think an toàn 100% không bị SyntaxError trong querySelector
        function findThinkBtn(): HTMLButtonElement | null {
          // 1. Thử qua CSS selector nếu hợp lệ
          if (selector) {
            try {
              const matched = document.querySelector(selector) as HTMLButtonElement | null;
              if (matched) return matched;
            } catch {}
          }

          // 2. Duyệt tất cả các button tìm nút Think theo text hoặc span
          const allButtons = Array.from(document.querySelectorAll("button"));
          return (
            allButtons.find((b) => {
              const text = (b.textContent || "").trim();
              if (text === "Think") return true;
              const spans = Array.from(b.querySelectorAll("span"));
              return spans.some((s) => (s.textContent || "").trim() === "Think");
            }) || null
          );
        }

        const btn = findThinkBtn();
        if (!btn) {
          return { found: false, changed: false, currentPressed: null };
        }

        const ariaPressed = btn.getAttribute("aria-pressed");
        const isCurrentlyPressed = ariaPressed === "true";

        if (isCurrentlyPressed === shouldThink) {
          // Trạng thái đã khớp
          return { found: true, changed: false, currentPressed: isCurrentlyPressed };
        }

        // Cần click để chuyển đổi trạng thái
        btn.click();
        return { found: true, changed: true, currentPressed: isCurrentlyPressed };
      },
      { shouldThink, selector: CHATGPT_SELECTORS.thinkButton }
    );

    if (!result.found) {
      // Có thể trang đang tải hoặc giao diện chưa sẵn sàng, chờ 300ms rồi thử lại
      await page.waitForTimeout(300);
      continue;
    }

    if (!result.changed) {
      console.log(`[chatgpt-capability] Chế độ Think đã ở trạng thái mong muốn (${shouldThink ? "BẬT" : "TẮT"}).`);
      return true;
    }

    // Đã click, chờ 400ms để DOM cập nhật và kiểm tra lại
    await page.waitForTimeout(400);

    const verified = await page.evaluate(
      ({ shouldThink, selector }) => {
        function findThinkBtn(): HTMLButtonElement | null {
          if (selector) {
            try {
              const matched = document.querySelector(selector) as HTMLButtonElement | null;
              if (matched) return matched;
            } catch {}
          }
          const allButtons = Array.from(document.querySelectorAll("button"));
          return (
            allButtons.find((b) => {
              const text = (b.textContent || "").trim();
              if (text === "Think") return true;
              const spans = Array.from(b.querySelectorAll("span"));
              return spans.some((s) => (s.textContent || "").trim() === "Think");
            }) || null
          );
        }
        const btn = findThinkBtn();
        if (!btn) return false;
        return (btn.getAttribute("aria-pressed") === "true") === shouldThink;
      },
      { shouldThink, selector: CHATGPT_SELECTORS.thinkButton }
    );

    if (verified) {
      console.log(`[chatgpt-capability] Đã chuyển đổi chế độ Think thành công: ${shouldThink ? "BẬT" : "TẮT"}.`);
      return true;
    }
  }

  console.warn(`[chatgpt-capability] Không tìm thấy hoặc không thể đổi nút Think sau ${timeoutMs}ms.`);
  return false;
}
