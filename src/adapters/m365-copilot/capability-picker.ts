import type { Page } from "playwright-core";
import type { M365CapabilityMode } from "../../m365-models";

export interface M365CapabilitySpec {
  readonly mode: M365CapabilityMode;
  readonly label: string;
  readonly iconTestId: string;
  readonly isSubmenu?: boolean;
  readonly parentMenuTestId?: string;
}

export const M365_CAPABILITY_SPECS: Record<M365CapabilityMode, M365CapabilitySpec> = {
  "auto": {
    mode: "auto",
    label: "Auto",
    iconTestId: "checkmark-Magic",
  },
  "quick": {
    mode: "quick",
    label: "Quick response",
    iconTestId: "checkmark-Chat",
  },
  "think": {
    mode: "think",
    label: "Think deeper",
    iconTestId: "checkmark-Reasoning",
  },
  "gpt-5.6-think": {
    mode: "gpt-5.6-think",
    label: "GPT 5.6 Think deeper",
    iconTestId: "checkmark-Gpt_5_6_Reasoning",
    isSubmenu: true,
    parentMenuTestId: "gptSubMenuModelTrigger-OpenAI",
  },
  "gpt-5.6-quick": {
    mode: "gpt-5.6-quick",
    label: "GPT 5.6 Quick response",
    iconTestId: "checkmark-Gpt_5_6_Chat",
    isSubmenu: true,
    parentMenuTestId: "gptSubMenuModelTrigger-OpenAI",
  },
};

export interface IM365CapabilityPicker {
  ensureMode(page: Page, targetMode: M365CapabilityMode): Promise<boolean>;
}

/**
 * Lớp điều khiển Capability Picker trên giao diện M365 Copilot Web
 * Tuân thủ Single Responsibility Principle (SRP) và Open/Closed Principle (OCP)
 */
