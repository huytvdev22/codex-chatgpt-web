import type { Page } from "playwright-core";
import { AI_STUDIO_SELECTORS, type GoogleAIStudioDomSelectors } from "./selectors";

export type GoogleAIStudioThinkingLevel = "low" | "medium" | "high";

export interface EnsureThinkingOptions {
  level?: GoogleAIStudioThinkingLevel | string;
  selectors?: GoogleAIStudioDomSelectors;
}

/**
 * Đảm bảo mức độ Thinking Level trên giao diện Google AI Studio được chọn đúng theo yêu cầu.
 */
export async function ensureGoogleAIStudioThinkingLevel(
  page: Page,
  options: EnsureThinkingOptions
): Promise<void> {
  const targetLevel = (options.level || "medium").toLowerCase();
  const selectors = options.selectors || AI_STUDIO_SELECTORS;

  const validLevels: Record<string, string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
  };

  const expectedText = validLevels[targetLevel];
  if (!expectedText) {
    console.warn(`[ai-studio-capability] Mức thinking không hợp lệ: "${targetLevel}", bỏ qua thiết lập.`);
    return;
  }

  try {
    // 1. Kiểm tra sự tồn tại của component Thinking Level
    const selectTrigger = await page.$(selectors.thinkingSelectTrigger);
    if (!selectTrigger) {
      console.log("[ai-studio-capability] Không tìm thấy component Thinking Level trên trang này.");
      return;
    }

    // 2. Đọc giá trị hiện tại
    const currentText = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return (el?.textContent || "").trim();
    }, selectors.thinkingCurrentValue);

    if (currentText.toLowerCase().includes(targetLevel)) {
      console.log(`[ai-studio-capability] Thinking level đã ở mức mong muốn: "${currentText}"`);
      return;
    }

    console.log(`[ai-studio-capability] Đang đổi Thinking Level từ "${currentText}" sang "${expectedText}"...`);

    // 3. Click mở dropdown mat-select
    await page.evaluate((triggerSel) => {
      const el = document.querySelector(triggerSel) as HTMLElement | null;
      if (!el) return;
      const innerTrigger = el.querySelector(".mat-mdc-select-trigger") as HTMLElement | null;
      (innerTrigger || el).click();
    }, selectors.thinkingSelectTrigger);

    // 4. Chờ panel hiển thị
    await page.waitForSelector(selectors.thinkingSelectPanel, { state: "visible", timeout: 3000 }).catch(() => null);

    // 5. Tìm và click option tương ứng
    const clicked = await page.evaluate(
      ({ panelSel, optionSel, targetWord }) => {
        const panel = document.querySelector(panelSel);
        if (!panel) return false;
        const options = Array.from(panel.querySelectorAll(optionSel));
        const matched = options.find((opt) => (opt.textContent || "").toLowerCase().includes(targetWord.toLowerCase()));
        if (matched) {
          (matched as HTMLElement).click();
          return true;
        }
        return false;
      },
      { panelSel: selectors.thinkingSelectPanel, optionSel: selectors.thinkingOptionItem, targetWord: expectedText }
    );

    if (clicked) {
      await page.waitForTimeout(300);
      const newText = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return (el?.textContent || "").trim();
      }, selectors.thinkingCurrentValue);
      console.log(`[ai-studio-capability] Đã chọn Thinking Level thành công: "${newText}"`);
    } else {
      console.warn(`[ai-studio-capability] Không tìm thấy option cho mức "${expectedText}".`);
    }
  } catch (err) {
    console.warn(`[ai-studio-capability] Lỗi khi đổi Thinking Level:`, err instanceof Error ? err.message : String(err));
  }
}

