const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const MIN_CONTEXT_WINDOW = 4_096;
const MAX_CONTEXT_WINDOW = 10_000_000;

/**
 * Danh sách metadata tối thiểu của các built-in provider dùng khi Runtime đang tắt (offline fallback).
 * Luôn đồng bộ với `src/adapters/<provider>/model-provider.ts`.
 */
const BUILTIN_PROVIDERS = Object.freeze([
  {
    providerId: "m365-copilot",
    routes: [
      {
        slug: "m365-copilot/gpt-5.6",
        displayName: "M365 - GPT 5.6",
        description: "GPT 5.6 qua Microsoft 365 Copilot Web",
        contextWindow: 100_000,
        autoCompactTokenLimit: 90_000,
        effectiveContextWindowPercent: 90,
        inputModalities: ["text", "image"],
        defaultReasoningLevel: "low",
        supportedReasoningLevels: ["low", "high"],
      },
      {
        slug: "m365-copilot",
        displayName: "M365 Copilot",
        description: "Microsoft 365 Copilot Web",
        contextWindow: 100_000,
        autoCompactTokenLimit: 90_000,
        effectiveContextWindowPercent: 90,
        inputModalities: ["text", "image"],
        defaultReasoningLevel: "low",
        supportedReasoningLevels: ["low", "high"],
      },
    ],
  },
  {
    providerId: "ai-studio",
    routes: [
      {
        slug: "ai-studio/gemini-4-hydrogen",
        displayName: "Gemini 4 Hydrogen",
        description: "Gemini 4 Hydrogen qua Google AI Studio",
        contextWindow: 1_000_000,
        autoCompactTokenLimit: 900_000,
        effectiveContextWindowPercent: 90,
        inputModalities: ["text", "image"],
        defaultReasoningLevel: "high",
        supportedReasoningLevels: ["low", "medium", "high"],
      },
    ],
  },
  {
    providerId: "gemini",
    routes: [
      {
        slug: "gemini",
        displayName: "Gemini Web",
        description: "Gemini Web qua gemini.google.com",
        contextWindow: 1_000_000,
        autoCompactTokenLimit: 900_000,
        effectiveContextWindowPercent: 90,
        inputModalities: ["text", "image"],
        defaultReasoningLevel: "medium",
        supportedReasoningLevels: ["low", "medium", "high"],
      },
    ],
  },
  {
    providerId: "chatgpt",
    routes: [
      {
        slug: "chatgpt/gpt-6.2",
        displayName: "ChatGPT - GPT-6.2",
        description: "GPT-6.2 qua ChatGPT Web",
        contextWindow: 128_000,
        autoCompactTokenLimit: 115_000,
        effectiveContextWindowPercent: 90,
        inputModalities: ["text", "image"],
        defaultReasoningLevel: "medium",
        supportedReasoningLevels: ["low", "medium", "high"],
      },
      {
        slug: "chatgpt/gpt-6",
        displayName: "ChatGPT - GPT-6",
        description: "GPT-6 qua ChatGPT Web",
        contextWindow: 128_000,
        autoCompactTokenLimit: 115_000,
        effectiveContextWindowPercent: 90,
        inputModalities: ["text", "image"],
        defaultReasoningLevel: "medium",
        supportedReasoningLevels: ["low", "medium", "high"],
      },
      {
        slug: "chatgpt/gpt-5.6-sol",
        displayName: "ChatGPT - GPT-5.6 Sol",
        description: "GPT-5.6 Sol qua ChatGPT Web",
        contextWindow: 128_000,
        autoCompactTokenLimit: 115_000,
        effectiveContextWindowPercent: 90,
        inputModalities: ["text", "image"],
        defaultReasoningLevel: "medium",
        supportedReasoningLevels: ["low", "medium", "high"],
      },
    ],
  },
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function createEmptyStoreFile() {
  return {
    version: 1,
    updatedAt: null,
    providers: {},
    overrides: {},
  };
}

function readOfflineStoreFile(filePath) {
  if (!fs.existsSync(filePath)) return createEmptyStoreFile();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!isPlainObject(raw)) return createEmptyStoreFile();
    return {
      version: 1,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
      providers: isPlainObject(raw.providers) ? raw.providers : {},
      overrides: isPlainObject(raw.overrides) ? raw.overrides : {},
    };
  } catch {
    return createEmptyStoreFile();
  }
}

