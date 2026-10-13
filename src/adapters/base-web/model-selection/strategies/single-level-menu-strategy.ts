import type { IMenuNavigationStrategy, NavigationStepResult } from "../contracts/menu-navigation-strategy.interface";
import type { IDomDriver } from "../contracts/dom-driver.interface";
import type { ModelSpecDto } from "../dto/model-spec.dto";

export interface SingleLevelMenuConfig {
  triggerSelector: string;
  itemSelector: string;
  menuContainerSelector?: string;
  knownTriggerTexts?: readonly string[];
}

/**
 * Chiến lược click chọn model trong menu phẳng (1 cấp)
 */
export class SingleLevelMenuStrategy<TMode extends string = string>
  implements IMenuNavigationStrategy<TMode> {

  readonly strategyName = "SingleLevelMenuStrategy";

  constructor(private readonly config: SingleLevelMenuConfig) {}

  public supports(spec: ModelSpecDto<TMode>): boolean {
    return !spec.isSubmenu;
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
    return driver.evaluate((params: { itemSelector: string; label: string; iconTestId?: string }) => {
      const items = Array.from(document.querySelectorAll(params.itemSelector)) as HTMLElement[];
      const target = items.find(el => {
        const hasText = (el.textContent || "").includes(params.label);
        const hasIcon = params.iconTestId ? Boolean(el.querySelector(`[data-testid="${params.iconTestId}"]`)) : false;
        return hasText || hasIcon;
      });

      if (!target) {
        return { success: false, clicked: false, alreadyChecked: false, reason: `Không tìm thấy item '${params.label}' trong menu` };
      }

      if (target.getAttribute("aria-checked") === "true") {
        return { success: true, clicked: false, alreadyChecked: true };
      }

      target.click();
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return { success: true, clicked: true, alreadyChecked: false };
    }, {
      itemSelector: this.config.itemSelector,
      label: spec.label,
      iconTestId: spec.iconTestId,
    });
  }

  public async closeMenu(driver: IDomDriver): Promise<void> {
    await driver.pressKey("Escape");
  }
}
