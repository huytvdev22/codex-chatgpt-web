import type { IMenuNavigationStrategy, NavigationStepResult } from "../contracts/menu-navigation-strategy.interface";
import type { IDomDriver } from "../contracts/dom-driver.interface";
import type { ModelSpecDto } from "../dto/model-spec.dto";

export interface NestedSubmenuConfig {
  triggerSelector: string;
  parentTriggerSelector?: string;
  submenuItemSelector: string;
  parentMenuIdentifierSelector?: (parentId: string) => string;
  knownTriggerTexts?: readonly string[];
}

/**
 * Chiến lược tương tác menu con phân cấp (Submenu)
 */
export class NestedSubmenuStrategy<TMode extends string = string>
  implements IMenuNavigationStrategy<TMode> {

  readonly strategyName = "NestedSubmenuStrategy";

  constructor(private readonly config: NestedSubmenuConfig) {}

  public supports(spec: ModelSpecDto<TMode>): boolean {
    return Boolean(spec.isSubmenu);
  }

  public async openMenu(driver: IDomDriver): Promise<boolean> {
    return driver.evaluate((params: { triggerSelector: string; knownTriggerTexts?: readonly string[] }) => {
      const candidates = Array.from(document.querySelectorAll(params.triggerSelector)) as HTMLElement[];
      if (candidates.length === 0) return false;

      let trigger = candidates[0];
      if (params.knownTriggerTexts && params.knownTriggerTexts.length > 0) {
        const matched = candidates.find(el => {
          const text = (el.textContent || "").trim();
          return params.knownTriggerTexts!.some(k => text.includes(k));
        });
        if (matched) trigger = matched;
      }

      trigger.click();
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return true;
    }, {
      triggerSelector: this.config.triggerSelector,
      knownTriggerTexts: this.config.knownTriggerTexts,
    });
  }

  public async selectItem(driver: IDomDriver, spec: ModelSpecDto<TMode>): Promise<NavigationStepResult> {
    return driver.evaluate(async (params: {
      parentId?: string;
      label: string;
      iconTestId?: string;
      submenuItemSelector: string;
    }) => {
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

      // 1. Kích hoạt parent submenu trigger
      const parentTrigger = (
        (params.parentId ? document.querySelector(`[data-test-id="${params.parentId}"]`) : null) ||
        Array.from(document.querySelectorAll('.fui-MenuItem, [role="menuitem"]')).find(el => (el.textContent || "").includes("GPT"))
      ) as HTMLElement | null;

      if (!parentTrigger) {
        return { success: false, clicked: false, alreadyChecked: false, reason: "Không tìm thấy Parent Submenu trigger" };
      }

      parentTrigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      parentTrigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      parentTrigger.click();
      await sleep(350);

      // 2. Tìm và click sub-item
      const subItems = Array.from(document.querySelectorAll(params.submenuItemSelector)) as HTMLElement[];
      const targetSub = subItems.find(el => {
        const hasText = (el.textContent || "").includes(params.label);
        const hasIcon = params.iconTestId ? Boolean(el.querySelector(`[data-testid="${params.iconTestId}"]`)) : false;
        return hasText || hasIcon;
      });

      if (!targetSub) {
        return { success: false, clicked: false, alreadyChecked: false, reason: `Không tìm thấy submenu item '${params.label}'` };
      }

      if (targetSub.getAttribute("aria-checked") === "true") {
        return { success: true, clicked: false, alreadyChecked: true };
      }

      targetSub.click();
      targetSub.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return { success: true, clicked: true, alreadyChecked: false };
    }, {
      parentId: spec.parentMenuIdentifier,
      label: spec.label,
      iconTestId: spec.iconTestId,
      submenuItemSelector: this.config.submenuItemSelector,
    });
  }

  public async closeMenu(driver: IDomDriver): Promise<void> {
    await driver.pressKey("Escape");
  }
}
