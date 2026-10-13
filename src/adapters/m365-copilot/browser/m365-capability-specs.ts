import type { Page } from "playwright-core";
import {
  BaseModelSelector,
  ModelSpecDto,
  SingleLevelMenuStrategy,
  NestedSubmenuStrategy,
  type IModelVerifier,
  type IMenuNavigationStrategy,
  type IDomDriver,
} from "../../base-web/model-selection";
import {
  resolveM365CapabilityMode,
  type M365CapabilityMode,
} from "../../../m365-models";

export type { M365CapabilityMode };
export { resolveM365CapabilityMode };

export interface M365CapabilitySpec {
  readonly mode: M365CapabilityMode;
  readonly label: string;
  readonly iconTestId: string;
  readonly isSubmenu?: boolean;
  readonly parentMenuTestId?: string;
}

export const M365_CAPABILITY_SPECS: Record<M365CapabilityMode, M365CapabilitySpec> = {
  "auto": { mode: "auto", label: "Auto", iconTestId: "checkmark-Magic" },
  "quick": { mode: "quick", label: "Quick response", iconTestId: "checkmark-Chat" },
  "think": { mode: "think", label: "Think deeper", iconTestId: "checkmark-Reasoning" },
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

export const M365_MODEL_SPECS_MAP: ReadonlyMap<M365CapabilityMode, ModelSpecDto<M365CapabilityMode>> = (() => {
  const map = new Map<M365CapabilityMode, ModelSpecDto<M365CapabilityMode>>();
  for (const [k, v] of Object.entries(M365_CAPABILITY_SPECS)) {
    map.set(k as M365CapabilityMode, new ModelSpecDto({
      mode: v.mode,
      label: v.label,
      iconTestId: v.iconTestId,
      isSubmenu: v.isSubmenu,
      parentMenuIdentifier: v.parentMenuTestId,
    }));
  }
  return map;
})();

export class M365ModelVerifier implements IModelVerifier<M365CapabilityMode> {
  async isModelActive(driver: IDomDriver, spec: ModelSpecDto<M365CapabilityMode>): Promise<boolean> {
    return driver.evaluate((targetLabel: string) => {
      const triggers = Array.from(document.querySelectorAll(
        'button[aria-haspopup="menu"], div[aria-haspopup="menu"], [data-testid*="capability-picker" i], [aria-label*="model" i]'
      )) as HTMLElement[];
      return triggers.some(t => {
        const text = (t.textContent || "").trim();
        return text.includes(targetLabel);
      });
    }, spec.label);
  }
}

export class M365CapabilityPicker extends BaseModelSelector<M365CapabilityMode> {
  readonly selectorName = "m365-capability";
  protected readonly modelVerifier = new M365ModelVerifier();
  protected readonly specsMap = M365_MODEL_SPECS_MAP;
  protected readonly navigationStrategies: readonly IMenuNavigationStrategy<M365CapabilityMode>[];

  constructor() {
    super();
    const triggerSelector = 'button[aria-haspopup="menu"], div[aria-haspopup="menu"], [data-testid*="capability" i]';
    const knownModes = ["Auto", "Quick response", "Think deeper", "GPT", "GPT 5.6"];

    this.navigationStrategies = [
      new SingleLevelMenuStrategy<M365CapabilityMode>({
        triggerSelector,
        itemSelector: '.fui-MenuItem[role="menuitemradio"], [role="menuitemradio"]',
        knownTriggerTexts: knownModes,
      }),
      new NestedSubmenuStrategy<M365CapabilityMode>({
        triggerSelector,
        submenuItemSelector: '.fui-MenuItem[role="menuitemradio"], [role="menuitemradio"]',
        knownTriggerTexts: knownModes,
      }),
    ];
  }

  public resolveMode(modelSlug?: string, reasoning?: string): M365CapabilityMode {
    return resolveM365CapabilityMode(modelSlug, reasoning) || "auto";
  }

  protected resolveTargetSpec(rawMode: string): ModelSpecDto<M365CapabilityMode> | undefined {
    const mode = resolveM365CapabilityMode(rawMode) || "auto";
    return this.specsMap.get(mode);
  }

  protected async afterSelectionSettled(page: Page): Promise<void> {
    await page.keyboard.press("Escape").catch(() => {});
  }
}

export const defaultM365CapabilityPicker = new M365CapabilityPicker();
