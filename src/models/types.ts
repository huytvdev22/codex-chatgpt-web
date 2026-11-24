/**
 * Các interface và type dùng chung cho tầng quản lý Model (`src/models/`).
 * Tầng này hoàn toàn độc lập, đóng vai trò contract để mọi adapter kế thừa `BaseModelProvider`
 * khai báo danh sách model, mức reasoning, cấu hình overlay và auto-discovery.
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
 * Metadata chọn capability menu động cho model M365 Copilot khi được auto-discover từ DOM.
 */
export interface M365DiscoveredCapabilityMeta {
  readonly label: string;
  readonly quickLabel?: string;
  readonly thinkLabel?: string;
  readonly aliases?: readonly string[];
  readonly itemTestId?: string;
  readonly iconTestId?: string;
  readonly quickItemTestId?: string;
  readonly quickIconTestId?: string;
  readonly thinkItemTestId?: string;
  readonly thinkIconTestId?: string;
  readonly isSubmenu?: boolean;
  readonly parentMenuTestId?: string;
  readonly parentLabel?: string;
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
  readonly remoteModelId?: string;
  readonly uiLabel?: string;
  readonly shortUiVersion?: string;
  readonly isAccountDefault?: boolean;
  readonly capabilityMeta?: M365DiscoveredCapabilityMeta;
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

/**
 * Bản ghi model được mỗi adapter quét trực tiếp từ giao diện Web (Auto-Discovery).
 */
export interface DiscoveredModelEntry {
  readonly slug: string;
  readonly providerId: ModelProviderId;
  readonly displayName: string;
  readonly description?: string;
  readonly remoteModelId?: string;
  readonly uiLabel?: string;
  readonly shortUiVersion?: string;
  readonly isAccountDefault?: boolean;
  readonly capabilityMeta?: M365DiscoveredCapabilityMeta;
  readonly contextWindow?: number;
  readonly inputModalities?: readonly ModelInputModality[];
  readonly defaultReasoningLevel?: ModelReasoningEffort;
  readonly available?: boolean;
}

/**
 * Phần ghi đè của người dùng cho từng model trong `~/.codex-m365-copilot/models.json`.
 */
export interface ModelUserOverride {
  enabled?: boolean;
  displayName?: string;
  description?: string;
  contextWindow?: number;
  autoCompactTokenLimit?: number;
  effectiveContextWindowPercent?: number;
  inputModalities?: ModelInputModality[];
  defaultReasoningLevel?: ModelReasoningEffort;
  uiLabel?: string;
  shortUiVersion?: string;
  isAccountDefault?: boolean;
  remoteModelId?: string;
  capabilityMeta?: M365DiscoveredCapabilityMeta;
}

export interface ProviderDiscoveryCache {
  lastRefreshedAt: string | null;
  lastError: string | null;
  models: DiscoveredModelEntry[];
}

export interface ModelStoreFile {
  version: 1;
  updatedAt: string | null;
  providers: Record<string, ProviderDiscoveryCache>;
  overrides: Record<string, ModelUserOverride>;
}

export interface ManagedModelDefaults {
  readonly enabled: boolean;
  readonly displayName: string;
  readonly description: string;
  readonly contextWindow: number;
  readonly autoCompactTokenLimit: number;
  readonly effectiveContextWindowPercent: number;
  readonly inputModalities: readonly ModelInputModality[];
  readonly defaultReasoningLevel: ModelReasoningEffort;
}

export interface ManagedModelView {
  readonly slug: string;
  readonly providerId: ModelProviderId;
  readonly source: "builtin" | "discovered";
  readonly available: boolean;
  readonly enabled: boolean;
  readonly effectiveEnabled: boolean;
  readonly customized: boolean;
  readonly displayName: string;
  readonly description: string;
  readonly contextWindow: number;
  readonly autoCompactTokenLimit: number;
  readonly effectiveContextWindowPercent: number;
  readonly inputModalities: readonly ModelInputModality[];
  readonly defaultReasoningLevel: ModelReasoningEffort;
  readonly supportedReasoningLevels: readonly ModelReasoningEffort[];
  readonly defaults: ManagedModelDefaults;
  readonly route: ModelRouteDefinition;
}

export interface ManagedProviderGroupView {
  readonly providerId: ModelProviderId;
  readonly lastRefreshedAt: string | null;
  readonly lastError: string | null;
  readonly enabledCount: number;
  readonly availableCount: number;
  readonly totalCount: number;
  readonly models: readonly ManagedModelView[];
}

export interface ManagedModelsSnapshot {
  readonly version: 1;
  readonly updatedAt: string | null;
  readonly configPath: string;
  readonly totalEnabledCount: number;
  readonly providers: readonly ManagedProviderGroupView[];
}

export interface ProviderRefreshResult {
  readonly providerId: ModelProviderId;
  readonly status: "ok" | "busy" | "error";
  readonly addedCount: number;
  readonly updatedCount: number;
  readonly unavailableCount: number;
  readonly discoveredCount: number;
  readonly autoEnabledSlug?: string;
  readonly message?: string;
}

export interface ModelResolutionStatus {
  readonly status: "enabled" | "disabled" | "unavailable" | "unknown";
  readonly requestedModel: string;
  readonly providerId?: ModelProviderId;
  readonly route?: ModelRouteDefinition;
  readonly managed?: ManagedModelView;
}
