import type { Page } from "playwright-core";
import { GEMINI_SELECTORS, type GeminiDomSelectors } from "./selectors";
import { resolveGeminiTargetMenuLabel } from "../../gemini-models";

export interface EnsureGeminiCapabilityOptions {
  modelSlug?: string;
  reasoningEffort?: "low" | "medium" | "high";
  selectors?: GeminiDomSelectors;
  timeoutMs?: number;
}

/**
 * Đảm bảo mô hình được chọn trên giao diện Gemini Web khớp với yêu cầu từ Codex IDE.
 * Tự động click dropdown menu và chọn đúng model (3.8 Flash, 3.1 Pro, 3.5 Flash-Lite, 4 Argon)
 * và cấp độ tư duy (Thấp, Trung bình, Cao).
 */
export async function ensureGeminiCapabilityMode(
  page: Page,
  options: EnsureGeminiCapabilityOptions
): Promise<boolean> {
  const { modelSlug, reasoningEffort, selectors = GEMINI_SELECTORS, timeoutMs = 8_000 } = options;
  if (!modelSlug) return true;

  const targetLabel = resolveGeminiTargetMenuLabel(modelSlug);

  try {
    // 1. Kiểm tra nhãn hiển thị hiện tại trên nút trigger xem đã đúng chưa (tránh click thừa)
    const currentLabel = await page.$eval(
      selectors.currentModelLabel || 'button[data-test-id="bard-mode-menu-button"] .picker-primary-text',
      (el) => el.textContent?.trim() || ""
    ).catch(() => "");

    if (currentLabel && currentLabel.toLowerCase().includes(targetLabel.toLowerCase())) {
      console.log(`[gemini-capability] Model hiện tại đã là "${currentLabel}" (khớp với mục tiêu "${targetLabel}").`);
      if (!reasoningEffort) return true;
    }

    // 2. Tìm và click nút mở dropdown menu
    const triggerSelector = selectors.modelSelectorButton || 'button[data-test-id="bard-mode-menu-button"]';
    const triggerBtn = await page.waitForSelector(triggerSelector, {
      timeout: timeoutMs,
      state: "visible",
    }).catch(() => null);

    if (!triggerBtn) {
      console.warn(`[gemini-capability] Không tìm thấy nút trigger chọn model (${triggerSelector}).`);
      return false;
    }

    console.log(`[gemini-capability] Đang mở menu chọn model...`);
    await triggerBtn.click();
    await page.waitForTimeout(300);

    // 3. Đợi khung menu của Gemini xuất hiện
    const menuSelector = selectors.modelMenuContainer || 'gem-menu[data-test-id="gem-mode-menu"]';
    const menu = await page.waitForSelector(menuSelector, {
      timeout: 5_000,
      state: "visible",
    }).catch(() => null);

    if (!menu) {
      console.warn("[gemini-capability] Menu danh sách model không xuất hiện sau khi click.");
      return false;
    }

    // 4. Tìm và click mục model tương ứng
    const itemSelector = selectors.modelMenuItem || 'gem-menu-item[role="menuitem"]:not([value="thinking_level"])';
    const items = await page.$$(itemSelector);
    let matchedItem = null;

    for (const item of items) {
      const text = await item.$eval(
        selectors.modelMenuItemLabel || ".label",
        (el) => el.textContent?.trim() || ""
      ).catch(() => "");

      if (text.toLowerCase().includes(targetLabel.toLowerCase())) {
        matchedItem = item;
        break;
      }
    }

    if (matchedItem) {
      console.log(`[gemini-capability] Tìm thấy mục "${targetLabel}". Đang chọn...`);
      await matchedItem.click();
      await page.waitForTimeout(400);
    } else {
      console.warn(`[gemini-capability] Không tìm thấy mục "${targetLabel}" trong menu.`);
    }

    // 5. Nếu có yêu cầu cấp độ tư duy (reasoning_effort: Thấp / Trung bình / Cao)
    if (reasoningEffort) {
      const effortLabelMap: Record<string, string> = {
        low: "Thấp",
        medium: "Trung bình",
        high: "Cao",
      };
      const effortText = effortLabelMap[reasoningEffort];

      if (effortText) {
        // Mở lại menu nếu đã bị đóng
        const isMenuOpen = await page.$(menuSelector);
        if (!isMenuOpen) {
          await triggerBtn.click();
          await page.waitForTimeout(300);
        }

        const thinkingTriggerSelector = selectors.thinkingSubmenuTrigger || 'gem-menu-item[value="thinking_level"]';
        const thinkingTrigger = await page.$(thinkingTriggerSelector);

        if (thinkingTrigger) {
          console.log(`[gemini-capability] Di chuột vào mục Cấp độ tư duy...`);
          await thinkingTrigger.hover();
          await page.waitForTimeout(300);

          const submenuSelector = selectors.thinkingSubmenuContainer || '.submenu-container gem-menu';
          const submenu = await page.waitForSelector(submenuSelector, {
            timeout: 3_000,
            state: "visible",
          }).catch(() => null);

          if (submenu) {
            const subItemSelector = selectors.thinkingSubmenuItem || '.submenu-container gem-menu-item[role="menuitem"]';
            const subItems = await page.$$(subItemSelector);

            for (const sItem of subItems) {
              const label = await sItem.innerText().catch(() => "");
              if (label.includes(effortText)) {
                console.log(`[gemini-capability] Đã chọn cấp độ tư duy: "${effortText}".`);
                await sItem.click();
                await page.waitForTimeout(300);
                break;
              }
            }
          }
        }
      }
    }

    return true;
  } catch (err) {
    console.warn("[gemini-capability] Quá trình chọn model gặp lỗi:", err);
    return false;
  }
}
