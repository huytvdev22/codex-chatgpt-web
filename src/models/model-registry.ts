import type { BaseModelProvider } from "./base-model-provider";
import type {
  ModelProviderId,
  ModelReasoningLevel,
  ModelRouteDefinition,
} from "./types";
import { M365ModelProvider } from "../adapters/m365-copilot/model-provider";
import { AiStudioModelProvider } from "../adapters/ai-studio/model-provider";
import { AiStudioPlaywrightModelProvider } from "../adapters/ai-studio-pw/model-provider";

/**
 * Registry trung tâm (Singleton + hỗ trợ DI khi test) quản lý toàn bộ `BaseModelProvider` đã đăng ký.
 *
 * Vai trò:
 * - Cố định hoàn toàn với hạ tầng (không phụ thuộc logic riêng của từng web UI).
 * - Khi tích hợp adapter mới, chỉ cần đăng ký instance `...ModelProvider.getInstance()` tại đây hoặc qua `register()`.
 * - Cung cấp API tra cứu thống nhất cho `Server`, `ModelCatalog` và `CodexIntegration`.
 */
export class ModelRegistry {
  private static readonly defaultInstance = new ModelRegistry([
    M365ModelProvider.getInstance(),
    AiStudioModelProvider.getInstance(),
    AiStudioPlaywrightModelProvider.getInstance(),
  ]);

  private readonly providers: BaseModelProvider[];
  private readonly providerMap: Map<ModelProviderId, BaseModelProvider>;

  constructor(providers: readonly BaseModelProvider[] = []) {
    this.providers = [...providers];
    this.providerMap = new Map(
      providers.map(provider => [provider.id, provider]),
    );
  }

  /** Trả về instance mặc định toàn cục đã nạp sẵn các adapter đang bật. */
  public static getInstance(): ModelRegistry {
    return ModelRegistry.defaultInstance;
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

  /** Trả về toàn bộ danh sách route model (của 1 provider hoặc tất cả provider). */
  public listRoutes(providerId?: ModelProviderId): readonly ModelRouteDefinition[] {
    if (providerId) {
      return this.providerMap.get(providerId)?.routes ?? [];
    }
    return this.providers.flatMap(provider => provider.routes);
  }

  /** Tìm đặc tả route khớp với `modelId`. */
  public findRoute(modelId: string): ModelRouteDefinition | undefined {
    return this.findProvider(modelId)?.findRoute(modelId);
  }

  /** Lấy đặc tả route của `modelId` hoặc ném lỗi nếu model không được adapter hỗ trợ. */
  public requireRoute(modelId: string): ModelRouteDefinition {
    const route = this.findRoute(modelId);
    if (!route) throw new Error(`Model không tồn tại: ${modelId}`);
    return route;
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
