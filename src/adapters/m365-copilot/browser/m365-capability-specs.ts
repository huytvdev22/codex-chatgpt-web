import { ModelSpecDto } from "../../base-web/model-selection/dto/model-spec.dto";
import type { M365CapabilityMode } from "../../../m365-models";

export interface M365CapabilitySpec {
  readonly mode: M365CapabilityMode;
  readonly label: string;
  readonly iconTestId: string;
  readonly isSubmenu?: boolean;
  readonly parentMenuTestId?: string;
}

/**
 * Bản ghi đặc tả năng lực nguyên bản của M365 Copilot (Bảo toàn tương thích ngược)
 */
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

/**
 * Danh mục ModelSpecDto chuẩn Clean OOP cho M365 Copilot
 */
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
