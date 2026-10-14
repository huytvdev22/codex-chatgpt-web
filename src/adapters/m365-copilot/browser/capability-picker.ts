
import type { Page } from "playwright-core";
import type { M365CapabilityMode } from "../../../m365-models";
export type { M365CapabilityMode };
export { resolveM365CapabilityMode } from "../../../m365-models";

export interface M365CapabilitySpec {
  readonly mode: M365CapabilityMode;
  readonly label: string;
  readonly aliases?: readonly string[];
  readonly itemTestId?: string;
  readonly iconTestId: string;
  readonly isSubmenu?: boolean;
  readonly parentMenuTestId?: string;
  readonly parentLabel?: string;
}

export const M365_CAPABILITY_SPECS: Record<M365CapabilityMode, M365CapabilitySpec> = {
  "auto": {
    mode: "auto",
    label: "Auto",
    itemTestId: "gptSubMenuModelTrigger-Magic",
    iconTestId: "checkmark-Magic",
    aliases: ["Auto"],
  },
  "quick": {
    mode: "quick",
    label: "Quick response",
    itemTestId: "gptSubMenuModelTrigger-Chat",
    iconTestId: "checkmark-Chat",
    aliases: ["Quick response", "Quick"],
  },
  "think": {
    mode: "think",
    label: "Think deeper",
    itemTestId: "gptSubMenuModelTrigger-Reasoning",
    iconTestId: "checkmark-Reasoning",
    aliases: ["Think deeper", "Think"],
  },
  "gpt-5.6-think": {
    mode: "gpt-5.6-think",
    label: "GPT-5.6 Sol Think deeper",
    aliases: ["GPT-5.6 Sol Think deeper", "GPT 5.6 Think deeper", "Think deeper", "GPT-5.6"],
    iconTestId: "checkmark-Gpt_5_6_Reasoning",
    isSubmenu: true,
    parentMenuTestId: "gptSubMenuModelTrigger-OpenAI",
    parentLabel: "GPT",
  },
  "gpt-5.6-quick": {
    mode: "gpt-5.6-quick",
    label: "GPT-5.6 Sol Quick response",
    aliases: ["GPT-5.6 Sol Quick response", "GPT 5.6 Quick response", "Quick response", "GPT-5.6"],
    iconTestId: "checkmark-Gpt_5_6_Chat",
    isSubmenu: true,
    parentMenuTestId: "gptSubMenuModelTrigger-OpenAI",
    parentLabel: "GPT",
  },
};

export interface IM365CapabilityPicker {
  ensureMode(page: Page, targetMode: M365CapabilityMode): Promise<boolean>;
}

