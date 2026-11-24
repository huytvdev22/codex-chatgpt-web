import { BaseModelProvider } from "../../models/base-model-provider";
import type { ModelRouteDefinition } from "../../models/types";

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
      isAccountDefault: true,
      displayName: "ChatGPT - GPT-6.2",
      description: "GPT-6.2 qua ChatGPT Web",
      contextWindow: 128_000,
      autoCompactTokenLimit: 115_000,
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
      contextWindow: 128_000,
      autoCompactTokenLimit: 115_000,
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
      contextWindow: 128_000,
      autoCompactTokenLimit: 115_000,
      effectiveContextWindowPercent: 90,
      inputModalities: ["text", "image"],
      defaultReasoningLevel: "medium",
      reasoningLevels: CHATGPT_REASONING_LEVELS,
    },
  ];

  public static getInstance(): ChatGptModelProvider {
    return ChatGptModelProvider.instance;
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

  public resolveThinkingEffort(
    modelId = CHATGPT_DEFAULT_MODEL_SLUG,
    requestedEffort?: string,
  ): ChatGptThinkingEffort {
    return this.resolveReasoningMode(modelId, requestedEffort) ?? "medium";
  }

  public resolveCapabilityTarget(
    modelId = CHATGPT_DEFAULT_MODEL_SLUG,
    requestedEffort?: string,
  ): ChatGptCapabilityTarget {
    const route = this.findRoute(modelId) ?? this.routes[0]!;
    const thinkingEffort =
      this.resolveReasoning(route, requestedEffort).mode ?? "medium";
    return {
      modelSlug: route.slug,
      modelLabel: route.uiLabel,
      shortUiVersion: route.shortUiVersion,
      isAccountDefault: route.isAccountDefault,
      thinkingEffort,
    };
  }
}
