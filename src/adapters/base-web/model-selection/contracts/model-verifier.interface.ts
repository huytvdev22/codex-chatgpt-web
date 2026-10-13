import type { ModelSpecDto } from "../dto/model-spec.dto";
import type { IDomDriver } from "./dom-driver.interface";

/**
 * Hợp đồng kiểm chứng trạng thái model trên UI (Trực thuộc Verify Step)
 */
export interface IModelVerifier<TMode extends string = string> {
  isModelActive(driver: IDomDriver, spec: ModelSpecDto<TMode>): Promise<boolean>;
}
