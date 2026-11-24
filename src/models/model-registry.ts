import type { BaseModelProvider } from "./base-model-provider";
import { ModelConfigStore } from "./model-config-store";
import type {
  ManagedModelsSnapshot,
  ManagedModelView,
  ModelProviderId,
  ModelReasoningLevel,
  ModelResolutionStatus,
  ModelRouteDefinition,
} from "./types";
import { M365ModelProvider } from "../adapters/m365-copilot/model-provider";
import { AiStudioModelProvider } from "../adapters/ai-studio/model-provider";
import { ChatGptModelProvider } from "../adapters/chatgpt/model-provider";

/**
 * Registry trung tâm (Singleton + hỗ trợ DI khi test) quản lý toàn bộ `BaseModelProvider` đã đăng ký,
 * kết hợp cùng `ModelConfigStore` (`models.json`) để tra cứu danh sách model hợp nhất và trạng thái ON/OFF.
 */
export class ModelRegistry {
  private static readonly defaultInstance = new ModelRegistry([
    M365ModelProvider.getInstance(),
    AiStudioModelProvider.getInstance(),
    ChatGptModelProvider.getInstance(),
  ]);

  private readonly providers: BaseModelProvider[];
  private readonly providerMap: Map<ModelProviderId, BaseModelProvider>;

  constructor(
    providers: readonly BaseModelProvider[] = [],
    private readonly configStore: ModelConfigStore = ModelConfigStore.getInstance(),
  ) {
    this.providers = [...providers];
    this.providerMap = new Map(
      providers.map(provider => [provider.id, provider]),
    );
  }

  /** Trả về instance mặc định toàn cục đã nạp sẵn các adapter đang bật. */
  public static getInstance(): ModelRegistry {
    return ModelRegistry.defaultInstance;
  }

  public getConfigStore(): ModelConfigStore {
    return this.configStore;
  }

  /** Đăng ký hoặc ghi đè một `BaseModelProvider` theo `provider.id`. */
  public register(provider: BaseModelProvider): this {
    this.providerMap.set(provider.id, provider);
    const existingIndex = this.providers.findIndex(item => item.id === provider.id);
    if (existingIndex >= 0) {
      this.providers[existingIndex] = provider;
    } else {
      this.providers.push(provider);
    }
    return this;
  }

  /** Liệt kê toàn bộ provider hiện đang có trong registry. */
  public listProviders(): readonly BaseModelProvider[] {
    return this.providers;
  }

  /** Lấy trực tiếp provider theo `providerId` (ví dụ `"m365-copilot"`). */
  public getProvider(providerId: ModelProviderId): BaseModelProvider | undefined {
    return this.providerMap.get(providerId);
  }

  /** Tìm provider khớp với `modelId` (dựa trên `exactSlugs` hoặc `slugPrefixes`). */
  public findProvider(modelId: string): BaseModelProvider | undefined {
    return this.providers.find(provider => provider.matchModelSlug(modelId));
  }

  /** Kiểm tra `modelId` có thuộc về đúng `providerId` chỉ định hay không. */
  public isProviderModel(modelId: string, providerId: ModelProviderId): boolean {
    return this.findProvider(modelId)?.id === providerId;
  }

  /** Trả về ảnh chụp cấu hình model đầy đủ (built-in + discovery cache + user overrides). */
  public getManagedSnapshot(): ManagedModelsSnapshot {
    return this.configStore.resolveSnapshot(this.providers);
  }

  /** Trả về danh sách view quản lý từng model (của 1 provider hoặc tất cả). */
  public listManagedModels(providerId?: ModelProviderId): readonly ManagedModelView[] {
    const snapshot = this.getManagedSnapshot();
    if (providerId) {
      return snapshot.providers.find(group => group.providerId === providerId)?.models ?? [];
    }
    return snapshot.providers.flatMap(group => group.models);
  }

  /** Trả về toàn bộ danh sách route model hợp nhất (bao gồm cả model đang tắt). */
  public listRoutes(providerId?: ModelProviderId): readonly ModelRouteDefinition[] {
    return this.listManagedModels(providerId).map(model => model.route);
  }

  /** Chỉ trả về các route model đang khả dụng và được bật ON (dùng cho `catalog.json` & `/v1/models`). */
  public listEnabledRoutes(providerId?: ModelProviderId): readonly ModelRouteDefinition[] {
    return this.listManagedModels(providerId)
      .filter(model => model.effectiveEnabled)
      .map(model => model.route);
  }

