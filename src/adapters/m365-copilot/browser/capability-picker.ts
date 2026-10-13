import type { Page } from "playwright-core";
import { BaseModelSelector } from "../../base-web/model-selection/core/base-model-selector";
import { SingleLevelMenuStrategy } from "../../base-web/model-selection/strategies/single-level-menu-strategy";
import { NestedSubmenuStrategy } from "../../base-web/model-selection/strategies/nested-submenu-strategy";
import type { ModelSpecDto } from "../../base-web/model-selection/dto/model-spec.dto";
import type { IModelVerifier } from "../../base-web/model-selection/contracts/model-verifier.interface";
import type { IMenuNavigationStrategy } from "../../base-web/model-selection/contracts/menu-navigation-strategy.interface";
import {
  resolveM365CapabilityMode,
  type M365CapabilityMode,
} from "../../../m365-models";
import {
  M365_CAPABILITY_SPECS,
  M365_MODEL_SPECS_MAP,
  type M365CapabilitySpec,
} from "./m365-capability-specs";
import { M365ModelVerifier } from "./m365-model-verifier";

export type { M365CapabilityMode, M365CapabilitySpec };
export { resolveM365CapabilityMode, M365_CAPABILITY_SPECS, M365_MODEL_SPECS_MAP, M365ModelVerifier };

export interface IM365CapabilityPicker {
  ensureMode(page: Page, targetMode: M365CapabilityMode): Promise<boolean>;
}

/**
 * Lớp điều khiển Capability Picker trên giao diện M365 Copilot Web
 * Kế thừa BaseModelSelector theo chuẩn Enterprise Clean OOP
 */
export class M365CapabilityPicker
  extends BaseModelSelector<M365CapabilityMode>
  implements IM365CapabilityPicker {

  readonly selectorName = "m365-capability";

  protected readonly modelVerifier: IModelVerifier<M365CapabilityMode>;
  protected readonly navigationStrategies: readonly IMenuNavigationStrategy<M365CapabilityMode>[];
  protected readonly specsMap: ReadonlyMap<M365CapabilityMode, ModelSpecDto<M365CapabilityMode>>;

  constructor() {
    super();
    this.modelVerifier = new M365ModelVerifier();

    const triggerSelector = 'button[aria-haspopup="menu"], div[aria-haspopup="menu"], [data-testid*="capability" i]';
    const knownModes = ["Auto", "Quick response", "Think deeper", "GPT", "GPT 5.6"];

    // Chiến lược 1: Menu phẳng 1 cấp (Auto, Quick, Think)
    const singleLevel = new SingleLevelMenuStrategy<M365CapabilityMode>({
      triggerSelector,
      itemSelector: '.fui-MenuItem[role="menuitemradio"], [role="menuitemradio"]',
      knownTriggerTexts: knownModes,
    });

    // Chiến lược 2: Submenu phân cấp OpenAI GPT (GPT-5.6 Think / Quick)
    const nestedSubmenu = new NestedSubmenuStrategy<M365CapabilityMode>({
      triggerSelector,
      submenuItemSelector: '.fui-MenuItem[role="menuitemradio"], [role="menuitemradio"]',
      knownTriggerTexts: knownModes,
    });

    this.navigationStrategies = [singleLevel, nestedSubmenu];
    this.specsMap = M365_MODEL_SPECS_MAP;
  }

  public resolveMode(modelSlug?: string, reasoning?: string): M365CapabilityMode {
    return resolveM365CapabilityMode(modelSlug, reasoning);
  }
}

export const defaultCapabilityPicker = new M365CapabilityPicker();

/**
 * Kiểm tra và kích hoạt chế độ năng lực (Capability Mode) mục tiêu trên giao diện M365 Copilot.
 * Đảm bảo 100% Backward Compatibility.
 */
export async function ensureM365CapabilityMode(page: Page, targetMode: M365CapabilityMode): Promise<boolean> {
  return defaultCapabilityPicker.ensureMode(page, targetMode);
}
