import { BaseModelProvider } from "../../models/base-model-provider";
import { ModelConfigStore } from "../../models/model-config-store";
import type {
  DiscoveredModelEntry,
  ModelRouteDefinition,
} from "../../models/types";

export type ChatGptThinkingEffort = "none" | "medium" | "high";

export interface ChatGptModelRouteDefinition
  extends ModelRouteDefinition<ChatGptThinkingEffort> {
  readonly uiLabel: string;
  readonly shortUiVersion?: string;
  readonly isAccountDefault?: boolean;
}

export interface ChatGptCapabilityTarget {
  readonly modelSlug: string;
  readonly modelLabel: string;
  readonly shortUiVersion?: string;
  readonly isAccountDefault?: boolean;
  readonly thinkingEffort: ChatGptThinkingEffort;
}

export const CHATGPT_DEFAULT_MODEL_SLUG = "chatgpt/gpt-6.2";

const CHATGPT_REASONING_LEVELS: ChatGptModelRouteDefinition["reasoningLevels"] = [
  { effort: "low", description: "Instant", mode: "none" },
  { effort: "medium", description: "Medium", mode: "medium" },
  { effort: "high", description: "High", mode: "high" },
];

/**
 * Danh mục model và ánh xạ Thinking Effort cho ChatGPT Web (`chatgpt.com`).
 */
export class ChatGptModelProvider extends BaseModelProvider<ChatGptModelRouteDefinition> {
  private static readonly instance = new ChatGptModelProvider();

  public readonly id = "chatgpt";
  public readonly exactSlugs = [
    "chatgpt",
    "chatgpt/gpt-6.2",
    "chatgpt/gpt-6",
    "chatgpt/gpt-5.6-sol",
  ] as const;
  public readonly slugPrefixes = ["chatgpt/"] as const;
  public readonly routes: readonly ChatGptModelRouteDefinition[] = [
    {
      slug: "chatgpt/gpt-6.2",
      uiLabel: "GPT-6.2",
      shortUiVersion: "6.2",
      isAccountDefault: true,
      displayName: "ChatGPT - GPT-6.2",
      description: "GPT-6.2 qua ChatGPT Web",
      contextWindow: 1_000_000,
      autoCompactTokenLimit: 900_000,
      effectiveContextWindowPercent: 90,
      inputModalities: ["text", "image"],
      defaultReasoningLevel: "medium",
      reasoningLevels: CHATGPT_REASONING_LEVELS,
    },
    {
      slug: "chatgpt/gpt-6",
      uiLabel: "GPT-6",
      shortUiVersion: "6",
      displayName: "ChatGPT - GPT-6",
      description: "GPT-6 qua ChatGPT Web",
      contextWindow: 1_000_000,
      autoCompactTokenLimit: 900_000,
      effectiveContextWindowPercent: 90,
      inputModalities: ["text", "image"],
      defaultReasoningLevel: "medium",
      reasoningLevels: CHATGPT_REASONING_LEVELS,
    },
    {
      slug: "chatgpt/gpt-5.6-sol",
      uiLabel: "GPT-5.6 Sol",
      shortUiVersion: "5.6",
      displayName: "ChatGPT - GPT-5.6 Sol",
      description: "GPT-5.6 Sol qua ChatGPT Web",
      contextWindow: 1_000_000,
      autoCompactTokenLimit: 900_000,
      effectiveContextWindowPercent: 90,
      inputModalities: ["text", "image"],
      defaultReasoningLevel: "medium",
      reasoningLevels: CHATGPT_REASONING_LEVELS,
    },
  ];

  public static getInstance(): ChatGptModelProvider {
    return ChatGptModelProvider.instance;
  }

  public override buildRouteFromDiscovered(
    entry: DiscoveredModelEntry,
  ): ChatGptModelRouteDefinition | undefined {
    const uiLabel = (entry.uiLabel || entry.displayName.replace(/^ChatGPT\s*-\s*/i, "")).trim();
    if (!uiLabel) return undefined;

    const contextWindow = entry.contextWindow ?? 1_000_000;
    const effectiveContextWindowPercent = 90;
    return {
      slug: entry.slug.startsWith("chatgpt/") ? entry.slug : `chatgpt/${entry.slug}`,
      uiLabel,
      ...(entry.shortUiVersion ? { shortUiVersion: entry.shortUiVersion } : {}),
      ...(entry.isAccountDefault !== undefined ? { isAccountDefault: entry.isAccountDefault } : {}),
      ...(entry.remoteModelId ? { remoteModelId: entry.remoteModelId } : {}),
      displayName: entry.displayName,
      description: entry.description || `${uiLabel} qua ChatGPT Web`,
      contextWindow,
      autoCompactTokenLimit: Math.round(contextWindow * (effectiveContextWindowPercent / 100)),
      effectiveContextWindowPercent,
      inputModalities: entry.inputModalities ?? ["text", "image"],
      defaultReasoningLevel: entry.defaultReasoningLevel ?? "medium",
      reasoningLevels: CHATGPT_REASONING_LEVELS,
    };
  }

  public override findRoute(
    modelId: string,
  ): ChatGptModelRouteDefinition | undefined {
    const exact = super.findRoute(modelId);
    if (exact) return exact;
    if (modelId === "chatgpt" || modelId.startsWith("chatgpt/")) {
      return this.routes[0];
    }
    return undefined;
  }

  private resolveManagedRoute(modelId: string): ChatGptModelRouteDefinition {
    const resolved = ModelConfigStore.getInstance().findResolvedRoute(this, modelId) as
      | ChatGptModelRouteDefinition
      | undefined;
    return resolved ?? this.findRoute(modelId) ?? this.routes[0]!;
  }

  public resolveThinkingEffort(
    modelId = CHATGPT_DEFAULT_MODEL_SLUG,
    requestedEffort?: string,
  ): ChatGptThinkingEffort {
    const route = this.resolveManagedRoute(modelId);
    return this.resolveReasoning(route, requestedEffort).mode ?? "medium";
  }

  public resolveCapabilityTarget(
    modelId = CHATGPT_DEFAULT_MODEL_SLUG,
    requestedEffort?: string,
  ): ChatGptCapabilityTarget {
    const route = this.resolveManagedRoute(modelId);
    const thinkingEffort =
      this.resolveReasoning(route, requestedEffort).mode ?? "medium";
    const uiLabel = route.uiLabel || route.displayName.replace(/^ChatGPT\s*-\s*/i, "");
    return {
      modelSlug: route.slug,
      modelLabel: uiLabel,
      shortUiVersion: route.shortUiVersion,
      isAccountDefault: route.isAccountDefault,
      thinkingEffort,
    };
  }
}
