/**
 * Các interface và type dùng chung cho tầng quản lý Model (`src/models/`).
 * Tầng này hoàn toàn độc lập, đóng vai trò contract để mọi adapter kế thừa `BaseModelProvider`
 * khai báo danh sách model và mức reasoning cung cấp cho Codex.
 */

/** Đối tượng JSON phẳng biểu diễn từng entry model trong `/v1/models` và `catalog.json`. */
export type JsonObject = Record<string, unknown>;

/** Mức độ suy luận chuẩn mà Codex gửi qua API hoặc chọn trên UI. */
export type ModelReasoningEffort = "low" | "medium" | "high";

/** Dữ liệu đầu vào mà model hỗ trợ (văn bản, hình ảnh). */
export type ModelInputModality = "text" | "image";

/** Định danh duy nhất của một adapter provider (ví dụ: `"m365-copilot"`). */
export type ModelProviderId = string;

/** Ánh xạ giữa mức reasoning của Codex (`effort`) và mode nội bộ của adapter (`mode`). */
export interface ModelReasoningLevel<TMode extends string = string> {
  readonly effort: ModelReasoningEffort;
  readonly description: string;
  readonly mode?: TMode;
}

/**
 * Đặc tả một route model mà adapter cung cấp cho Codex.
 * Dùng làm nguồn dữ liệu duy nhất để sinh entry cho `catalog.json` và định tuyến `/v1/responses`.
 */
export interface ModelRouteDefinition<TMode extends string = string> {
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  readonly contextWindow: number;
  readonly autoCompactTokenLimit: number;
  readonly effectiveContextWindowPercent: number;
  readonly inputModalities: readonly ModelInputModality[];
  readonly defaultReasoningLevel: ModelReasoningEffort;
  readonly reasoningLevels: readonly ModelReasoningLevel<TMode>[];
}

/** Contract tối thiểu mà mỗi Model Provider (`BaseModelProvider`) phải công bố. */
export interface ModelProviderDefinition<
  TRoute extends ModelRouteDefinition = ModelRouteDefinition,
> {
  readonly id: ModelProviderId;
  readonly exactSlugs: readonly string[];
  readonly slugPrefixes: readonly string[];
  readonly routes: readonly TRoute[];
}
