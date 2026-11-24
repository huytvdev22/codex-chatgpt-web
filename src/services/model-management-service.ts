import { AdapterRegistry } from "../adapters/adapter-registry";
import { activeWebTurnRegistry, ProviderBusyError } from "../adapters/web";
import type { AppConfig } from "../config";
import { ModelCatalog } from "../models/model-catalog";
import {
  ModelConfigError,
  type ModelOverridePatch,
} from "../models/model-config-store";
import { ModelRegistry } from "../models/model-registry";
import type {
  ManagedModelsSnapshot,
  ProviderRefreshResult,
} from "../models/types";

export interface RefreshModelsOutcome {
  readonly snapshot: ManagedModelsSnapshot;
  readonly results: readonly ProviderRefreshResult[];
}

/**
 * Tầng nghiệp vụ điều phối quản lý danh mục model, đồng bộ nóng `catalog.json`
 * và chạy Auto-Discovery (`adapter.discoverModels`) theo từng provider.
 */
export class ModelManagementService {
  constructor(
    private readonly modelRegistry: ModelRegistry = ModelRegistry.getInstance(),
    private readonly modelCatalog: ModelCatalog = ModelCatalog.getInstance(),
    private readonly adapterRegistry: AdapterRegistry = AdapterRegistry.getInstance(),
  ) {}

  public getSnapshot(): ManagedModelsSnapshot {
    return this.modelRegistry.getManagedSnapshot();
  }

  public updateOverride(
    slug: string,
    patch: ModelOverridePatch,
    config: AppConfig,
  ): ManagedModelsSnapshot {
    const snapshot = this.modelRegistry
      .getConfigStore()
      .updateOverride(this.modelRegistry.listProviders(), slug, patch);
    this.modelCatalog.buildAndSyncCatalog(config);
    return snapshot;
  }

  public toggleProvider(
    providerId: string,
    enabled: boolean,
    config: AppConfig,
  ): ManagedModelsSnapshot {
    const snapshot = this.modelRegistry
      .getConfigStore()
      .setProviderEnabled(this.modelRegistry.listProviders(), providerId, enabled);
    this.modelCatalog.buildAndSyncCatalog(config);
    return snapshot;
  }

  public resetModel(slug: string, config: AppConfig): ManagedModelsSnapshot {
    const snapshot = this.modelRegistry
      .getConfigStore()
      .resetModel(this.modelRegistry.listProviders(), slug);
    this.modelCatalog.buildAndSyncCatalog(config);
    return snapshot;
  }

  public resetAll(config: AppConfig): ManagedModelsSnapshot {
    const snapshot = this.modelRegistry
      .getConfigStore()
      .resetAll(this.modelRegistry.listProviders());
    this.modelCatalog.buildAndSyncCatalog(config);
    return snapshot;
  }

  public async refreshModels(
    providerId: string | undefined,
    config: AppConfig,
    abortSignal?: AbortSignal,
  ): Promise<RefreshModelsOutcome> {
    const providers = this.modelRegistry.listProviders();
    const store = this.modelRegistry.getConfigStore();

    if (providerId) {
      const target = this.modelRegistry.getProvider(providerId);
      if (!target) {
        throw new ModelConfigError(
          "PROVIDER_NOT_FOUND",
          `Unknown provider '${providerId}'.`,
          404,
        );
      }
      if (activeWebTurnRegistry.hasActiveTurnForProvider(target.id)) {
        throw new ProviderBusyError(target.id);
      }
    }

    const targets = providerId
      ? providers.filter(provider => provider.id === providerId)
      : providers;
    const isSingleTarget = Boolean(providerId);
    const results: ProviderRefreshResult[] = [];
    let anySucceeded = false;

    for (const provider of targets) {
      if (activeWebTurnRegistry.hasActiveTurnForProvider(provider.id)) {
        const busyError = new ProviderBusyError(provider.id);
        if (isSingleTarget) throw busyError;
        results.push({
          providerId: provider.id,
          status: "busy",
          addedCount: 0,
          updatedCount: 0,
          unavailableCount: 0,
          discoveredCount: 0,
          message: busyError.message,
        });
        continue;
      }

      try {
        const adapter = this.adapterRegistry.createAdapter(provider.id);
        if (typeof adapter.discoverModels !== "function") {
          throw new Error(
            `Provider '${provider.id}' does not support live model discovery.`,
          );
        }
        const discovered = await adapter.discoverModels({
          headers: new Headers(),
          abortSignal,
        });
        const merged = store.applyDiscoveryResult(providers, provider.id, discovered);
        anySucceeded = true;
        results.push({
          providerId: provider.id,
          status: "ok",
          addedCount: merged.addedCount,
          updatedCount: merged.updatedCount,
          unavailableCount: merged.unavailableCount,
          discoveredCount: merged.discoveredCount,
          ...(merged.autoEnabledSlug ? { autoEnabledSlug: merged.autoEnabledSlug } : {}),
        });
      } catch (error) {
        if (error instanceof ProviderBusyError && isSingleTarget) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof ProviderBusyError) {
          results.push({
            providerId: provider.id,
            status: "busy",
            addedCount: 0,
            updatedCount: 0,
            unavailableCount: 0,
            discoveredCount: 0,
            message,
          });
          continue;
        }
        store.recordDiscoveryError(providers, provider.id, message);
        results.push({
          providerId: provider.id,
          status: "error",
          addedCount: 0,
          updatedCount: 0,
          unavailableCount: 0,
          discoveredCount: 0,
          message,
        });
      }
    }

    if (anySucceeded) {
      this.modelCatalog.buildAndSyncCatalog(config);
    }

    return {
      snapshot: this.getSnapshot(),
      results,
    };
  }
}
