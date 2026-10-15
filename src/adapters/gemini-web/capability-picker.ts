import type { Page } from "playwright-core";
import { GEMINI_SELECTORS, type GeminiDomSelectors } from "./selectors";
import { resolveGeminiTargetMenuLabel } from "../../gemini-models";

export interface EnsureGeminiCapabilityOptions {
  modelSlug?: string;
  reasoningEffort?: "low" | "medium" | "high";
  selectors?: GeminiDomSelectors;
  timeoutMs?: number;
}

const MODE_ID_MAP: Record<string, string> = {
  "3.5 Flash-Lite": "8c46e95b1a07cecc",
  "3.8 Flash": "56fdd199312815e2",
  "3.1 Pro": "e6fa609c3fa255c0",
  "4 Argon": "95a4c0abcba24364",
};

const EFFORT_LABEL_MAP: Record<string, string> = {
  low: "Thấp",
  medium: "Trung bình",
  high: "Cao",
};

/**
 * Đảm bảo mô hình và cấp độ tư duy (thinking level) được chọn đúng trên Gemini Web
 */
export async function ensureGeminiCapabilityMode(
  page: Page,
  options: EnsureGeminiCapabilityOptions
): Promise<boolean> {
  const { modelSlug, reasoningEffort, selectors = GEMINI_SELECTORS, timeoutMs = 10_000 } = options;
  if (!modelSlug && !reasoningEffort) return true;

  const targetLabel = resolveGeminiTargetMenuLabel(modelSlug);
  const targetModeId = MODE_ID_MAP[targetLabel];

  console.log(`[gemini-capability] Đang kiểm tra cấu hình: model="${targetLabel}", thinking="${reasoningEffort || 'giữ nguyên'}"`);

  try {
    // 1. Kiểm tra menu đã mở hay chưa
    const isMenuOpen = async (): Promise<boolean> => {
      return await page.evaluate(() => {
        const menu = document.querySelector('gem-menu[data-test-id="gem-mode-menu"], gem-menu[role="menu"]');
        return Boolean(menu && (menu.getAttribute('data-visible') === 'true' || window.getComputedStyle(menu).display !== 'none'));
      });
    };

    // 2. Tìm và click nút trigger mở menu
    const findAndClickTrigger = async (): Promise<boolean> => {
      return await page.evaluate(() => {
        const btn = document.querySelector('[data-test-id="bard-mode-menu-button"] button')
          || document.querySelector('[data-test-id="bard-mode-menu-button"]')
          || Array.from(document.querySelectorAll('button')).find(b => {
               const label = b.getAttribute('aria-label') || '';
               const txt = b.textContent || '';
               return (label.includes('chế độ') || label.includes('mode')) && (txt.includes('Flash') || txt.includes('Pro') || txt.includes('Lite') || txt.includes('Argon') || txt.includes('Gemini'));
             })
          || Array.from(document.querySelectorAll('button')).find(b => {
               const label = b.getAttribute('aria-label') || '';
               return label.includes('chế độ') || label.includes('mode');
             });

        if (!btn) return false;
        (btn as HTMLElement).click();
        return true;
      });
    };

    const ensureMenuOpen = async (): Promise<boolean> => {
      if (await isMenuOpen()) return true;
      const clicked = await findAndClickTrigger();
      if (!clicked) {
        console.warn("[gemini-capability] Không tìm thấy nút trigger mở menu model chọn chế độ.");
        return false;
      }
      await page.waitForTimeout(400);
      return await isMenuOpen();
    };

    await ensureMenuOpen();

    // 3. Chọn Model (ví dụ: 3.1 Pro, 3.8 Flash, 3.5 Flash-Lite, 4 Argon)
    if (targetLabel) {
      const modelSelection = await page.evaluate(({ label, modeId }) => {
        const menu = document.querySelector('gem-menu[data-test-id="gem-mode-menu"], gem-menu[role="menu"]');
        if (!menu) return { found: false, alreadyActive: false, clicked: false };

        const items = Array.from(menu.querySelectorAll('gem-menu-item[role="menuitem"]:not([value="thinking_level"])'));
        let targetItem: HTMLElement | null = null;

        for (const item of items) {
          const itemModeId = item.getAttribute('data-mode-id') || '';
          const itemText = item.textContent || '';
          if ((modeId && itemModeId === modeId) || itemText.includes(label)) {
            targetItem = item as HTMLElement;
            break;
          }
        }

        if (!targetItem) return { found: false, alreadyActive: false, clicked: false };

        const isActive = targetItem.classList.contains('active')
          || targetItem.classList.contains('selected')
          || targetItem.getAttribute('data-active') === 'true'
          || Boolean(targetItem.querySelector('mat-icon[fonticon="check"]'));

        if (!isActive) {
          targetItem.click();
          return { found: true, alreadyActive: false, clicked: true };
        }
        return { found: true, alreadyActive: true, clicked: false };
      }, { label: targetLabel, modeId: targetModeId });

      console.log(`[gemini-capability] Kết quả chọn model "${targetLabel}":`, modelSelection);

      if (modelSelection.clicked) {
        // Sau khi click chọn model, giao diện có thể cập nhật
        await page.waitForTimeout(600);
      }
    }

    // 4. Nếu có chọn Thinking Level (Cấp độ tư duy: Thấp / Trung bình / Cao)
    if (reasoningEffort) {
      const effortText = EFFORT_LABEL_MAP[reasoningEffort];
      console.log(`[gemini-capability] Chuẩn bị thiết lập Cấp độ tư duy: "${effortText}" (effort=${reasoningEffort})...`);

      // Đảm bảo menu mở lại nếu bị đóng sau khi click model
      await ensureMenuOpen();

      // Mở rộng mục "Cấp độ tư duy" (dạng accordion) nếu chưa mở
      const thinkingExpanded = await page.evaluate(() => {
        const trigger = document.querySelector('gem-menu-item[value="thinking_level"]') as HTMLElement | null;
        if (!trigger) return false;

        const isExpanded = trigger.getAttribute('aria-expanded') === 'true' || trigger.classList.contains('expanded');
        if (!isExpanded) {
          trigger.click();
        }
        return true;
      });

      if (thinkingExpanded) {
        await page.waitForTimeout(300);

        // Tìm và click mục thinking level tương ứng (Thấp / Trung bình / Cao)
        const effortSelection = await page.evaluate(({ effortLabel }) => {
          const allItems = Array.from(document.querySelectorAll('gem-menu-item'));
          const targetItem = allItems.find(it => {
            if (it.getAttribute('value') === 'thinking_level') return false;
            const text = it.textContent || '';
            return text.includes(effortLabel);
          }) as HTMLElement | null;

          if (!targetItem) return { found: false, alreadyActive: false, clicked: false };

          const isActive = targetItem.classList.contains('active')
            || targetItem.classList.contains('selected')
            || targetItem.getAttribute('data-active') === 'true'
            || Boolean(targetItem.querySelector('mat-icon[fonticon="check"]'));

          if (!isActive) {
            targetItem.click();
            return { found: true, alreadyActive: false, clicked: true };
          }
          return { found: true, alreadyActive: true, clicked: false };
        }, { effortLabel: effortText });

        console.log(`[gemini-capability] Kết quả chọn cấp độ tư duy "${effortText}":`, effortSelection);
        await page.waitForTimeout(300);
      } else {
        console.warn(`[gemini-capability] Không tìm thấy mục "thinking_level" trong menu.`);
      }
    }

    // 5. Đóng menu sau khi chọn xong để dọn dẹp giao diện sạch sẽ
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await page.waitForTimeout(200);

    return true;
  } catch (err) {
    console.warn("[gemini-capability] Quá trình chọn model / thinking level gặp lỗi:", err);
    return false;
  }
}
