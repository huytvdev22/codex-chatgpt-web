import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import type { BaseModelProvider } from "./base-model-provider";
import type {
  DiscoveredModelEntry,
  M365DiscoveredCapabilityMeta,
  ManagedModelDefaults,
  ManagedModelsSnapshot,
  ManagedModelView,
  ManagedProviderGroupView,
  ModelInputModality,
  ModelProviderId,
  ModelReasoningEffort,
  ModelRouteDefinition,
  ModelStoreFile,
  ModelUserOverride,
  ProviderDiscoveryCache,
} from "./types";

const MIN_CONTEXT_WINDOW = 4_096;
const MAX_CONTEXT_WINDOW = 10_000_000;
const MODEL_FILE_NAME = "models.json";

export type ModelConfigErrorCode =
  | "AT_LEAST_ONE_MODEL_REQUIRED"
  | "MODEL_NOT_FOUND"
  | "PROVIDER_NOT_FOUND"
  | "INVALID_MODEL_PATCH";

export class ModelConfigError extends Error {
  constructor(
    public readonly code: ModelConfigErrorCode,
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "ModelConfigError";
  }
}

export interface ModelOverridePatch {
  enabled?: boolean;
  displayName?: string;
  description?: string;
  contextWindow?: number;
  autoCompactTokenLimit?: number;
  effectiveContextWindowPercent?: number;
  inputModalities?: readonly ModelInputModality[];
  defaultReasoningLevel?: ModelReasoningEffort;
  uiLabel?: string;
  shortUiVersion?: string;
  isAccountDefault?: boolean;
  remoteModelId?: string;
  capabilityMeta?: M365DiscoveredCapabilityMeta;
}

export interface DiscoveryMergeOutcome {
  readonly snapshot: ManagedModelsSnapshot;
  readonly addedCount: number;
  readonly updatedCount: number;
  readonly unavailableCount: number;
  readonly discoveredCount: number;
  readonly autoEnabledSlug?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizePositiveInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) return undefined;
  return rounded;
}

function sanitizeInputModalities(value: unknown): ModelInputModality[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = new Set<ModelInputModality>(["text"]);
  if (value.includes("image")) {
    result.add("image");
  }
  return [...result];
}

function sanitizeReasoningEffort(value: unknown): ModelReasoningEffort | undefined {
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
}

function sanitizeM365CapabilityMeta(value: unknown): M365DiscoveredCapabilityMeta | undefined {
  if (!isPlainObject(value)) return undefined;
  const label = typeof value.label === "string" ? value.label.trim() : "";
  if (!label) return undefined;
  const aliases = Array.isArray(value.aliases)
    ? value.aliases.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : undefined;
  return {
    label,
    ...(typeof value.quickLabel === "string" && value.quickLabel.trim()
      ? { quickLabel: value.quickLabel.trim() }
      : {}),
    ...(typeof value.thinkLabel === "string" && value.thinkLabel.trim()
      ? { thinkLabel: value.thinkLabel.trim() }
      : {}),
    ...(aliases && aliases.length > 0 ? { aliases } : {}),
    ...(typeof value.itemTestId === "string" && value.itemTestId.trim()
      ? { itemTestId: value.itemTestId.trim() }
      : {}),
    ...(typeof value.iconTestId === "string" && value.iconTestId.trim()
      ? { iconTestId: value.iconTestId.trim() }
      : {}),
    ...(typeof value.quickItemTestId === "string" && value.quickItemTestId.trim()
      ? { quickItemTestId: value.quickItemTestId.trim() }
      : {}),
    ...(typeof value.quickIconTestId === "string" && value.quickIconTestId.trim()
      ? { quickIconTestId: value.quickIconTestId.trim() }
      : {}),
    ...(typeof value.thinkItemTestId === "string" && value.thinkItemTestId.trim()
      ? { thinkItemTestId: value.thinkItemTestId.trim() }
      : {}),
    ...(typeof value.thinkIconTestId === "string" && value.thinkIconTestId.trim()
      ? { thinkIconTestId: value.thinkIconTestId.trim() }
      : {}),
    ...(typeof value.isSubmenu === "boolean" ? { isSubmenu: value.isSubmenu } : {}),
    ...(typeof value.parentMenuTestId === "string" && value.parentMenuTestId.trim()
      ? { parentMenuTestId: value.parentMenuTestId.trim() }
      : {}),
    ...(typeof value.parentLabel === "string" && value.parentLabel.trim()
      ? { parentLabel: value.parentLabel.trim() }
      : {}),
  };
}