export class M365CapabilityPicker implements IM365CapabilityPicker {
  /**
   * Đảm bảo model mong muốn đang được chọn trên giao diện M365 Copilot
   */
  async ensureMode(page: Page, targetMode: M365CapabilityMode): Promise<boolean> {
    const spec = M365_CAPABILITY_SPECS[targetMode];
    if (!spec) {
      console.warn(`[m365-capability] Unknown capability mode: ${targetMode}, skipping switch.`);
      return false;
    }

    try {
      // 1. Kiểm tra nhanh xem nút trigger ngoài giao diện đã hiển thị đúng mode chưa
      const isAlreadyActive = await page.evaluate((targetLabel: string) => {
        // Tìm các nút hoặc thẻ có aria-haspopup="menu" hoặc class trigger
        const triggers = Array.from(document.querySelectorAll(
          'button[aria-haspopup="menu"], div[aria-haspopup="menu"], [data-testid*="capability-picker" i], [aria-label*="model" i]'
        )) as HTMLElement[];

        // Kiểm tra xem trigger có chứa chính xác nhãn targetLabel không
        return triggers.some(t => {
          const text = (t.textContent || "").trim();
          return text.includes(targetLabel);
        });
      }, spec.label).catch(() => false);

      if (isAlreadyActive) {
        console.log(`[m365-capability] Mode '${spec.label}' (${targetMode}) is already active on UI.`);
        return true;
      }

      console.log(`[m365-capability] Attempting to switch to '${spec.label}' (${targetMode})...`);

      // 2. Tìm và click nút mở dropdown Capability Picker
      const menuOpened = await page.evaluate(() => {
        // Ưu tiên: nút có aria-haspopup="menu" chứa tên một trong các mode đã biết
        const candidates = Array.from(document.querySelectorAll(
          'button[aria-haspopup="menu"], div[aria-haspopup="menu"], [data-testid*="capability" i]'
        )) as HTMLElement[];

        const knownModes = ["Auto", "Quick response", "Think deeper", "GPT", "GPT 5.6"];
        const trigger = candidates.find(el => {
          const text = (el.textContent || "").trim();
          return knownModes.some(m => text.includes(m));
        }) || candidates[0];

        if (trigger) {
          trigger.click();
          trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return true;
        }
        return false;
      }).catch(() => false);

      if (!menuOpened) {
        console.warn("[m365-capability] Could not find capability picker trigger button on UI.");
        return false;
      }

      // 3. Đợi menu danh sách model xuất hiện
      await page.waitForSelector('.fui-MenuList[role="menu"], [role="menu"]', { timeout: 2500 }).catch(() => null);

      // 4. Thực hiện chọn mode theo đặc tả spec
      interface SelectionResult {
        success: boolean;
        reason?: string;
        alreadyChecked?: boolean;
        clicked?: boolean;
      }

      const selectResult: SelectionResult = await page.evaluate(async (params: {
        isSubmenu: boolean;
        iconTestId: string;
        label: string;
        parentMenuTestId?: string;
      }): Promise<SelectionResult> => {
        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

        if (!params.isSubmenu) {
          // Các option cấp 1: Auto, Quick response, Think deeper
          const items = Array.from(document.querySelectorAll('.fui-MenuItem[role="menuitemradio"], [role="menuitemradio"]')) as HTMLElement[];
          const targetItem = items.find(el => {
            const hasIcon = Boolean(el.querySelector(`svg[data-testid="${params.iconTestId}"]`));
            const hasText = (el.textContent || "").includes(params.label);
            return hasIcon || hasText;
          });

          if (!targetItem) return { success: false, reason: "Item not found in menu" };

          // Kiểm tra xem đã checked chưa
          if (targetItem.getAttribute("aria-checked") === "true") {
            return { success: true, alreadyChecked: true };
          }

          targetItem.click();
          targetItem.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return { success: true, clicked: true };
        } else {
          // Các option trong Submenu: GPT 5.6 Think deeper, GPT 5.6 Quick response
          // Bước 4.1: Kích hoạt Submenu OpenAI GPT
          const parentTrigger = (
            (params.parentMenuTestId ? document.querySelector(`[data-test-id="${params.parentMenuTestId}"]`) : null) ||
            Array.from(document.querySelectorAll('.fui-MenuItem, [role="menuitem"]')).find(el => (el.textContent || "").includes("GPT"))
          ) as HTMLElement | null;

          if (!parentTrigger) {
            return { success: false, reason: "OpenAI GPT submenu trigger not found" };
          }

          // Hover và click vào Submenu trigger để mở
          parentTrigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
          parentTrigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          parentTrigger.click();
          await sleep(350);

          // Bước 4.2: Tìm item tương ứng trong Submenu
          const subItems = Array.from(document.querySelectorAll('.fui-MenuItem[role="menuitemradio"], [role="menuitemradio"]')) as HTMLElement[];
          const targetSubItem = subItems.find(el => {
            const hasIcon = Boolean(el.querySelector(`svg[data-testid="${params.iconTestId}"]`));
            const hasText = (el.textContent || "").includes(params.label);
            return hasIcon || hasText;
          });

          if (!targetSubItem) {
            return { success: false, reason: `Submenu item '${params.label}' not found` };
          }

          if (targetSubItem.getAttribute("aria-checked") === "true") {
            return { success: true, alreadyChecked: true };
          }

          targetSubItem.click();
          targetSubItem.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return { success: true, clicked: true };
        }
      }, {
        isSubmenu: Boolean(spec.isSubmenu),
        iconTestId: spec.iconTestId,
        label: spec.label,
        parentMenuTestId: spec.parentMenuTestId,
      }).catch((err: unknown): SelectionResult => ({ success: false, reason: String(err) }));

      if (selectResult.alreadyChecked) {
        // Đóng menu nếu đã được chọn từ trước
        await page.keyboard.press("Escape").catch(() => {});
        console.log(`[m365-capability] Mode '${spec.label}' was already checked.`);
        return true;
      }

      if (selectResult.clicked) {
        console.log(`[m365-capability] Successfully switched to model: ${spec.label} (${targetMode})`);
        await new Promise(r => setTimeout(r, 300));
        return true;
      }

      console.warn(`[m365-capability] Failed to select mode: ${selectResult.reason}`);
      // Nhấn Escape để đóng menu nếu menu còn mở dở
      await page.keyboard.press("Escape").catch(() => {});
      return false;
    } catch (error) {
      console.warn(`[m365-capability] Error during capability selection: ${error instanceof Error ? error.message : String(error)}`);
      await page.keyboard.press("Escape").catch(() => {});
      return false;
    }
  }
}

export const defaultCapabilityPicker = new M365CapabilityPicker();

export async function ensureM365CapabilityMode(page: Page, targetMode: M365CapabilityMode): Promise<boolean> {
  return defaultCapabilityPicker.ensureMode(page, targetMode);
}
