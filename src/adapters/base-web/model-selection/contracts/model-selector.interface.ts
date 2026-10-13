import type { ModelSelectionRequestDto } from "../dto/model-selection-request.dto";
import type { ModelSelectionResultDto } from "../dto/model-selection-result.dto";
import type { ModelSpecDto } from "../dto/model-spec.dto";
import type { IDomDriver } from "./dom-driver.interface";

/**
 * Hợp đồng dịch vụ chọn Model cấp cao (Public Service Interface)
 */
export interface IModelSelector<TMode extends string = string> {
  /**
   * Đảm bảo model mục tiêu được chọn trên giao diện
   */
  ensureModel(
    driver: IDomDriver,
    request: ModelSelectionRequestDto<TMode>
  ): Promise<ModelSelectionResultDto<TMode>>;

  /**
   * Phân giải từ raw slug hoặc reasoning sang TMode nội bộ
   */
  resolveMode(modelSlug?: string, reasoning?: string): TMode;

  /**
   * Lấy danh sách cấu hình của toàn bộ models được hỗ trợ
   */
  getSupportedSpecs(): ReadonlyMap<TMode, ModelSpecDto<TMode>>;
}
