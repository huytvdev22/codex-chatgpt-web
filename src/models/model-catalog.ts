import type { AppConfig } from "../config";
import { atomicWriteFile, getConfigDir } from "../config";
import type { CodexModelContextOverride } from "../codex-integration";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  findModelProvider,
  isProviderModel,
  listModelRoutes,
  type ModelRouteDefinition,
} from "./model-registry";

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isM365ModelSlug = (slug: string): boolean =>
  isProviderModel(slug, "m365-copilot");

export const DEFAULT_BASE_INSTRUCTIONS =
  "You are Codex, a coding assistant. Answer the user's questions and help them solve tasks.";

export const CANONICAL_MODEL_DEFAULTS: JsonObject = {
  base_instructions: DEFAULT_BASE_INSTRUCTIONS,
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
  comp_hash: "3000",
  experimental_supported_tools: [],
  multi_agent_version: "v1",
  default_reasoning_level: "low",
  supported_reasoning_levels: [
    { effort: "low", description: "Low" },
  ],
  context_window: 200_000,
  max_context_window: 200_000,
  effective_context_window_percent: 90,
  auto_compact_token_limit: 180_000,
  input_modalities: ["text", "image"],
};

const NATIVE_FALLBACK_SHARED_FIELDS: JsonObject = {
  shell_type: "unified_exec",
  visibility: "list",
  supported_in_api: true,
  additional_speed_tiers: [],
  service_tiers: [],
  availability_nux: null,
  upgrade: null,
  effective_context_window_percent: 90,
  input_modalities: ["text", "image"],
  support_verbosity: true,
};

export const DEFAULT_NATIVE_FALLBACK_MODELS: JsonObject[] = [
  {
    ...NATIVE_FALLBACK_SHARED_FIELDS,
    slug: "gpt-5.6-sol",
    display_name: "GPT-5.6 Sol",
    description: "OpenAI GPT-5.6 Sol",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "Low" },
      { effort: "medium", description: "Medium" },
      { effort: "high", description: "High" },
      { effort: "xhigh", description: "Extra high" },
    ],
    priority: 2,
    tool_mode: "code_mode_only",
    multi_agent_version: "v2",
    context_window: 300_000,
    max_context_window: 320_000,
    auto_compact_token_limit: 270_000,
  },
  {
    ...NATIVE_FALLBACK_SHARED_FIELDS,
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "OpenAI GPT-5.5",
    default_reasoning_level: "low",
    supported_reasoning_levels: [
      { effort: "low", description: "Low" },
    ],
    priority: 3,
    tool_mode: null,
    multi_agent_version: "disabled",
    context_window: 200_000,
    max_context_window: 200_000,
    auto_compact_token_limit: 180_000,
  },
];

export function getFallbackNativeCatalog(): { models: JsonObject[] } {
  const modelsMap = new Map<string, JsonObject>();
  // Ưu tiên các native models mặc định chuẩn của Codex
  for (const model of DEFAULT_NATIVE_FALLBACK_MODELS) {
    modelsMap.set(String(model.slug), structuredClone(model));
  }
  try {
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    const cachePath = join(codexHome, "models_cache.json");
    if (existsSync(cachePath)) {
      const raw: unknown = JSON.parse(readFileSync(cachePath, "utf8"));
      if (isJsonObject(raw) && Array.isArray(raw.models)) {
        for (const model of raw.models) {
          const modelSlug = slug(model);
          if (isJsonObject(model) && modelSlug && !isM365ModelSlug(modelSlug)) {
            modelsMap.set(modelSlug, model);
          }
        }
      }
    }
  } catch {
    // ignore cache read failure
  }
  return { models: [...modelsMap.values()] };
}

export function getManagedModelCatalogPath(home = getConfigDir()): string {
  return join(home, "catalog.json");
}

function normalizeCatalogModel(rawModel: unknown): JsonObject {
  const model = isJsonObject(rawModel) ? rawModel : {};
  const merged: JsonObject = {
    ...structuredClone(CANONICAL_MODEL_DEFAULTS),
    ...model,
  };
  const levels = Array.isArray(merged.supported_reasoning_levels)
    ? merged.supported_reasoning_levels.filter(isJsonObject)
    : [];
  merged.supported_reasoning_levels = levels.length > 0
    ? levels
    : [{ effort: "low", description: "Low" }];
  if (!merged.default_reasoning_level) {
    const firstEffort = (merged.supported_reasoning_levels as JsonObject[])[0]?.effort;
    merged.default_reasoning_level = typeof firstEffort === "string" ? firstEffort : "low";
  }
  if (typeof merged.context_window !== "number" || merged.context_window <= 0) {
    merged.context_window = 200_000;
  }
  if (typeof merged.max_context_window !== "number" || merged.max_context_window <= 0) {
    merged.max_context_window = merged.context_window;
  }
  return merged;
}

