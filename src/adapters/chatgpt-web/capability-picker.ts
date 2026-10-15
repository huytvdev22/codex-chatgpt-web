import type { Page, Locator } from "playwright-core";
import { CHATGPT_SELECTORS, type ChatGptDomSelectors } from "./selectors";
import {
  activateChatGptEffortMenu,
  readChatGptEffortSnapshot,
  parseChatGptEffortSliderState,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
} from "../../chatgpt-session";
import { selectChatGptModelFamily } from "./model-selection";
import type { ChatGptWebModelFamily } from "../../chatgpt-web-models";

export interface ChatGptSelectionOptions {
  modelSlug?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  customSelectors?: Partial<ChatGptDomSelectors>;
}

/**
 * Điều phối việc chọn Model và Cấp độ tư duy trên giao diện ChatGPT Web.
 * Kế thừa toàn bộ cơ chế chọn model family (5.6 / Latest / Sol / Astra) và effort slider của adapter cũ,
 * đồng thời hỗ trợ linh hoạt các model slug hiện đại (gpt-4o, o3-mini, o1, 4.5...).
 */
export async function ensureChatGptModelAndEffort(
  page: Page,
  options: ChatGptSelectionOptions = {}
): Promise<void> {
  const { modelSlug, reasoningEffort = "medium" } = options;
  console.log(`[chatgpt-picker] Đang kiểm tra cấu hình model: ${modelSlug || "mặc định"}, reasoning: ${reasoningEffort}`);

  try {
    // 1. Tìm nút điều khiển model/effort
    const control = page.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true }).first();
    const hasControl = await control.isVisible({ timeout: 4_000 }).catch(() => false);
    if (!hasControl) {
      console.log("[chatgpt-picker] Không tìm thấy nút chọn model/effort. Sử dụng cấu hình hiện tại của trang.");
      return;
    }

    // 2. Mở menu effort/model
    const activation = await activateChatGptEffortMenu(page, control, { settleMs: 2_000 });

    // 3. Nếu yêu cầu chọn model family (Sol 5.6 hoặc Latest/Astra 6)
    const normalized = (modelSlug || "").toLowerCase();
    let family: ChatGptWebModelFamily | null = null;
    if (normalized.includes("5.6") || normalized.includes("sol")) {
      family = "5.6";
    } else if (normalized.includes("6") || normalized.includes("astra") || normalized.includes("latest") || normalized.includes("pro")) {
      family = "6";
    }

    let currentActivation = activation;
    if (family) {
      try {
        console.log(`[chatgpt-picker] Đang chọn model family: ${family}...`);
        currentActivation = await selectChatGptModelFamily(
          currentActivation,
          family,
          () => activateChatGptEffortMenu(page, control, { settleMs: 2_000 })
        );
      } catch (err) {
        console.warn(`[chatgpt-picker] Không thể chọn family ${family} qua radio menu:`, err);
      }
    } else if (normalized.includes("o3-mini") || normalized.includes("o1") || normalized.includes("4o") || normalized.includes("4.5")) {
      // Hỗ trợ chọn qua menuitem text trực tiếp nếu menu có các option hiện đại
      const targetText = normalized.includes("o3-mini")
        ? /o3-mini/i
        : normalized.includes("o1")
          ? /o1/i
          : normalized.includes("4.5")
            ? /4\.5/i
            : /4o/i;

      const item = currentActivation.menu.locator('[role="menuitem"], [role="menuitemradio"]').filter({ hasText: targetText }).first();
      if (await item.isVisible().catch(() => false)) {
        console.log(`[chatgpt-picker] Click chọn model item: ${normalized}`);
        await item.click({ timeout: 3_000 });
      }
    }

    // 4. Điều chỉnh Slider cấp độ tư duy (Effort Slider) nếu có slider
    const sliderContainer = currentActivation.sliderContainer;
    const hasSlider = await sliderContainer.isVisible({ timeout: 2_000 }).catch(() => false);

    if (hasSlider) {
      const effortIndexMap: Record<string, number> = {
        low: 0,
        medium: 1,
        high: 2,
        xhigh: 3,
        max: 4,
      };
      const targetIndex = effortIndexMap[reasoningEffort] ?? 1;

      try {
        const state = await readChatGptEffortSnapshot(sliderContainer, 2_000);
        console.log(`[chatgpt-picker] Slider state hiện tại: min=${state.min}, max=${state.max}, value=${state.value}, target=${targetIndex}`);

        if (targetIndex >= 0 && targetIndex <= state.max - state.min) {
          const targetValue = state.min + targetIndex;
          if (state.value !== targetValue && state.available[targetIndex]) {
            // Click vào tick hoặc kéo slider
            const ticks = sliderContainer.locator('[data-selected]');
            if (await ticks.count() > targetIndex) {
              await ticks.nth(targetIndex).click({ timeout: 2_000 });
              console.log(`[chatgpt-picker] Đã click chọn nấc reasoning effort: ${targetValue}`);
            }
          }
        }
      } catch (sliderErr) {
        console.warn("[chatgpt-picker] Bỏ qua điều chỉnh slider:", sliderErr);
      }
    }

    // 5. Đóng menu an toàn để không che khuất composer
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(150);
  } catch (error) {
    console.warn("[chatgpt-picker] Lỗi trong quá trình cấu hình model/effort:", error);
    await page.keyboard.press("Escape").catch(() => {});
  }
}
