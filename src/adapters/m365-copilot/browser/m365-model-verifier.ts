import type { IModelVerifier } from "../../base-web/model-selection/contracts/model-verifier.interface";
import type { IDomDriver } from "../../base-web/model-selection/contracts/dom-driver.interface";
import type { ModelSpecDto } from "../../base-web/model-selection/dto/model-spec.dto";
import type { M365CapabilityMode } from "../../../m365-models";

/**
 * Lớp kiểm chứng trạng thái model M365 Copilot trên giao diện người dùng
 * Triển khai IModelVerifier theo chuẩn Single Responsibility Principle
 */
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