function sanitizeContextWindow(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded >= MIN_CONTEXT_WINDOW && rounded <= MAX_CONTEXT_WINDOW ? rounded : undefined;
}

function sanitizeReasoning(value, supported) {
  if (value === "low" || value === "medium" || value === "high") {
    return supported.includes(value) ? value : undefined;
  }
  return undefined;
}

function resolveOfflineSnapshot(filePath) {
  const file = readOfflineStoreFile(filePath);
  const providers = [];
  let totalEnabledCount = 0;

  for (const def of BUILTIN_PROVIDERS) {
    const cache = isPlainObject(file.providers[def.providerId]) ? file.providers[def.providerId] : null;
    const hasCache = Boolean(cache && typeof cache.lastRefreshedAt === "string");
    const baseEntries = [];

    if (!hasCache) {
      for (const route of def.routes) {
        baseEntries.push({
          ...route,
          source: "builtin",
          available: true,
          defaultEnabled: true,
        });
      }
    } else {
      const seen = new Set();
      for (const entry of Array.isArray(cache.models) ? cache.models : []) {
        if (!isPlainObject(entry) || typeof entry.slug !== "string" || seen.has(entry.slug)) continue;
        seen.add(entry.slug);
        const builtin = def.routes.find(r => r.slug === entry.slug);
        if (builtin) {
          baseEntries.push({
            ...builtin,
            contextWindow: sanitizeContextWindow(entry.contextWindow) ?? builtin.contextWindow,
            source: "builtin",
            available: entry.available !== false,
            defaultEnabled: true,
          });
        } else {
          const ctx = sanitizeContextWindow(entry.contextWindow) ?? def.routes[0].contextWindow;
          baseEntries.push({
            slug: entry.slug,
            displayName: typeof entry.displayName === "string" && entry.displayName.trim()
              ? entry.displayName.trim()
              : entry.slug,
            description: typeof entry.description === "string" ? entry.description : entry.slug,
            contextWindow: ctx,
            autoCompactTokenLimit: Math.round(ctx * 0.9),
            effectiveContextWindowPercent: 90,
            inputModalities: Array.isArray(entry.inputModalities) && entry.inputModalities.includes("image")
              ? ["text", "image"]
              : ["text"],
            defaultReasoningLevel: sanitizeReasoning(
              entry.defaultReasoningLevel,
              def.routes[0].supportedReasoningLevels,
            ) ?? def.routes[0].defaultReasoningLevel,
            supportedReasoningLevels: def.routes[0].supportedReasoningLevels,
            source: "discovered",
            available: entry.available !== false,
            defaultEnabled: false,
          });
        }
      }
      for (const builtin of def.routes) {
        if (seen.has(builtin.slug)) continue;
        seen.add(builtin.slug);
        baseEntries.push({
          ...builtin,
          source: "builtin",
          available: false,
          defaultEnabled: true,
        });
      }
    }

    const models = baseEntries.map((item) => {
      const override = isPlainObject(file.overrides[item.slug]) ? file.overrides[item.slug] : {};
      const enabled = typeof override.enabled === "boolean" ? override.enabled : item.defaultEnabled;
      const effectiveEnabled = item.available && enabled;
      const displayName = typeof override.displayName === "string" && override.displayName.trim()
        ? override.displayName.trim()
        : item.displayName;
      const contextWindow = sanitizeContextWindow(override.contextWindow) ?? item.contextWindow;
      const effectivePercent = item.effectiveContextWindowPercent || 90;
      const autoCompactTokenLimit = typeof override.autoCompactTokenLimit === "number"
        ? Math.min(contextWindow, Math.round(override.autoCompactTokenLimit))
        : override.contextWindow !== undefined
          ? Math.max(1024, Math.round(contextWindow * (effectivePercent / 100)))
          : item.autoCompactTokenLimit;
      const inputModalities = Array.isArray(override.inputModalities)
        ? (override.inputModalities.includes("image") ? ["text", "image"] : ["text"])
        : item.inputModalities;
      const defaultReasoningLevel = sanitizeReasoning(
        override.defaultReasoningLevel,
        item.supportedReasoningLevels,
      ) ?? item.defaultReasoningLevel;
      const customized =
        displayName !== item.displayName ||
        contextWindow !== item.contextWindow ||
        autoCompactTokenLimit !== item.autoCompactTokenLimit ||
        defaultReasoningLevel !== item.defaultReasoningLevel ||
        inputModalities.length !== item.inputModalities.length;

      return {
        slug: item.slug,
        providerId: def.providerId,
        source: item.source,
        available: item.available,
        enabled,
        effectiveEnabled,
        customized,
        displayName,
        description: typeof override.description === "string" ? override.description : item.description,
        contextWindow,
        autoCompactTokenLimit,
        effectiveContextWindowPercent: effectivePercent,
        inputModalities,
        defaultReasoningLevel,
        supportedReasoningLevels: item.supportedReasoningLevels,
        defaults: {
          enabled: item.defaultEnabled,
          displayName: item.displayName,
          description: item.description,
          contextWindow: item.contextWindow,
          autoCompactTokenLimit: item.autoCompactTokenLimit,
          effectiveContextWindowPercent: effectivePercent,
          inputModalities: item.inputModalities,
          defaultReasoningLevel: item.defaultReasoningLevel,
        },
      };
    });

    const enabledCount = models.filter(m => m.effectiveEnabled).length;
    totalEnabledCount += enabledCount;
    providers.push({
      providerId: def.providerId,
      lastRefreshedAt: typeof cache?.lastRefreshedAt === "string" ? cache.lastRefreshedAt : null,
      lastError: typeof cache?.lastError === "string" ? cache.lastError : null,
      enabledCount,
      availableCount: models.filter(m => m.available).length,
      totalCount: models.length,
      models,
    });
  }

  return {
    version: 1,
    updatedAt: file.updatedAt,
    configPath: filePath,
    totalEnabledCount,
    providers,
  };
}