function sanitizeDiscoveredEntry(raw: unknown, fallbackProviderId?: string): DiscoveredModelEntry | undefined {
  if (!isPlainObject(raw)) return undefined;
  const slug = typeof raw.slug === "string" ? raw.slug.trim() : "";
  const providerId = typeof raw.providerId === "string" && raw.providerId.trim()
    ? raw.providerId.trim()
    : (fallbackProviderId ?? "");
  const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  if (!slug || !providerId || !displayName) return undefined;

  const contextWindow = sanitizePositiveInt(raw.contextWindow, MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW);
  const inputModalities = sanitizeInputModalities(raw.inputModalities);
  const defaultReasoningLevel = sanitizeReasoningEffort(raw.defaultReasoningLevel);
  const capabilityMeta = sanitizeM365CapabilityMeta(raw.capabilityMeta);

  return {
    slug,
    providerId,
    displayName,
    ...(typeof raw.description === "string" && raw.description.trim()
      ? { description: raw.description.trim() }
      : {}),
    ...(typeof raw.remoteModelId === "string" && raw.remoteModelId.trim()
      ? { remoteModelId: raw.remoteModelId.trim() }
      : {}),
    ...(typeof raw.uiLabel === "string" && raw.uiLabel.trim()
      ? { uiLabel: raw.uiLabel.trim() }
      : {}),
    ...(typeof raw.shortUiVersion === "string" && raw.shortUiVersion.trim()
      ? { shortUiVersion: raw.shortUiVersion.trim() }
      : {}),
    ...(typeof raw.isAccountDefault === "boolean"
      ? { isAccountDefault: raw.isAccountDefault }
      : {}),
    ...(capabilityMeta ? { capabilityMeta } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
    available: raw.available !== false,
  };
}

function sanitizeOverride(raw: unknown): ModelUserOverride | undefined {
  if (!isPlainObject(raw)) return undefined;
  const next: ModelUserOverride = {};
  if (typeof raw.enabled === "boolean") next.enabled = raw.enabled;
  if (typeof raw.displayName === "string" && raw.displayName.trim()) {
    next.displayName = raw.displayName.trim().slice(0, 120);
  }
  if (typeof raw.description === "string" && raw.description.trim()) {
    next.description = raw.description.trim().slice(0, 400);
  }
  const contextWindow = sanitizePositiveInt(raw.contextWindow, MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW);
  if (contextWindow !== undefined) next.contextWindow = contextWindow;
  const autoCompactTokenLimit = sanitizePositiveInt(raw.autoCompactTokenLimit, 1024, MAX_CONTEXT_WINDOW);
  if (autoCompactTokenLimit !== undefined) next.autoCompactTokenLimit = autoCompactTokenLimit;
  const effectiveContextWindowPercent = sanitizePositiveInt(raw.effectiveContextWindowPercent, 10, 100);
  if (effectiveContextWindowPercent !== undefined) {
    next.effectiveContextWindowPercent = effectiveContextWindowPercent;
  }
  const inputModalities = sanitizeInputModalities(raw.inputModalities);
  if (inputModalities) next.inputModalities = inputModalities;
  const defaultReasoningLevel = sanitizeReasoningEffort(raw.defaultReasoningLevel);
  if (defaultReasoningLevel) next.defaultReasoningLevel = defaultReasoningLevel;
  if (typeof raw.uiLabel === "string" && raw.uiLabel.trim()) {
    next.uiLabel = raw.uiLabel.trim().slice(0, 120);
  }
  if (typeof raw.shortUiVersion === "string" && raw.shortUiVersion.trim()) {
    next.shortUiVersion = raw.shortUiVersion.trim().slice(0, 32);
  }
  if (typeof raw.isAccountDefault === "boolean") next.isAccountDefault = raw.isAccountDefault;
  if (typeof raw.remoteModelId === "string" && raw.remoteModelId.trim()) {
    next.remoteModelId = raw.remoteModelId.trim().slice(0, 120);
  }
  const capabilityMeta = sanitizeM365CapabilityMeta(raw.capabilityMeta);
  if (capabilityMeta) next.capabilityMeta = capabilityMeta;
  return Object.keys(next).length > 0 ? next : undefined;
}

function createEmptyStoreFile(): ModelStoreFile {
  return {
    version: 1,
    updatedAt: null,
    providers: {},
    overrides: {},
  };
}

function sanitizeStoreFile(raw: unknown): ModelStoreFile {
  if (!isPlainObject(raw)) return createEmptyStoreFile();
  const providers: Record<string, ProviderDiscoveryCache> = {};
  if (isPlainObject(raw.providers)) {
    for (const [providerId, rawCache] of Object.entries(raw.providers)) {
      if (!isPlainObject(rawCache)) continue;
      const seen = new Set<string>();
      const models: DiscoveredModelEntry[] = [];
      if (Array.isArray(rawCache.models)) {
        for (const item of rawCache.models) {
          const sanitized = sanitizeDiscoveredEntry(item, providerId);
          if (!sanitized || seen.has(sanitized.slug)) continue;
          seen.add(sanitized.slug);
          models.push(sanitized);
        }
      }
      providers[providerId] = {
        lastRefreshedAt: typeof rawCache.lastRefreshedAt === "string" ? rawCache.lastRefreshedAt : null,
        lastError: typeof rawCache.lastError === "string" ? rawCache.lastError : null,
        models,
      };
    }
  }

  const overrides: Record<string, ModelUserOverride> = {};
  if (isPlainObject(raw.overrides)) {
    for (const [slug, rawOverride] of Object.entries(raw.overrides)) {
      const cleanedSlug = slug.trim();
      if (!cleanedSlug) continue;
      const sanitized = sanitizeOverride(rawOverride);
      if (sanitized) overrides[cleanedSlug] = sanitized;
    }
  }

  return {
    version: 1,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    providers,
    overrides,
  };
}

/**
 * Service quản lý trạng thái bật/tắt, metadata ghi đè (overlay) và cache auto-discovery
 * tại `~/.codex-m365-copilot/models.json`.
 */
export class ModelConfigStore {
  private static readonly defaultInstance = new ModelConfigStore();

  private cachedSnapshot:
    | { path: string; mtimeMs: number; size: number; file: ModelStoreFile }
    | null = null;

  constructor(private readonly homeDirProvider: () => string = getConfigDir) {}

  public static getInstance(): ModelConfigStore {
    return ModelConfigStore.defaultInstance;
  }

  public getConfigPath(): string {
    return join(this.homeDirProvider(), MODEL_FILE_NAME);
  }

  /** Đọc file `models.json` kèm kiểm tra `mtimeMs` + `size` để hot-reload ngay khi file thay đổi trên đĩa. */
  public readFile(): ModelStoreFile {
    const filePath = this.getConfigPath();
    if (!existsSync(filePath)) {
      this.cachedSnapshot = null;
      return createEmptyStoreFile();
    }

    try {
      const stats = statSync(filePath);
      if (
        this.cachedSnapshot &&
        this.cachedSnapshot.path === filePath &&
        this.cachedSnapshot.mtimeMs === stats.mtimeMs &&
        this.cachedSnapshot.size === stats.size
      ) {
        return structuredClone(this.cachedSnapshot.file);
      }
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      const file = sanitizeStoreFile(parsed);
      this.cachedSnapshot = {
        path: filePath,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        file: structuredClone(file),
      };
      return file;
    } catch {
      return createEmptyStoreFile();
    }
  }

  private writeFile(nextFile: ModelStoreFile): ModelStoreFile {
    const filePath = this.getConfigPath();
    const cleaned = sanitizeStoreFile({
      ...nextFile,
      version: 1,
      updatedAt: new Date().toISOString(),
    });
    atomicWriteFile(filePath, `${JSON.stringify(cleaned, null, 2)}\n`);
    try {
      const stats = statSync(filePath);
      this.cachedSnapshot = {
        path: filePath,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        file: structuredClone(cleaned),
      };
    } catch {
      this.cachedSnapshot = null;
    }
    return cleaned;
  }

  public invalidateCache(): void {
    this.cachedSnapshot = null;
  }

  /** Hợp nhất danh sách model của toàn bộ provider theo thứ tự: Built-in -> Discovery Cache -> User Overrides. */
  public resolveSnapshot(
    providers: readonly BaseModelProvider[],
    file: ModelStoreFile = this.readFile(),
  ): ManagedModelsSnapshot {
    const groups: ManagedProviderGroupView[] = [];
    let totalEnabledCount = 0;

    for (const provider of providers) {
      const group = this.resolveProviderGroup(provider, file);
      groups.push(group);
      totalEnabledCount += group.enabledCount;
    }

    return {
      version: 1,
      updatedAt: file.updatedAt,
      configPath: this.getConfigPath(),
      totalEnabledCount,
      providers: groups,
    };
  }

  /** Tra cứu route hợp nhất (built-in + discovery + override) cho một `provider` và `modelId`. */
  public findResolvedRoute(
    provider: BaseModelProvider,
    modelId: string,
  ): ModelRouteDefinition | undefined {
    const group = this.resolveProviderGroup(provider, this.readFile());
    const exact = group.models.find(model => model.slug === modelId);
    if (exact) return exact.route;
    const fallback = provider.findRoute(modelId);
    if (fallback) {
      return group.models.find(model => model.slug === fallback.slug)?.route ?? fallback;
    }
    return undefined;
  }

  private resolveProviderGroup(
    provider: BaseModelProvider,
    file: ModelStoreFile,
  ): ManagedProviderGroupView {
    const cache = file.providers[provider.id];
    const hasDiscoveryCache = Boolean(cache?.lastRefreshedAt);
    const items: Array<{
      baseRoute: ModelRouteDefinition;
      source: "builtin" | "discovered";
      available: boolean;
      defaultEnabled: boolean;
    }> = [];

    if (!hasDiscoveryCache) {
      for (const route of provider.routes) {
        items.push({
          baseRoute: route,
          source: "builtin",
          available: true,
          defaultEnabled: true,
        });
      }
    } else {
      const seenSlugs = new Set<string>();
      for (const entry of cache!.models) {
        if (seenSlugs.has(entry.slug)) continue;
        const builtin = provider.routes.find(route => route.slug === entry.slug);
        if (builtin) {
          seenSlugs.add(entry.slug);
          items.push({
            baseRoute: this.mergeDiscoveredIntoBuiltin(builtin, entry),
            source: "builtin",
            available: entry.available !== false,
            defaultEnabled: true,
          });
          continue;
        }
        const builtRoute = provider.buildRouteFromDiscovered(entry);
        if (!builtRoute) continue;
        seenSlugs.add(builtRoute.slug);
        items.push({
          baseRoute: builtRoute,
          source: "discovered",
          available: entry.available !== false,
          defaultEnabled: false,
        });
      }

      // Giữ lại mọi built-in route không thấy khi refresh gần nhất dưới trạng thái unavailable.
      for (const builtin of provider.routes) {
        if (seenSlugs.has(builtin.slug)) continue;
        seenSlugs.add(builtin.slug);
        items.push({
          baseRoute: builtin,
          source: "builtin",
          available: false,
          defaultEnabled: true,
        });
      }
    }

    const models: ManagedModelView[] = items.map(item =>
      this.applyOverride(provider.id, item, file.overrides[item.baseRoute.slug]),
    );
    const enabledCount = models.filter(model => model.effectiveEnabled).length;
    const availableCount = models.filter(model => model.available).length;

    return {
      providerId: provider.id,
      lastRefreshedAt: cache?.lastRefreshedAt ?? null,
      lastError: cache?.lastError ?? null,
      enabledCount,
      availableCount,
      totalCount: models.length,
      models,
    };
  }

  private mergeDiscoveredIntoBuiltin(
    builtin: ModelRouteDefinition,
    entry: DiscoveredModelEntry,
  ): ModelRouteDefinition {
    return {
      ...builtin,
      ...(entry.remoteModelId ? { remoteModelId: entry.remoteModelId } : {}),
      ...(entry.uiLabel ? { uiLabel: entry.uiLabel } : {}),
      ...(entry.shortUiVersion ? { shortUiVersion: entry.shortUiVersion } : {}),
      ...(entry.isAccountDefault !== undefined
        ? { isAccountDefault: entry.isAccountDefault }
        : {}),
      ...(entry.capabilityMeta ? { capabilityMeta: entry.capabilityMeta } : {}),
      ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
    };
  }

  private applyOverride(
    providerId: ModelProviderId,
    item: {
      baseRoute: ModelRouteDefinition;
      source: "builtin" | "discovered";
      available: boolean;
      defaultEnabled: boolean;
    },
    override?: ModelUserOverride,
  ): ManagedModelView {
    const { baseRoute, source, available, defaultEnabled } = item;
    const defaults: ManagedModelDefaults = {
      enabled: defaultEnabled,
      displayName: baseRoute.displayName,
      description: baseRoute.description,
      contextWindow: baseRoute.contextWindow,
      autoCompactTokenLimit: baseRoute.autoCompactTokenLimit,
      effectiveContextWindowPercent: baseRoute.effectiveContextWindowPercent,
      inputModalities: [...baseRoute.inputModalities],
      defaultReasoningLevel: baseRoute.defaultReasoningLevel,
    };

    const enabled = override?.enabled ?? defaults.enabled;
    const effectiveEnabled = available && enabled;
    const displayName = override?.displayName ?? defaults.displayName;
    const description = override?.description ?? defaults.description;
    const contextWindow = override?.contextWindow ?? defaults.contextWindow;
    const effectiveContextWindowPercent =
      override?.effectiveContextWindowPercent ?? defaults.effectiveContextWindowPercent;

    const autoCompactTokenLimit = override?.autoCompactTokenLimit !== undefined
      ? Math.min(contextWindow, override.autoCompactTokenLimit)
      : override?.contextWindow !== undefined || override?.effectiveContextWindowPercent !== undefined
        ? Math.max(1024, Math.min(contextWindow, Math.round(contextWindow * (effectiveContextWindowPercent / 100))))
        : defaults.autoCompactTokenLimit;

    const inputModalities: readonly ModelInputModality[] =
      override?.inputModalities ?? defaults.inputModalities;

    const supportedReasoningLevels = baseRoute.reasoningLevels.map(level => level.effort);
    const requestedDefaultReasoning = override?.defaultReasoningLevel ?? defaults.defaultReasoningLevel;
    const defaultReasoningLevel = supportedReasoningLevels.includes(requestedDefaultReasoning)
      ? requestedDefaultReasoning
      : defaults.defaultReasoningLevel;

    const route: ModelRouteDefinition = {
      ...baseRoute,
      displayName,
      description,
      contextWindow,
      autoCompactTokenLimit,
      effectiveContextWindowPercent,
      inputModalities,
      defaultReasoningLevel,
      ...(override?.uiLabel ? { uiLabel: override.uiLabel } : {}),
      ...(override?.shortUiVersion ? { shortUiVersion: override.shortUiVersion } : {}),
      ...(override?.isAccountDefault !== undefined ? { isAccountDefault: override.isAccountDefault } : {}),
      ...(override?.remoteModelId ? { remoteModelId: override.remoteModelId } : {}),
      ...(override?.capabilityMeta ? { capabilityMeta: override.capabilityMeta } : {}),
    };

    const customized =
      displayName !== defaults.displayName ||
      description !== defaults.description ||
      contextWindow !== defaults.contextWindow ||
      autoCompactTokenLimit !== defaults.autoCompactTokenLimit ||
      effectiveContextWindowPercent !== defaults.effectiveContextWindowPercent ||
      defaultReasoningLevel !== defaults.defaultReasoningLevel ||
      inputModalities.length !== defaults.inputModalities.length ||
      inputModalities.some((m, idx) => defaults.inputModalities[idx] !== m) ||
      Boolean(
        override?.uiLabel ||
        override?.shortUiVersion ||
        override?.isAccountDefault !== undefined ||
        override?.remoteModelId ||
        override?.capabilityMeta,
      );

    return {
      slug: route.slug,
      providerId,
      source,
      available,
      enabled,
      effectiveEnabled,
      customized,
      displayName,
      description,
      contextWindow,
      autoCompactTokenLimit,
      effectiveContextWindowPercent,
      inputModalities,
      defaultReasoningLevel,
      supportedReasoningLevels,
      defaults,
      route,
    };
  }

  private compactOverrideForModel(
    baseView: ManagedModelView,
    override: ModelUserOverride,
  ): ModelUserOverride | undefined {
    const next: ModelUserOverride = { ...override };
    if (next.enabled === baseView.defaults.enabled) delete next.enabled;
    if (next.displayName === baseView.defaults.displayName) delete next.displayName;
    if (next.description === baseView.defaults.description) delete next.description;
    if (next.contextWindow === baseView.defaults.contextWindow) {
      delete next.contextWindow;
      if (next.autoCompactTokenLimit === baseView.defaults.autoCompactTokenLimit) {
        delete next.autoCompactTokenLimit;
      }
    }
    if (next.effectiveContextWindowPercent === baseView.defaults.effectiveContextWindowPercent) {
      delete next.effectiveContextWindowPercent;
    }
    if (next.defaultReasoningLevel === baseView.defaults.defaultReasoningLevel) {
      delete next.defaultReasoningLevel;
    }
    if (
      next.inputModalities &&
      next.inputModalities.length === baseView.defaults.inputModalities.length &&
      next.inputModalities.every((m, idx) => baseView.defaults.inputModalities[idx] === m)
    ) {
      delete next.inputModalities;
    }
    return Object.keys(next).length > 0 ? next : undefined;
  }

  private assertAtLeastOneEnabled(snapshot: ManagedModelsSnapshot): void {
    if (snapshot.totalEnabledCount < 1) {
      throw new ModelConfigError(
        "AT_LEAST_ONE_MODEL_REQUIRED",
        "At least one available model must remain enabled so Codex always has a valid model catalog.",
        400,
      );
    }
  }

  private findManagedModel(
    snapshot: ManagedModelsSnapshot,
    slug: string,
  ): ManagedModelView | undefined {
    for (const group of snapshot.providers) {
      const match = group.models.find(model => model.slug === slug);
      if (match) return match;
    }
    return undefined;
  }

  /** Cập nhật bật/tắt hoặc metadata tùy chỉnh cho một model và đồng bộ ra đĩa. */
  public updateOverride(
    providers: readonly BaseModelProvider[],
    slug: string,
    patch: ModelOverridePatch,
  ): ManagedModelsSnapshot {
    const currentFile = this.readFile();
    const currentSnapshot = this.resolveSnapshot(providers, currentFile);
    const target = this.findManagedModel(currentSnapshot, slug);
    if (!target) {
      throw new ModelConfigError("MODEL_NOT_FOUND", `Unknown model '${slug}'.`, 404);
    }

    const nextOverride: ModelUserOverride = { ...(currentFile.overrides[slug] ?? {}) };
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== "boolean") {
        throw new ModelConfigError("INVALID_MODEL_PATCH", "'enabled' must be a boolean", 400);
      }
      nextOverride.enabled = patch.enabled;
    }
    if (patch.displayName !== undefined) {
      const trimmed = typeof patch.displayName === "string" ? patch.displayName.trim() : "";
      if (!trimmed) {
        throw new ModelConfigError("INVALID_MODEL_PATCH", "'displayName' cannot be empty", 400);
      }
      nextOverride.displayName = trimmed.slice(0, 120);
    }
    if (patch.description !== undefined) {
      const trimmed = typeof patch.description === "string" ? patch.description.trim() : "";
      if (!trimmed) {
        delete nextOverride.description;
      } else {
        nextOverride.description = trimmed.slice(0, 400);
      }
    }
    if (patch.contextWindow !== undefined) {
      const parsed = sanitizePositiveInt(patch.contextWindow, MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW);
      if (parsed === undefined) {
        throw new ModelConfigError(
          "INVALID_MODEL_PATCH",
          `'contextWindow' must be an integer between ${MIN_CONTEXT_WINDOW} and ${MAX_CONTEXT_WINDOW}`,
          400,
        );
      }
      nextOverride.contextWindow = parsed;
      // Khi user chỉ chỉnh Context Window (không truyền autoCompact riêng), xóa autoCompact cũ để tự tính 90%.
      if (patch.autoCompactTokenLimit === undefined) {
        delete nextOverride.autoCompactTokenLimit;
      }
    }
    if (patch.autoCompactTokenLimit !== undefined) {
      const maxLimit = nextOverride.contextWindow ?? target.contextWindow;
      const parsed = sanitizePositiveInt(patch.autoCompactTokenLimit, 1024, maxLimit);
      if (parsed === undefined) {
        throw new ModelConfigError(
          "INVALID_MODEL_PATCH",
          `'autoCompactTokenLimit' must be between 1024 and ${maxLimit}`,
          400,
        );
      }
      nextOverride.autoCompactTokenLimit = parsed;
    }
    if (patch.effectiveContextWindowPercent !== undefined) {
      const parsed = sanitizePositiveInt(patch.effectiveContextWindowPercent, 10, 100);
      if (parsed === undefined) {
        throw new ModelConfigError(
          "INVALID_MODEL_PATCH",
          "'effectiveContextWindowPercent' must be between 10 and 100",
          400,
        );
      }
      nextOverride.effectiveContextWindowPercent = parsed;
    }
    if (patch.inputModalities !== undefined) {
      const sanitized = sanitizeInputModalities(patch.inputModalities);
      if (!sanitized) {
        throw new ModelConfigError("INVALID_MODEL_PATCH", "'inputModalities' must be an array", 400);
      }
      nextOverride.inputModalities = sanitized;
    }
    if (patch.defaultReasoningLevel !== undefined) {
      const effort = sanitizeReasoningEffort(patch.defaultReasoningLevel);
      if (!effort || !target.supportedReasoningLevels.includes(effort)) {
        throw new ModelConfigError(
          "INVALID_MODEL_PATCH",
          `'defaultReasoningLevel' must be one of: ${target.supportedReasoningLevels.join(", ")}`,
          400,
        );
      }
      nextOverride.defaultReasoningLevel = effort;
    }
    if (patch.uiLabel !== undefined && patch.uiLabel.trim()) {
      nextOverride.uiLabel = patch.uiLabel.trim().slice(0, 120);
    }
    if (patch.shortUiVersion !== undefined && patch.shortUiVersion.trim()) {
      nextOverride.shortUiVersion = patch.shortUiVersion.trim().slice(0, 32);
    }
    if (patch.isAccountDefault !== undefined) {
      nextOverride.isAccountDefault = patch.isAccountDefault;
    }
    if (patch.remoteModelId !== undefined && patch.remoteModelId.trim()) {
      nextOverride.remoteModelId = patch.remoteModelId.trim().slice(0, 120);
    }
    if (patch.capabilityMeta !== undefined) {
      nextOverride.capabilityMeta = patch.capabilityMeta;
    }

    const nextOverrides = { ...currentFile.overrides };
    const compacted = this.compactOverrideForModel(target, nextOverride);
    if (compacted) {
      nextOverrides[slug] = compacted;
    } else {
      delete nextOverrides[slug];
    }

    const nextFile: ModelStoreFile = {
      ...currentFile,
      overrides: nextOverrides,
    };
    const nextSnapshot = this.resolveSnapshot(providers, nextFile);
    this.assertAtLeastOneEnabled(nextSnapshot);
    const written = this.writeFile(nextFile);
    return this.resolveSnapshot(providers, written);
  }

  /** Bật/tắt nhanh toàn bộ các model khả dụng của một provider (vẫn bảo vệ quy tắc >= 1 model bật). */
  public setProviderEnabled(
    providers: readonly BaseModelProvider[],
    providerId: ModelProviderId,
    enabled: boolean,
  ): ManagedModelsSnapshot {
    const providerExists = providers.some(provider => provider.id === providerId);
    if (!providerExists) {
      throw new ModelConfigError("PROVIDER_NOT_FOUND", `Unknown provider '${providerId}'.`, 404);
    }

    const currentFile = this.readFile();
    const currentSnapshot = this.resolveSnapshot(providers, currentFile);
    const group = currentSnapshot.providers.find(item => item.providerId === providerId);
    if (!group) {
      throw new ModelConfigError("PROVIDER_NOT_FOUND", `Unknown provider '${providerId}'.`, 404);
    }

    const nextOverrides = { ...currentFile.overrides };
    for (const model of group.models) {
      if (!model.available) continue;
      const merged: ModelUserOverride = { ...(nextOverrides[model.slug] ?? {}), enabled };
      const compacted = this.compactOverrideForModel(model, merged);
      if (compacted) {
        nextOverrides[model.slug] = compacted;
      } else {
        delete nextOverrides[model.slug];
      }
    }

    const nextFile: ModelStoreFile = {
      ...currentFile,
      overrides: nextOverrides,
    };
    const nextSnapshot = this.resolveSnapshot(providers, nextFile);
    this.assertAtLeastOneEnabled(nextSnapshot);
    const written = this.writeFile(nextFile);
    return this.resolveSnapshot(providers, written);
  }

  /** Khôi phục một model về thông số mặc định (xóa user override của model đó). */
  public resetModel(
    providers: readonly BaseModelProvider[],
    slug: string,
  ): ManagedModelsSnapshot {
    const currentFile = this.readFile();
    const currentSnapshot = this.resolveSnapshot(providers, currentFile);
    if (!this.findManagedModel(currentSnapshot, slug)) {
      throw new ModelConfigError("MODEL_NOT_FOUND", `Unknown model '${slug}'.`, 404);
    }

    const nextOverrides = { ...currentFile.overrides };
    delete nextOverrides[slug];
    const nextFile: ModelStoreFile = {
      ...currentFile,
      overrides: nextOverrides,
    };
    const nextSnapshot = this.resolveSnapshot(providers, nextFile);
    this.assertAtLeastOneEnabled(nextSnapshot);
    const written = this.writeFile(nextFile);
    return this.resolveSnapshot(providers, written);
  }

  /** Xóa toàn bộ cache discovery và mọi override, đưa hệ thống về đúng danh mục built-in mặc định. */
  public resetAll(providers: readonly BaseModelProvider[]): ManagedModelsSnapshot {
    const written = this.writeFile(createEmptyStoreFile());
    return this.resolveSnapshot(providers, written);
  }

  /** Hợp nhất kết quả quét model sống từ adapter vào cache provider mà giữ nguyên ON/OFF & overrides của user. */
  public applyDiscoveryResult(
    providers: readonly BaseModelProvider[],
    providerId: ModelProviderId,
    discovered: readonly DiscoveredModelEntry[],
  ): DiscoveryMergeOutcome {
    const provider = providers.find(item => item.id === providerId);
    if (!provider) {
      throw new ModelConfigError("PROVIDER_NOT_FOUND", `Unknown provider '${providerId}'.`, 404);
    }
    if (discovered.length === 0) {
      throw new ModelConfigError(
        "INVALID_MODEL_PATCH",
        `Discovery for provider '${providerId}' returned no models.`,
        400,
      );
    }

    const currentFile = this.readFile();
    const prevCache = currentFile.providers[providerId];
    const prevBySlug = new Map((prevCache?.models ?? []).map(item => [item.slug, item]));
    const builtinSlugs = new Set(provider.routes.map(route => route.slug));

    const dedupedIncoming: DiscoveredModelEntry[] = [];
    const incomingSlugs = new Set<string>();
    for (const rawEntry of discovered) {
      const sanitized = sanitizeDiscoveredEntry({ ...rawEntry, providerId, available: true }, providerId);
      if (!sanitized || incomingSlugs.has(sanitized.slug)) continue;
      incomingSlugs.add(sanitized.slug);
      dedupedIncoming.push(sanitized);
    }

    let addedCount = 0;
    let updatedCount = 0;
    for (const entry of dedupedIncoming) {
      const existedPreviously = prevBySlug.has(entry.slug) || (!prevCache?.lastRefreshedAt && builtinSlugs.has(entry.slug));
      if (existedPreviously) updatedCount += 1;
      else addedCount += 1;
    }

    const nextModels: DiscoveredModelEntry[] = [...dedupedIncoming];
    let unavailableCount = 0;

    // Giữ lại các model từng quét thấy (hoặc built-in) nhưng biến mất lần này dưới trạng thái unavailable.
    for (const oldEntry of prevCache?.models ?? []) {
      if (incomingSlugs.has(oldEntry.slug)) continue;
      nextModels.push({ ...oldEntry, available: false });
      unavailableCount += 1;
    }
    for (const builtinRoute of provider.routes) {
      if (incomingSlugs.has(builtinRoute.slug)) continue;
      if (nextModels.some(item => item.slug === builtinRoute.slug)) continue;
      nextModels.push({
        slug: builtinRoute.slug,
        providerId,
        displayName: builtinRoute.displayName,
        description: builtinRoute.description,
        ...(builtinRoute.uiLabel ? { uiLabel: builtinRoute.uiLabel } : {}),
        ...(builtinRoute.shortUiVersion ? { shortUiVersion: builtinRoute.shortUiVersion } : {}),
        ...(builtinRoute.isAccountDefault !== undefined
          ? { isAccountDefault: builtinRoute.isAccountDefault }
          : {}),
        ...(builtinRoute.capabilityMeta ? { capabilityMeta: builtinRoute.capabilityMeta } : {}),
        contextWindow: builtinRoute.contextWindow,
        inputModalities: [...builtinRoute.inputModalities],
        defaultReasoningLevel: builtinRoute.defaultReasoningLevel,
        available: false,
      });
      unavailableCount += 1;
    }

    const nextFile: ModelStoreFile = {
      ...currentFile,
      providers: {
        ...currentFile.providers,
        [providerId]: {
          lastRefreshedAt: new Date().toISOString(),
          lastError: null,
          models: nextModels,
        },
      },
      overrides: { ...currentFile.overrides },
    };

    let autoEnabledSlug: string | undefined;
    const candidateSnapshot = this.resolveSnapshot(providers, nextFile);
    if (candidateSnapshot.totalEnabledCount < 1) {
      const group = candidateSnapshot.providers.find(item => item.providerId === providerId);
      const fallbackModel =
        group?.models.find(m => m.available && m.route.isAccountDefault) ??
        group?.models.find(m => m.available);
      if (fallbackModel) {
        nextFile.overrides[fallbackModel.slug] = {
          ...(nextFile.overrides[fallbackModel.slug] ?? {}),
          enabled: true,
        };
        autoEnabledSlug = fallbackModel.slug;
      }
    }

    const finalSnapshot = this.resolveSnapshot(providers, nextFile);
    this.assertAtLeastOneEnabled(finalSnapshot);
    const written = this.writeFile(nextFile);

    return {
      snapshot: this.resolveSnapshot(providers, written),
      addedCount,
      updatedCount,
      unavailableCount,
      discoveredCount: dedupedIncoming.length,
      ...(autoEnabledSlug ? { autoEnabledSlug } : {}),
    };
  }

  /** Ghi nhận lỗi refresh gần nhất mà vẫn bảo toàn nguyên vẹn danh sách model & overrides đã cache. */
  public recordDiscoveryError(
    providers: readonly BaseModelProvider[],
    providerId: ModelProviderId,
    errorMessage: string,
  ): ManagedModelsSnapshot {
    const providerExists = providers.some(provider => provider.id === providerId);
    if (!providerExists) {
      throw new ModelConfigError("PROVIDER_NOT_FOUND", `Unknown provider '${providerId}'.`, 404);
    }
    const currentFile = this.readFile();
    const prevCache = currentFile.providers[providerId];
    const nextFile: ModelStoreFile = {
      ...currentFile,
      providers: {
        ...currentFile.providers,
        [providerId]: {
          lastRefreshedAt: prevCache?.lastRefreshedAt ?? null,
          lastError: errorMessage.trim().slice(0, 500) || "Model discovery failed",
          models: prevCache?.models ?? [],
        },
      },
    };
    const written = this.writeFile(nextFile);
    return this.resolveSnapshot(providers, written);
  }
}
