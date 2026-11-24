import type { AppConfig } from "../config";
import type {
  DiscoveredModelEntry,
  JsonObject,
  ModelProviderDefinition,
  ModelProviderId,
  ModelReasoningLevel,
  ModelRouteDefinition,
} from "./types";

/**
 * Abstract base class chuẩn OOP (Template Method Pattern) cho mỗi Adapter Model Provider.
 *
 * Trách nhiệm:
 * - Cố định khung xử lý chung: chuẩn hóa field JSON của Codex, khớp slug, phân giải reasoning,
 *   dựng catalog item, dựng route từ auto-discovery và kiểm tra đồng bộ file `catalog.json`.
 * - Khi thêm adapter mới, chỉ cần tạo `<adapter>/model-provider.ts` kế thừa `BaseModelProvider`,
 *   khai báo 4 thuộc tính abstract (`id`, `exactSlugs`, `slugPrefixes`, `routes`) và chỉ `override`
 *   các hook `protected`/`public` khi thực sự có hành vi khác biệt.
 */
export abstract class BaseModelProvider<
  TRoute extends ModelRouteDefinition = ModelRouteDefinition,
> implements ModelProviderDefinition<TRoute> {
  /** Bộ field mặc định chuẩn của một model entry trong Codex `catalog.json` và `/v1/models`. */
  protected static readonly CANONICAL_MODEL_DEFAULTS: JsonObject = {
    base_instructions:
      "You are Codex, a coding assistant. Answer the user's questions and help them solve tasks.",
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 10,
    additional_speed_tiers: [],
    service_tiers: [],
    available_access_programs: {
      cyber: ["standard"],
    },
    availability_nux: null,
    upgrade: null,
    model_messages: null,
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    default_reasoning_summary: "none",
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    truncation_policy: {
      mode: "tokens",
      limit: 10000,
    },
    supports_image_detail_original: true,
    supports_search_tool: true,
    supports_experimental_context: false,
    use_responses_lite: true,
    supports_reasoning_effort_updates: true,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    tool_mode: null,
    experimental_supported_tools: [],
    default_service_tier: null,
  };

  /** Định danh duy nhất của provider (abstract — subclass bắt buộc khai báo). */
  public abstract readonly id: ModelProviderId;
  /** Danh sách slug khớp chính xác (ví dụ: `["m365-copilot"]`). */
  public abstract readonly exactSlugs: readonly string[];
  /** Danh sách prefix slug thuộc provider (ví dụ: `["m365-copilot/"]`). */
  public abstract readonly slugPrefixes: readonly string[];
  /** Danh sách toàn bộ route model built-in mặc định mà provider cung cấp cho Codex. */
  public abstract readonly routes: readonly TRoute[];

  /**
   * Kiểm tra một `modelId` có thuộc phạm vi quản lý của provider này hay không.
   */
  public matchModelSlug(modelId: string): boolean {
    return this.exactSlugs.includes(modelId)
      || this.slugPrefixes.some(prefix => modelId.startsWith(prefix));
  }

  /**
   * Tìm route khớp chính xác với `modelId` trên tập built-in mặc định.
   */
  public findRoute(modelId: string): TRoute | undefined {
    return this.routes.find(route => route.slug === modelId);
  }

  /**
   * Dựng một route hoàn chỉnh từ kết quả auto-discovery của adapter.
   * Subclass override hook này để hỗ trợ thêm các model mới quét được từ Web UI.
   */
  public buildRouteFromDiscovered(_entry: DiscoveredModelEntry): TRoute | undefined {
    return undefined;
  }

  /**
   * Lấy route theo `modelId` hoặc ném lỗi nếu không tồn tại trong provider.
   */
  public requireRoute(modelId: string): TRoute {
    const route = this.findRoute(modelId);
    if (!route) {
      throw new Error(`Model không tồn tại trong provider ${this.id}: ${modelId}`);
    }
    return route;
  }

  /**
   * Phân giải mức reasoning từ yêu cầu đầu vào hoặc fallback về mặc định của route.
   */
  public resolveReasoning(
    route: TRoute,
    requestedEffort?: string,
  ): TRoute["reasoningLevels"][number] {
    return route.reasoningLevels.find(level => level.effort === requestedEffort)
      ?? route.reasoningLevels.find(level => level.effort === route.defaultReasoningLevel)
      ?? route.reasoningLevels[0]!;
  }

  /**
   * Lấy `mode` gắn với `modelId` và `requestedEffort` (nếu route có khai báo).
   */
  public resolveReasoningMode(
    modelId: string,
    requestedEffort?: string,
  ): TRoute["reasoningLevels"][number]["mode"] {
    return this.resolveReasoning(this.requireRoute(modelId), requestedEffort).mode;
  }

  /**
   * [Template Method] Dựng JSON model hoàn chỉnh theo chuẩn Codex từ một `route` của adapter.
   * Luồng cố định sẽ ghép `CANONICAL_MODEL_DEFAULTS` + metadata route + kết quả từ 3 hook `protected`:
   * `resolveMultiAgentVersion()`, `buildReasoningLevelEntry()`, và `buildModelOverrides()`.
   */
  public buildCatalogModel(
    route: TRoute,
    config: AppConfig,
  ): JsonObject {
    const multiAgentVersion = this.resolveMultiAgentVersion(config);
    return {
      ...structuredClone(BaseModelProvider.CANONICAL_MODEL_DEFAULTS),
      slug: route.slug,
      display_name: route.displayName,
      description: route.description,
      input_modalities: [...route.inputModalities],
      ...(multiAgentVersion ? { multi_agent_version: multiAgentVersion } : {}),
      default_reasoning_level: route.defaultReasoningLevel,
      supported_reasoning_levels: route.reasoningLevels.map(level =>
        this.buildReasoningLevelEntry(level),
      ),
      context_window: route.contextWindow,
      max_context_window: route.contextWindow,
      effective_context_window_percent: route.effectiveContextWindowPercent,
      auto_compact_token_limit: route.autoCompactTokenLimit,
      ...this.buildModelOverrides(route, config),
    };
  }

  /**
   * [Template Method] Kiểm tra các entry của provider trong `catalog.json` đã khớp với
   * danh sách route kỳ vọng (mặc định là `this.routes`, hoặc danh sách route đang bật) chưa.
   */
  public isCatalogSynced(
    storedProviderModels: readonly JsonObject[],
    expectedRoutes: readonly TRoute[] = this.routes,
  ): boolean {
    const visibleModels = storedProviderModels.filter(
      model => model.visibility !== "hide" && typeof model.slug === "string",
    );

    if (expectedRoutes.length === 0) {
      return visibleModels.length === 0;
    }
    if (visibleModels.length === 0) return false;

    const visibleSlugs = visibleModels.map(model => model.slug as string).sort();
    const expectedSlugs = expectedRoutes.map(route => route.slug).sort();

    if (
      visibleSlugs.length !== expectedSlugs.length
      || visibleSlugs.some((slug, index) => slug !== expectedSlugs[index])
    ) {
      return false;
    }

    return expectedRoutes.every(route => {
      const model = visibleModels.find(entry => entry.slug === route.slug);
      if (!model || !Array.isArray(model.input_modalities)) return false;
      if (
        model.display_name !== route.displayName ||
        model.default_reasoning_level !== route.defaultReasoningLevel ||
        model.context_window !== route.contextWindow ||
        model.max_context_window !== route.contextWindow ||
        model.effective_context_window_percent !== route.effectiveContextWindowPercent ||
        model.auto_compact_token_limit !== route.autoCompactTokenLimit
      ) {
        return false;
      }
      const modalities = model.input_modalities;
      return (
        modalities.length === route.inputModalities.length &&
        route.inputModalities.every(modality => modalities.includes(modality))
      );
    });
  }

  /**
   * [Hook] Cho phép subclass ghi đè `multi_agent_version` (`"v1"` / `"v2"` hoặc `undefined`) nếu có quy tắc riêng.
   */
  protected resolveMultiAgentVersion(config: AppConfig): string | undefined {
    return config.subagentProtocol === "compatibility-v1" ? "v1" : "v2";
  }

  /**
   * [Hook] Cho phép subclass tùy biến metadata từng mức reasoning trong `supported_reasoning_levels`.
   */
  protected buildReasoningLevelEntry(level: ModelReasoningLevel): JsonObject {
    return {
      effort: level.effort,
      description: level.description,
    };
  }

  /**
   * [Hook] Cho phép subclass bổ sung hoặc ghi đè các field JSON riêng biệt ở bước cuối của Template Method.
   */
  protected buildModelOverrides(
    _route: TRoute,
    _config: AppConfig,
  ): JsonObject {
    return {};
  }
}