class ModelsStore {
  constructor({
    modelsFilePath,
    getRuntimeConnection,
  }) {
    this.modelsFilePath = modelsFilePath;
    this.getRuntimeConnection = getRuntimeConnection;
  }

  async requestRuntime(method, endpoint, body, timeoutMs = 8_000) {
    const conn = this.getRuntimeConnection?.();
    if (!conn || !conn.host || !conn.port || !conn.controlToken) {
      return { connected: false };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://${conn.host}:${conn.port}${endpoint}`, {
        method,
        headers: {
          authorization: `Bearer ${conn.controlToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload?.error || `Runtime returned HTTP ${response.status}`;
        const err = new Error(message);
        err.statusCode = response.status;
        err.code = payload?.code;
        err.fromRuntimeHttp = true;
        throw err;
      }
      return { connected: true, payload };
    } catch (error) {
      if (error?.fromRuntimeHttp) throw error;
      return { connected: false, cause: error };
    } finally {
      clearTimeout(timer);
    }
  }

  async getSnapshot() {
    const remote = await this.requestRuntime("GET", "/admin/models");
    if (remote.connected && remote.payload?.snapshot) {
      return remote.payload.snapshot;
    }
    return resolveOfflineSnapshot(this.modelsFilePath);
  }

  async updateOverride(slug, patch) {
    const remote = await this.requestRuntime("PUT", "/admin/models/override", { slug, patch });
    if (remote.connected && remote.payload?.snapshot) {
      return remote.payload.snapshot;
    }

    const snapshot = resolveOfflineSnapshot(this.modelsFilePath);
    const model = snapshot.providers.flatMap(p => p.models).find(m => m.slug === slug);
    if (!model) {
      throw new Error(`Unknown model '${slug}'.`);
    }

    const file = readOfflineStoreFile(this.modelsFilePath);
    const nextOverride = { ...(file.overrides[slug] || {}) };
    if (typeof patch.enabled === "boolean") nextOverride.enabled = patch.enabled;
    if (typeof patch.displayName === "string" && patch.displayName.trim()) {
      nextOverride.displayName = patch.displayName.trim().slice(0, 120);
    }
    if (patch.contextWindow !== undefined) {
      const ctx = sanitizeContextWindow(patch.contextWindow);
      if (!ctx) throw new Error("Context window must be an integer between 4096 and 10000000.");
      nextOverride.contextWindow = ctx;
      delete nextOverride.autoCompactTokenLimit;
    }
    if (Array.isArray(patch.inputModalities)) {
      nextOverride.inputModalities = patch.inputModalities.includes("image") ? ["text", "image"] : ["text"];
    }
    if (patch.defaultReasoningLevel !== undefined) {
      const reasoning = sanitizeReasoning(patch.defaultReasoningLevel, model.supportedReasoningLevels);
      if (!reasoning) throw new Error("Invalid default reasoning level for this model.");
      nextOverride.defaultReasoningLevel = reasoning;
    }

    file.overrides[slug] = nextOverride;
    file.updatedAt = new Date().toISOString();
    writePrivateFileAtomic(this.modelsFilePath, `${JSON.stringify(file, null, 2)}\n`);
    const updated = resolveOfflineSnapshot(this.modelsFilePath);
    if (updated.totalEnabledCount < 1) {
      const rollback = readOfflineStoreFile(this.modelsFilePath);
      if (model.enabled) rollback.overrides[slug] = { ...(rollback.overrides[slug] || {}), enabled: true };
      writePrivateFileAtomic(this.modelsFilePath, `${JSON.stringify(rollback, null, 2)}\n`);
      throw new Error("At least one available model must remain enabled.");
    }
    return updated;
  }

  async toggleProvider(providerId, enabled) {
    const remote = await this.requestRuntime("PUT", "/admin/models/provider-toggle", {
      providerId,
      enabled,
    });
    if (remote.connected && remote.payload?.snapshot) {
      return remote.payload.snapshot;
    }

    const before = resolveOfflineSnapshot(this.modelsFilePath);
    const group = before.providers.find(p => p.providerId === providerId);
    if (!group) throw new Error(`Unknown provider '${providerId}'.`);

    const file = readOfflineStoreFile(this.modelsFilePath);
    const prevFile = JSON.stringify(file);
    for (const model of group.models) {
      if (!model.available) continue;
      file.overrides[model.slug] = { ...(file.overrides[model.slug] || {}), enabled: enabled === true };
    }
    file.updatedAt = new Date().toISOString();
    writePrivateFileAtomic(this.modelsFilePath, `${JSON.stringify(file, null, 2)}\n`);
    const after = resolveOfflineSnapshot(this.modelsFilePath);
    if (after.totalEnabledCount < 1) {
      writePrivateFileAtomic(this.modelsFilePath, prevFile);
      throw new Error("At least one available model must remain enabled.");
    }
    return after;
  }

  async resetModels(slug) {
    const remote = await this.requestRuntime(
      "POST",
      "/admin/models/reset",
      slug ? { slug } : {},
    );
    if (remote.connected && remote.payload?.snapshot) {
      return remote.payload.snapshot;
    }

    const file = readOfflineStoreFile(this.modelsFilePath);
    const prev = JSON.stringify(file);
    if (slug) {
      delete file.overrides[slug];
    } else {
      file.providers = {};
      file.overrides = {};
    }
    file.updatedAt = new Date().toISOString();
    writePrivateFileAtomic(this.modelsFilePath, `${JSON.stringify(file, null, 2)}\n`);
    const after = resolveOfflineSnapshot(this.modelsFilePath);
    if (after.totalEnabledCount < 1) {
      writePrivateFileAtomic(this.modelsFilePath, prev);
      throw new Error("At least one available model must remain enabled.");
    }
    return after;
  }

  async refreshModels(providerId) {
    const remote = await this.requestRuntime(
      "POST",
      "/admin/models/refresh",
      providerId ? { providerId } : {},
      90_000,
    );
    if (!remote.connected || !remote.payload?.snapshot) {
      throw new Error(
        "Local runtime is offline. Complete Setup or start the runtime before refreshing models from the browser.",
      );
    }
    return {
      snapshot: remote.payload.snapshot,
      results: remote.payload.results || [],
    };
  }

  ensureConfigFileExists() {
    if (!fs.existsSync(this.modelsFilePath)) {
      fs.mkdirSync(path.dirname(this.modelsFilePath), { recursive: true });
      writePrivateFileAtomic(
        this.modelsFilePath,
        `${JSON.stringify(createEmptyStoreFile(), null, 2)}\n`,
      );
    }
    return this.modelsFilePath;
  }
}

function createModelsStore(modelsFilePath, getRuntimeConnection) {
  return new ModelsStore({ modelsFilePath, getRuntimeConnection });
}

module.exports = {
  BUILTIN_PROVIDERS,
  ModelsStore,
  createModelsStore,
  resolveOfflineSnapshot,
};
