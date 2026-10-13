import type { ModelSpecDto } from "../dto/model-spec.dto";
import type { IDomDriver } from "./dom-driver.interface";

export interface NavigationStepResult {
  readonly success: boolean;
  readonly clicked: boolean;
  readonly alreadyChecked: boolean;
  readonly reason?: string;
}

/**
 * Hợp đồng chiến lược điều hướng và click chọn item trong menu
 */
export interface IMenuNavigationStrategy<TMode extends string = string> {
  readonly strategyName: string;
  supports(spec: ModelSpecDto<TMode>): boolean;
  openMenu(driver: IDomDriver): Promise<boolean>;
  selectItem(driver: IDomDriver, spec: ModelSpecDto<TMode>): Promise<NavigationStepResult>;
  closeMenu(driver: IDomDriver): Promise<void>;
}