/**
 * Lớp điều khiển Capability Picker trên giao diện M365 Copilot Web.
 * Tương thích với Microsoft Fluent UI v9 (fui-Button, fui-MenuPopover, fui-MenuItem, fui-MenuList).
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
      // 1. Kiểm tra nhanh xem nút switcher ngoài giao diện (#gptModeSwitcher) đã hiển thị đúng mode chưa
      const isAlreadyActive = await page.evaluate((s: M365CapabilitySpec) => {
        const switcher = document.querySelector(
          '#gptModeSwitcher, button[id*="gptModeSwitcher"], button[aria-haspopup="menu"][aria-label*="Model Selector" i], [aria-label*="Model Selector" i]'
        ) || (Array.from(document.querySelectorAll(
          'button[aria-haspopup="menu"], div[aria-haspopup="menu"], [data-testid*="capability-picker" i]'
        )) as HTMLElement[]).find(el => {
          const text = (el.textContent || "").trim();
          return ["Auto", "Quick", "Think", "GPT"].some(m => text.includes(m));
        });

        if (!switcher) return false;

        const ariaLabel = (switcher.getAttribute("aria-label") || "").trim().toLowerCase();
        const text = (switcher.textContent || "").trim().toLowerCase();
        const combined = `${ariaLabel} ${text}`;

        if (s.mode === "auto") {
          return combined.includes("auto");
        }
        if (s.mode === "quick") {
          return combined.includes("quick") && !combined.includes("5.6") && !combined.includes("gpt");
        }
        if (s.mode === "think") {
          return (combined.includes("think") || combined.includes("reasoning")) && !combined.includes("5.6") && !combined.includes("gpt");
        }
        if (s.mode === "gpt-5.6-quick") {
          return combined.includes("quick") && (combined.includes("5.6") || combined.includes("gpt"));
        }
        if (s.mode === "gpt-5.6-think") {
          return (combined.includes("think") || combined.includes("reasoning")) && (combined.includes("5.6") || combined.includes("gpt"));
        }

        return false;
      }, spec).catch(() => false);

      if (isAlreadyActive) {
        console.log(`[m365-capability] Mode '${spec.label}' (${targetMode}) is already active on UI.`);
        return true;
      }

      console.log(`[m365-capability] Attempting to switch to '${spec.label}' (${targetMode})...`);

      // 2. Tìm và click nút mở dropdown Capability Picker (#gptModeSwitcher)
      const menuOpened = await page.evaluate(() => {
        const switcher = document.querySelector(
          '#gptModeSwitcher, button[id*="gptModeSwitcher"], button[aria-haspopup="menu"][aria-label*="Model Selector" i]'
        ) as HTMLElement | null;

        if (switcher) {
          switcher.focus();
          switcher.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
          switcher.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          switcher.click();
          switcher.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return true;
        }

        // Fallback: Tìm qua các trigger menu chung
        const candidates = Array.from(document.querySelectorAll(
          'button[aria-haspopup="menu"], div[aria-haspopup="menu"], [data-testid*="capability" i]'
        )) as HTMLElement[];

        const knownModes = ["Auto", "Quick", "Think", "GPT", "GPT 5.6", "GPT-5.6"];
        const fallback = candidates.find(el => {
          const text = (el.textContent || "").trim();
          return knownModes.some(m => text.includes(m));
        }) || candidates[0];

        if (fallback) {
          fallback.focus();
          fallback.click();
          fallback.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
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
        itemTestId?: string;
        iconTestId: string;
        label: string;
        aliases?: readonly string[];
        parentMenuTestId?: string;
        parentLabel?: string;
      }): Promise<SelectionResult> => {
        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

        // Helper tìm item menu hỗ trợ cả role="menuitem", role="menuitemradio" và class fui-MenuItem
        const findMenuItem = (root: Element | Document, criteria: {
          testId?: string;
          iconTestId?: string;
          labels?: readonly string[];
        }): HTMLElement | null => {
          // 1. Tìm theo testid trực tiếp của item
          if (criteria.testId) {
            const byTestId = root.querySelector(`[data-testid="${criteria.testId}"]`) as HTMLElement | null;
            if (byTestId) return byTestId;
          }

          // 2. Tìm theo icon SVG testid bên trong item
          if (criteria.iconTestId) {
            const icon = root.querySelector(`svg[data-testid="${criteria.iconTestId}"]`);
            if (icon) {
              const item = icon.closest('.fui-MenuItem, [role="menuitem"], [role="menuitemradio"]') as HTMLElement | null;
              if (item) return item;
            }
          }

          // 3. Tìm theo text content trong các menu item
          const allItems = Array.from(root.querySelectorAll(
            '.fui-MenuItem, [role="menuitem"], [role="menuitemradio"]'
          )) as HTMLElement[];

          if (criteria.labels && criteria.labels.length > 0) {
            for (const targetLabel of criteria.labels) {
              const matched = allItems.find(el => {
                const text = (el.textContent || "").trim();
                return text.toLowerCase().includes(targetLabel.toLowerCase());
              });
              if (matched) return matched;
            }
          }

          return null;
        };

        // Helper kích hoạt click tương thích Fluent UI React v9
        const triggerClick = (el: HTMLElement) => {
          el.focus();
          el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
          el.click();
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
        };

        if (!params.isSubmenu) {
          // Các option cấp 1: Auto, Quick response, Think deeper
          const targetItem = findMenuItem(document, {
            testId: params.itemTestId,
            iconTestId: params.iconTestId,
            labels: [params.label, ...(params.aliases || [])],
          });

          if (!targetItem) {
            return { success: false, reason: `Item '${params.label}' not found in primary menu` };
          }

          // Kiểm tra xem đã checked chưa
          if (targetItem.getAttribute("aria-checked") === "true") {
            return { success: true, alreadyChecked: true };
          }

          triggerClick(targetItem);
          return { success: true, clicked: true };
        } else {
          // Các option trong Submenu: GPT-5.6 Sol Think deeper, GPT-5.6 Sol Quick response
          // Bước 4.1: Tìm trigger Submenu OpenAI GPT
          const parentTrigger = (
            (params.parentMenuTestId
              ? (document.querySelector(`[data-testid="${params.parentMenuTestId}"][aria-haspopup="menu"]`) ||
                 document.querySelector(`[data-testid="${params.parentMenuTestId}"]`))
              : null) ||
            findMenuItem(document, {
              testId: params.parentMenuTestId,
              iconTestId: "checkmark-OpenAI",
              labels: [params.parentLabel || "GPT", "OpenAI"],
            })
          ) as HTMLElement | null;

          if (!parentTrigger) {
            return { success: false, reason: "OpenAI GPT submenu trigger not found in primary menu" };
          }

          // Kích hoạt mở Submenu bằng hover + click
          parentTrigger.focus();
          parentTrigger.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
          parentTrigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
          parentTrigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          parentTrigger.click();
          await sleep(350);

          // Bước 4.2: Tìm item tương ứng trong Submenu
          // Trong submenu, cả hai item đều có data-testid="gptSubMenuModelTrigger-OpenAI",
          // nên việc tìm kiếm thông qua icon SVG testid (checkmark-Gpt_5_6_Chat / checkmark-Gpt_5_6_Reasoning)
          // hoặc text content là chuẩn xác tuyệt đối.
          const popovers = Array.from(document.querySelectorAll('.fui-MenuPopover, [role="menu"]'));
          const submenuContainer = popovers.length > 1 ? popovers[popovers.length - 1] : document;

          const targetSubItem = findMenuItem(submenuContainer, {
            iconTestId: params.iconTestId,
            labels: [params.label, ...(params.aliases || [])],
          });

          if (!targetSubItem) {
            return { success: false, reason: `Submenu item '${params.label}' (icon: ${params.iconTestId}) not found` };
          }

          if (targetSubItem.getAttribute("aria-checked") === "true") {
            return { success: true, alreadyChecked: true };
          }

          triggerClick(targetSubItem);
          return { success: true, clicked: true };
        }
      }, {
        isSubmenu: Boolean(spec.isSubmenu),
        itemTestId: spec.itemTestId,
        iconTestId: spec.iconTestId,
        label: spec.label,
        aliases: spec.aliases,
        parentMenuTestId: spec.parentMenuTestId,
        parentLabel: spec.parentLabel,
      }).catch((err: unknown): SelectionResult => ({ success: false, reason: String(err) }));

      if (selectResult.alreadyChecked) {
        // Đóng menu nếu đã được chọn từ trước
        await page.keyboard.press("Escape").catch(() => { });
        if (spec.isSubmenu) {
          await page.keyboard.press("Escape").catch(() => { });
        }
        console.log(`[m365-capability] Mode '${spec.label}' was already checked.`);
        return true;
      }

      if (selectResult.clicked) {
        console.log(`[m365-capability] Successfully switched to model: ${spec.label} (${targetMode})`);
        await new Promise(r => setTimeout(r, 400));
        // Đảm bảo không còn menu popover nào mở lơ lửng che ô nhập liệu
        const stillOpen = await page.evaluate(() => {
          return Boolean(document.querySelector('.fui-MenuPopover[data-popper-placement], [role="menu"]'));
        }).catch(() => false);
        if (stillOpen) {
          await page.keyboard.press("Escape").catch(() => { });
        }
        return true;
      }

      console.warn(`[m365-capability] Failed to select mode: ${selectResult.reason}`);
      // Nhấn Escape để đóng menu nếu menu còn mở dở
      await page.keyboard.press("Escape").catch(() => { });
      await page.keyboard.press("Escape").catch(() => { });
      return false;
    } catch (error) {
      console.warn(`[m365-capability] Error during capability selection: ${error instanceof Error ? error.message : String(error)}`);
      await page.keyboard.press("Escape").catch(() => { });
      await page.keyboard.press("Escape").catch(() => { });
      return false;
    }
  }
}

export const defaultCapabilityPicker = new M365CapabilityPicker();

/**
 * Kiểm tra và kích hoạt chế độ năng lực (Capability Mode) mục tiêu trên giao diện M365 Copilot.
 */
export async function ensureM365CapabilityMode(page: Page, targetMode: M365CapabilityMode): Promise<boolean> {
  return defaultCapabilityPicker.ensureMode(page, targetMode);
}

