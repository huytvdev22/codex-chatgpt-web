import type { AppConfig } from "./config";
import { atomicWriteFile, getConfigDir } from "./config";
import type { CodexModelContextOverride } from "./codex-integration";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  availableChatGptWebModelRoutes,
  chatGptWebRouteEfforts,
  CHATGPT_WEB_MODEL_PREFIX,
  resolveChatGptWebContextLimits,
  type ChatGptWebModelRoute,
} from "./chatgpt-web-models";
import {
  availableM365ModelRoutes,
  M365_COPILOT_MODEL_PREFIX,
  type M365ModelRoute,
} from "./m365-models";

type JsonObject = Record<string, unknown>;

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

export const DEFAULT_NATIVE_FALLBACK_MODELS: JsonObject[] = [
  {
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
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 2,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    tool_mode: "code_mode_only",
    multi_agent_version: "v2",
    context_window: 300_000,
    max_context_window: 320_000,
    effective_context_window_percent: 90,
    auto_compact_token_limit: 270_000,
    input_modalities: ["text", "image"],
    support_verbosity: true,
  },
  {
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "OpenAI GPT-5.5",
    default_reasoning_level: "low",
    supported_reasoning_levels: [
      { effort: "low", description: "Low" },
    ],
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 3,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    tool_mode: null,
    multi_agent_version: "disabled",
    context_window: 200_000,
    max_context_window: 200_000,
    effective_context_window_percent: 90,
    auto_compact_token_limit: 180_000,
    input_modalities: ["text", "image"],
    support_verbosity: true,
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
      const raw = JSON.parse(readFileSync(cachePath, "utf8"));
      if (Array.isArray(raw.models)) {
        for (const m of raw.models) {
          const s = typeof m?.slug === "string" ? m.slug : "";
          if (s && !s.startsWith(CHATGPT_WEB_MODEL_PREFIX) && !s.startsWith(M365_COPILOT_MODEL_PREFIX)) {
            modelsMap.set(s, m);
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

export function syncManagedModelCatalogFile(
  catalog: unknown,
  catalogPath = getManagedModelCatalogPath(),
): void {
  try {
    let payload = catalog;
    if (catalog && typeof catalog === "object" && Array.isArray((catalog as any).models)) {
      payload = {
        ...(catalog as any),
        models: (catalog as any).models.map((m: any) => {
          const merged = {
            ...structuredClone(CANONICAL_MODEL_DEFAULTS),
            ...m,
          };
          if (!Array.isArray(merged.supported_reasoning_levels) || merged.supported_reasoning_levels.length === 0) {
            merged.supported_reasoning_levels = [{ effort: "low", description: "Low" }];
          }
          if (!merged.default_reasoning_level) {
            merged.default_reasoning_level = (merged.supported_reasoning_levels[0] as any)?.effort ?? "low";
          }
          if (typeof merged.context_window !== "number" || merged.context_window <= 0) {
            merged.context_window = 200_000;
          }
          if (typeof merged.max_context_window !== "number" || merged.max_context_window <= 0) {
            merged.max_context_window = merged.context_window;
          }
          return merged;
        }),
      };
    }
    const data = JSON.stringify(payload, null, 2) + "\n";
    atomicWriteFile(catalogPath, data);
  } catch {
    // non-fatal if cannot write
  }
}

export function ensureManagedModelCatalogFile(
  config: AppConfig,
  catalogPath = getManagedModelCatalogPath(),
  force = false,
): string {
  try {
    let shouldWrite = force || !existsSync(catalogPath);
    if (!shouldWrite && existsSync(catalogPath)) {
      try {
        const raw = JSON.parse(readFileSync(catalogPath, "utf8"));
        if (!Array.isArray(raw.models) || !raw.models.some((m: any) => typeof m?.slug === "string" && m.slug.startsWith(M365_COPILOT_MODEL_PREFIX))) {
          shouldWrite = true;
        }
      } catch {
        shouldWrite = true;
      }
    }
    if (shouldWrite) {
      const fallback = getFallbackNativeCatalog();
      const catalog = augmentNativeModelCatalog(fallback, config);
      syncManagedModelCatalogFile(catalog, catalogPath);
    }
  } catch {
    // non-fatal
  }
  return catalogPath;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function slug(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as JsonObject).slug;
  return typeof candidate === "string" ? candidate : undefined;
}

function reasoningLevel(template: JsonObject, effort: string, description: string): JsonObject {
  const levels = Array.isArray(template.supported_reasoning_levels)
    ? template.supported_reasoning_levels.filter(level => level && typeof level === "object" && !Array.isArray(level)) as JsonObject[]
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

function routedModelPriority(
  template: JsonObject,
  route: ChatGptWebModelRoute,
  config: AppConfig,
): number | undefined {
  const priority = modelPriority(template);
  if (priority === undefined
    || config.subagentProtocol !== "compatibility-v1"
    || !["chatgpt-web/light", "chatgpt-web/gpt-5.6-sol-instant"].includes(route.slug)) return priority;
  if (priority === Number.MAX_SAFE_INTEGER) {
    throw new Error("Native Codex model template priority cannot reserve the Compatibility V1 roster");
  }
  // Preserve the native model and the reasoning/Pro choices in Codex V1's bounded registry.
  return priority + 1;
}

function nativeTemplateCandidate(value: unknown, requireTools: boolean): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as JsonObject;
  const modelSlug = slug(model);
  if (!modelSlug || modelSlug.startsWith(CHATGPT_WEB_MODEL_PREFIX) || modelSlug.startsWith(M365_COPILOT_MODEL_PREFIX)) return false;
  // This route forwards ChatGPT authentication. Codex's own model manager keeps every list-visible
  // model in ChatGPT mode even when `supported_in_api` is false; that flag gates API-key mode, not
  // whether the backend row is a valid catalog template. The routed Web row overrides the flag to
  // true because this local Responses endpoint implements it.
  if (model.visibility !== "list") return false;
  if (!Array.isArray(model.supported_reasoning_levels)) return false;
  return !requireTools || (typeof model.tool_mode === "string" && model.tool_mode.length > 0);
}

function selectNativeTemplate(models: unknown[], config: AppConfig): JsonObject {
  const requireTools = config.mode === "full";
  const candidates = models.filter(model => nativeTemplateCandidate(model, requireTools)) as JsonObject[];
  const template = candidates[0];
  if (template) return template;
  throw new Error(
    requireTools
      ? "Native Codex models response has no list-visible, tool-capable model with reasoning metadata"
      : "Native Codex models response has no list-visible model with reasoning metadata",
  );
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

export function buildChatGptWebModel(
  templateValue: unknown,
  route: ChatGptWebModelRoute,
  config: AppConfig,
): JsonObject {
  const template = object(templateValue, "native Codex model template");
  const templateSlug = slug(template);
  if (!templateSlug || templateSlug.startsWith(CHATGPT_WEB_MODEL_PREFIX)) {
    throw new Error("ChatGPT Web model template must be a native Codex model");
  }
  const limits = resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, config);
  const efforts = chatGptWebRouteEfforts(route, config);
  for (const effort of efforts) {
    const adapterEffort = route.supportedCodexEfforts ? effort : route.adapterEffort;
    if (adapterEffort === "ultra") throw new Error("Ultra is not a browser effort");
    const candidate = resolveChatGptWebContextLimits(route.backendModel, adapterEffort, config);
    if (JSON.stringify(candidate) !== JSON.stringify(limits)) {
      throw new Error(`Cannot group different context budgets under ${route.slug}`);
    }
  }
  const multiAgentVersion = routedSubagentVersion(template, config);
  const priority = routedModelPriority(template, route, config);
  const model: JsonObject = {
    ...structuredClone(template),
    slug: route.slug,
    display_name: route.displayName,
    description: route.description,
    input_modalities: route.interactionMode === "manual" ? ["text"] : ["text", "image"],
    visibility: route.legacy ? "hide" : "list",
    // These slugs are implemented by this local Responses-compatible bridge. Marking them false
    // makes Codex drop them from spawn_agent whenever openai_base_url points at the bridge.
    supported_in_api: true,
    // Follow the official template's ordering without outranking it. Codex advertises at most five
    // spawn-agent overrides; forcing every routed row to priority 0 displaced gpt-5.6-sol from that
    // registry and made an explicit native child model fail validation.
    ...(priority === undefined ? {} : { priority }),
    // In native mode the routed row follows the official template's protocol surface. Web-origin
    // V2 collaboration calls carry the protocol's explicit plaintext marker; Compatibility V1
    // instead pins the entire catalog and Codex feature override to V1.
    ...(multiAgentVersion === undefined
      ? {}
      : { multi_agent_version: multiAgentVersion }),
    // Code mode collapses the outer registry into an exec gateway; routed models need the regular
    // Responses tool surface so MCP namespaces, deferred tool_search, and custom tools reach us.
    tool_mode: null,
    upgrade: null,
    default_reasoning_level: route.codexEffort,
    supported_reasoning_levels: efforts.map(effort => reasoningLevel(template, effort,
      efforts.length === 1 ? route.displayName
        : route.backendModel === "gpt-5.6-luna" ? effort === "low" ? "Ordinary Luna" : "Think"
          : `${route.displayName} — ${effort === "xhigh" ? "Extra High" : effort}`)),
    context_window: limits.contextWindow,
    max_context_window: limits.contextWindow,
    effective_context_window_percent: limits.effectiveContextWindowPercent,
    auto_compact_token_limit: limits.autoCompactTokenLimit,
    // ChatGPT Web has no Codex service tier. Never inherit the native template's Fast tiers.
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
  };
  // A native template's compaction hash describes OpenAI's native model contract, not this routed
  // browser model. The explicit Web window above is owned by this adapter and never copied back to
  // native models or the user's top-level model_context_window setting.
  delete model.comp_hash;
  delete model.availability_nux;
  return model;
}

export function buildM365Model(
  templateValue: unknown,
  route: M365ModelRoute,
  config: AppConfig,
): JsonObject {
  const template = object(templateValue, "native Codex model template");
  const multiAgentVersion = routedSubagentVersion(template, config);
  const model: JsonObject = {
    ...structuredClone(template),
    slug: route.slug,
    display_name: route.displayName,
    description: route.description,
    input_modalities: ["text"],
    visibility: route.legacy ? "hide" : "list",
    supported_in_api: true,
    priority: 100,
    ...(multiAgentVersion === undefined ? {} : { multi_agent_version: multiAgentVersion }),
    tool_mode: null,
    upgrade: null,
    default_reasoning_level: "low",
    supported_reasoning_levels: [reasoningLevel(template, "low", route.displayName)],
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
  const nativeModels = structuredClone(
    catalog.models.filter(model => {
      const s = slug(model);
      return !s?.startsWith(CHATGPT_WEB_MODEL_PREFIX) && !s?.startsWith(M365_COPILOT_MODEL_PREFIX);
    }),
  );
  if (config.subagentProtocol === "compatibility-v1") {
    for (const candidate of nativeModels) {
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        useCompatibilityV1SubagentSurface(candidate as JsonObject);
      }
    }
  }
  const effectiveNative = nativeModels.length > 0
    ? nativeModels
    : structuredClone(getFallbackNativeCatalog().models);
  const template = selectNativeTemplate(effectiveNative, config);
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
  const webModels = availableChatGptWebModelRoutes(config, true)
    .map(route => buildChatGptWebModel(template, route, config));
  const m365Models = availableM365ModelRoutes()
    .map(route => buildM365Model(template, route, config));

  const seen = new Set<string>();
  const deduplicatedModels: JsonObject[] = [];
  for (const model of effectiveNative) {
    const s = slug(model);
    if (s && !seen.has(s)) {
      seen.add(s);
      deduplicatedModels.push(model);
    }
  }
  for (const model of webModels) {
    const s = slug(model);
    if (s && !seen.has(s)) {
      seen.add(s);
      deduplicatedModels.push(model);
    }
  }
  for (const model of m365Models) {
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