  /** Tìm đặc tả route hợp nhất khớp với `modelId` (kể cả alias mặc định của provider như `"chatgpt"`). */
  public findRoute(modelId: string): ModelRouteDefinition | undefined {
    const provider = this.findProvider(modelId);
    if (!provider) return undefined;
    const models = this.listManagedModels(provider.id);
    const exact = models.find(model => model.slug === modelId);
    if (exact) return exact.route;

    const providerFallback = provider.findRoute(modelId);
    if (providerFallback) {
      return models.find(model => model.slug === providerFallback.slug)?.route ?? providerFallback;
    }
    return undefined;
  }

  /** Kiểm tra trạng thái cho phép chạy của `modelId` (enabled / disabled / unavailable / unknown). */
  public getModelStatus(modelId: string): ModelResolutionStatus {
    const provider = this.findProvider(modelId);
    if (!provider) {
      return { status: "unknown", requestedModel: modelId };
    }

    const models = this.listManagedModels(provider.id);
    const exact = models.find(model => model.slug === modelId);
    if (exact) {
      return {
        status: !exact.available ? "unavailable" : exact.enabled ? "enabled" : "disabled",
        requestedModel: modelId,
        providerId: provider.id,
        route: exact.route,
        managed: exact,
      };
    }

    const fallbackRoute = provider.findRoute(modelId);
    if (fallbackRoute) {
      const managedFallback = models.find(model => model.slug === fallbackRoute.slug);
      if (managedFallback) {
        return {
          status: !managedFallback.available
            ? "unavailable"
            : managedFallback.enabled
              ? "enabled"
              : "disabled",
          requestedModel: modelId,
          providerId: provider.id,
          route: managedFallback.route,
          managed: managedFallback,
        };
      }
      return {
        status: "enabled",
        requestedModel: modelId,
        providerId: provider.id,
        route: fallbackRoute,
      };
    }

    const firstEnabled = models.find(model => model.effectiveEnabled);
    if (firstEnabled) {
      return {
        status: "enabled",
        requestedModel: modelId,
        providerId: provider.id,
        route: firstEnabled.route,
        managed: firstEnabled,
      };
    }

    const anyUnavailable = models.some(model => !model.available);
    return {
      status: anyUnavailable && models.every(model => !model.available) ? "unavailable" : "disabled",
      requestedModel: modelId,
      providerId: provider.id,
    };
  }

  /** Lấy đặc tả route của `modelId` hoặc ném lỗi nếu model không được adapter hỗ trợ. */
  public requireRoute(modelId: string): ModelRouteDefinition {
    const route = this.findRoute(modelId);
    if (!route) throw new Error(`Model không tồn tại: ${modelId}`);
    return route;
  }

  /**
   * Kiểm tra quyền gọi `requestedModel` cho các endpoint `/v1/responses` và `/v2/responses`:
   * trả về `BaseModelProvider` khi bật, hoặc thông báo lỗi thống nhất khi model tắt/không khả dụng/lạ.
   */
  public resolveProviderAccess(requestedModel: unknown):
    | { ok: true; provider: BaseModelProvider; requestedModel: string; route?: ModelRouteDefinition }
    | { ok: false; message: string } {
    if (typeof requestedModel !== "string" || requestedModel.trim().length === 0) {
      return { ok: false, message: "Missing or invalid 'model' parameter" };
    }
    const cleanModel = requestedModel.trim();
    const status = this.getModelStatus(cleanModel);
    if (status.status === "disabled") {
      return {
        ok: false,
        message: `Model '${cleanModel}' is disabled in Models settings. Enable it in the Models menu to use it.`,
      };
    }
    if (status.status === "unavailable") {
      return {
        ok: false,
        message: `Model '${cleanModel}' is currently unavailable on provider '${status.providerId}'. Refresh models or check your active account.`,
      };
    }
    if (status.status === "enabled" && status.providerId) {
      const provider = this.getProvider(status.providerId);
      if (provider) {
        return { ok: true, provider, requestedModel: cleanModel, route: status.route };
      }
    }

    const enabledProviders = this.providers.map(item => item.id);
    const suffix = enabledProviders.length > 0
      ? `Enabled providers: ${enabledProviders.join(", ")}.`
      : "No model providers are enabled.";
    return {
      ok: false,
      message: `Unsupported model '${cleanModel}'. ${suffix}`,
    };
  }

  /** Phân giải mức reasoning từ yêu cầu của client hoặc quay về mức mặc định của route. */
  public resolveReasoning(
    route: ModelRouteDefinition,
    requestedEffort?: string,
  ): ModelReasoningLevel {
    return route.reasoningLevels.find(level => level.effort === requestedEffort)
      ?? route.reasoningLevels.find(level => level.effort === route.defaultReasoningLevel)
      ?? route.reasoningLevels[0]!;
  }
}
