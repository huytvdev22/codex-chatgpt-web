import type { AppConfig } from "../config";
import { atomicWriteFile, getConfigDir } from "../config";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BaseModelProvider } from "./base-model-provider";
import { ModelRegistry } from "./model-registry";
import type { JsonObject, ModelRouteDefinition } from "./types";

/**
 * Service cố định (Singleton + hỗ trợ DI qua `ModelRegistry`) chịu trách nhiệm dựng
 * danh sách model cho endpoint `/v1/models` và đồng bộ file `catalog.json` của Codex.
 *
 * Nguyên tắc hoạt động:
 * - **Adapter-only (không có native fallback):** Chỉ expose các model đến từ adapter đã đăng ký
 *   trong `ModelRegistry` (không trộn model gốc của OpenAI hay đọc `~/.codex/models_cache.json`).
 * - Giao toàn bộ phần dựng entry cho `provider.buildCatalogModel()` và phần kiểm tra đồng bộ
 *   cho `provider.isCatalogSynced()` (Template Method trên `BaseModelProvider`).
 */
export class ModelCatalog {
  private static readonly defaultInstance = new ModelCatalog(
    ModelRegistry.getInstance(),
  );

  constructor(
    private readonly registry: ModelRegistry = ModelRegistry.getInstance(),
  ) {}

  /** Trả về instance mặc định toàn cục gắn với `ModelRegistry.getInstance()`. */
  public static getInstance(): ModelCatalog {
    return ModelCatalog.defaultInstance;
  }

  /** Trả về đường dẫn file `catalog.json` do bridge quản lý trong thư mục cấu hình. */
  public getManagedCatalogPath(home = getConfigDir()): string {
    return join(home, "catalog.json");
  }

  /** Dựng một JSON model entry từ `route` thông qua provider sở hữu route đó. */
  public buildProviderModel(
    route: ModelRouteDefinition,
    config: AppConfig,
    provider: BaseModelProvider | undefined = this.registry.findProvider(route.slug),
  ): JsonObject {
    if (!provider) {
      throw new Error(`No registered ModelProvider for route: ${route.slug}`);
    }
    return provider.buildCatalogModel(route, config);
  }

  /** Tổng hợp toàn bộ `{ models }` từ mọi provider đang đăng ký trong `ModelRegistry`. */
  public buildCatalog(config: AppConfig): { models: JsonObject[] } {
    const seen = new Set<string>();
    const models: JsonObject[] = [];
    for (const provider of this.registry.listProviders()) {
      for (const route of provider.routes) {
        if (seen.has(route.slug)) continue;
        seen.add(route.slug);
        models.push(provider.buildCatalogModel(route, config));
      }
    }
    return { models };
  }

  /** Ghi đè an toàn (atomic) object catalog ra file `catalog.json` trên đĩa. */
  public syncManagedCatalogFile(
    catalog: unknown,
    catalogPath = this.getManagedCatalogPath(),
  ): void {
    try {
      atomicWriteFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
    } catch {
      // non-fatal if cannot write
    }
  }

  /** Dựng catalog mới nhất từ registry rồi ghi đồng bộ ngay xuống file `catalog.json` (dùng cho `GET /v1/models`). */
  public buildAndSyncCatalog(
    config: AppConfig,
    options: { catalogPath?: string } = {},
  ): { models: JsonObject[] } {
    const catalog = this.buildCatalog(config);
    this.syncManagedCatalogFile(catalog, options.catalogPath);
    return catalog;
  }

  /** Đảm bảo file `catalog.json` tồn tại và đồng bộ với các provider hiện tại (tự rebuild nếu bị cũ hoặc lẫn model lạ). */
  public ensureManagedCatalogFile(
    config: AppConfig,
    catalogPath = this.getManagedCatalogPath(),
    force = false,
  ): string {
    try {
      if (force || !existsSync(catalogPath) || !this.hasSyncedProviderSurfaces(catalogPath)) {
        this.buildAndSyncCatalog(config, { catalogPath });
      }
    } catch {
      // non-fatal
    }
    return catalogPath;
  }

  /** Xác minh file `catalog.json` hiện có không chứa model lạ ngoài registry và đạt chuẩn `isCatalogSynced` của từng provider. */
  private hasSyncedProviderSurfaces(catalogPath: string): boolean {
    try {
      const raw: unknown = JSON.parse(readFileSync(catalogPath, "utf8"));
      if (!ModelCatalog.isJsonObject(raw) || !Array.isArray(raw.models)) return false;

      const groupedByProvider = new Map<string, JsonObject[]>();
      for (const model of raw.models) {
        if (!ModelCatalog.isJsonObject(model) || typeof model.slug !== "string") return false;
        const provider = this.registry.findProvider(model.slug);
        if (!provider) return false;
        const entries = groupedByProvider.get(provider.id) ?? [];
        entries.push(model);
        groupedByProvider.set(provider.id, entries);
      }

      return this.registry.listProviders().every(provider =>
        provider.isCatalogSynced(groupedByProvider.get(provider.id) ?? []),
      );
    } catch {
      return false;
    }
  }

  private static isJsonObject(value: unknown): value is JsonObject {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
}