export function syncManagedModelCatalogFile(
  catalog: unknown,
  catalogPath = getManagedModelCatalogPath(),
): void {
  try {
    const payload = isJsonObject(catalog) && Array.isArray(catalog.models)
      ? {
          ...catalog,
          models: catalog.models.map(normalizeCatalogModel),
        }
      : catalog;
    atomicWriteFile(catalogPath, `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    // non-fatal if cannot write
  }
}

function hasSyncedM365Surface(catalogPath: string): boolean {
  try {
    const raw: unknown = JSON.parse(readFileSync(catalogPath, "utf8"));
    if (!isJsonObject(raw) || !Array.isArray(raw.models)) return false;

    const m365Models = raw.models.filter(
      (model): model is JsonObject => isJsonObject(model) && typeof model.slug === "string" && isM365ModelSlug(model.slug),
    );
    if (m365Models.length === 0) return false;

    const allSupportImages = m365Models.every(
      model => Array.isArray(model.input_modalities) && model.input_modalities.includes("image"),
    );
    if (!allSupportImages) return false;

    const visibleM365Slugs = m365Models
      .filter(model => model.visibility !== "hide")
      .map(model => model.slug as string)
      .sort();
    const expectedM365Slugs = listModelRoutes("m365-copilot")
      .map(route => route.slug)
      .sort();

    return visibleM365Slugs.length === expectedM365Slugs.length
      && visibleM365Slugs.every((value, index) => value === expectedM365Slugs[index]);
  } catch {
    return false;
  }
}

export function buildAndSyncFallbackModelCatalog(
  config: AppConfig,
  options: {
    catalogPath?: string;
    contextOverride?: CodexModelContextOverride;
  } = {},
): JsonObject {
  const catalog = augmentNativeModelCatalog(
    getFallbackNativeCatalog(),
    config,
    options.contextOverride,
  );
  syncManagedModelCatalogFile(catalog, options.catalogPath);
  return catalog;
}

export function ensureManagedModelCatalogFile(
  config: AppConfig,
  catalogPath = getManagedModelCatalogPath(),
  force = false,
): string {
  try {
    if (force || !existsSync(catalogPath) || !hasSyncedM365Surface(catalogPath)) {
      buildAndSyncFallbackModelCatalog(config, { catalogPath });
    }
  } catch {
    // non-fatal
  }
  return catalogPath;
}

function object(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function slug(value: unknown): string | undefined {
  if (!isJsonObject(value)) return undefined;
  return typeof value.slug === "string" ? value.slug : undefined;
}

function reasoningLevel(template: JsonObject, effort: string, description: string): JsonObject {
  const levels = Array.isArray(template.supported_reasoning_levels)
    ? template.supported_reasoning_levels.filter(isJsonObject)
    : [];
  const source = levels.find(level => level.effort === effort);
  return { ...(source ? structuredClone(source) : {}), effort, description };
}

function modelPriority(template: JsonObject): number | undefined {
  const value = template.priority;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("Native Codex model template priority must be an integer");
  }
  return value;
}

function nativeTemplateCandidate(value: unknown): value is JsonObject {
  if (!isJsonObject(value)) return false;
  const modelSlug = slug(value);
  if (!modelSlug || isM365ModelSlug(modelSlug)) return false;
  // Chỉ chọn model hiển thị công khai và có reasoning metadata hợp lệ làm template nền.
  // Route provider luôn ghi đè supported_in_api = true vì local Responses endpoint xử lý trực tiếp.
  return value.visibility === "list" && Array.isArray(value.supported_reasoning_levels);
}

function selectNativeTemplate(models: unknown[]): JsonObject {
  const template = models.find(nativeTemplateCandidate);
  if (template) return template;
  throw new Error("Native Codex models response has no list-visible model with reasoning metadata");
}

function useCompatibilityV1SubagentSurface(model: JsonObject): void {
  // Compatibility V1 is an explicit whole-task protocol mode. Preserve an explicit disabled
  // capability instead of advertising support that the native model denied.
  if (model.multi_agent_version !== "disabled") model.multi_agent_version = "v1";
}

function routedSubagentVersion(template: JsonObject, config: AppConfig): string | undefined {
  if (config.subagentProtocol === "compatibility-v1") return "v1";
  return typeof template.multi_agent_version === "string" ? template.multi_agent_version : undefined;
}

export function buildProviderModel(
  templateValue: unknown,
  route: ModelRouteDefinition,
  config: AppConfig,
): JsonObject {
  const template = object(templateValue, "native Codex model template");
  const templateSlug = slug(template);
  if (!templateSlug || findModelProvider(templateSlug)) {
    throw new Error("Provider model template must be a native Codex model");
  }
  const multiAgentVersion = routedSubagentVersion(template, config);
  const priority = modelPriority(template);
  const model: JsonObject = {
    ...structuredClone(template),
    slug: route.slug,
    display_name: route.displayName,
    description: route.description,
    input_modalities: [...route.inputModalities],
    visibility: "list",
    supported_in_api: true,
    ...(priority === undefined ? {} : { priority }),
    ...(multiAgentVersion === undefined
      ? {}
      : { multi_agent_version: multiAgentVersion }),
    tool_mode: null,
    upgrade: null,
    default_reasoning_level: route.defaultReasoningLevel,
    supported_reasoning_levels: route.reasoningLevels.map(level =>
      reasoningLevel(template, level.effort, level.description)
    ),
    context_window: route.contextWindow,
    max_context_window: route.contextWindow,
    effective_context_window_percent: route.effectiveContextWindowPercent,
    auto_compact_token_limit: route.autoCompactTokenLimit,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    support_verbosity: true,
  };
  delete model.comp_hash;
  delete model.availability_nux;
  return model;
}

export function augmentNativeModelCatalog(
  value: unknown,
  config: AppConfig,
  contextOverride?: CodexModelContextOverride,
): JsonObject {
  const catalog = object(value, "native Codex models response");
  if (!Array.isArray(catalog.models)) {
    throw new Error("Native Codex models response is missing a models array");
  }
  if (catalog.models.length === 0) {
    throw new Error("Cannot augment models without at least one native template model");
  }
  const nativeModels = structuredClone(
    catalog.models.filter(model => {
      const s = slug(model);
      return !s || !isM365ModelSlug(s);
    }),
  );
  if (config.subagentProtocol === "compatibility-v1") {
    for (const candidate of nativeModels) {
      if (isJsonObject(candidate)) {
        useCompatibilityV1SubagentSurface(candidate);
      }
    }
  }
  const effectiveNative = nativeModels.length > 0
    ? nativeModels
    : structuredClone(getFallbackNativeCatalog().models);
  const template = selectNativeTemplate(effectiveNative);
  if (contextOverride) {
    // model_context_window is a single top-level Codex setting, not a per-model one. Apply its
    // advertised maximum to every native row so switching native models cannot silently clamp the
    // effective override. Codex itself applies context_window and auto-compaction configuration.
    for (const candidate of effectiveNative) {
      const modelSlug = slug(candidate);
      if (!modelSlug) continue;
      const model = object(candidate, `native ${modelSlug} model`);
      const current = model.max_context_window;
      if (current !== undefined && current !== null
        && (typeof current !== "number" || !Number.isSafeInteger(current) || current <= 0)) {
        throw new Error(`Native ${modelSlug} max_context_window must be a positive integer`);
      }
      if (current === undefined || current === null || current < contextOverride.contextWindow) {
        model.max_context_window = contextOverride.contextWindow;
      }
    }
  }
  const providerModels = listModelRoutes()
    .map(route => buildProviderModel(template, route, config));

  const seen = new Set<string>();
  const deduplicatedModels: JsonObject[] = [];
  for (const model of effectiveNative) {
    const s = slug(model);
    if (s && !seen.has(s)) {
      seen.add(s);
      deduplicatedModels.push(model);
    }
  }
  for (const model of providerModels) {
    const s = slug(model);
    if (s && !seen.has(s)) {
      seen.add(s);
      deduplicatedModels.push(model);
    }
  }

  const result = {
    ...structuredClone(catalog),
    models: deduplicatedModels,
  };
  return result;
}
