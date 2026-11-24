import { BaseModelProvider } from "../../models/base-model-provider";
import { ModelConfigStore } from "../../models/model-config-store";
import type {
  DiscoveredModelEntry,
  ModelRouteDefinition,
} from "../../models/types";

export type AiStudioThinkingLevel = "Low" | "Medium" | "High";

export type AiStudioModelRouteDefinition = ModelRouteDefinition<AiStudioThinkingLevel>;

const AI_STUDIO_REASONING_LEVELS: AiStudioModelRouteDefinition["reasoningLevels"] = [
  { effort: "low", description: "Low thinking", mode: "Low" },
  { effort: "medium", description: "Medium thinking", mode: "Medium" },
  { effort: "high", description: "High thinking", mode: "High" },
];

/**
 * Danh mục model và ánh xạ Thinking Level cho Google AI Studio Web (`aistudio.google.com`).
 */
export class AiStudioModelProvider extends BaseModelProvider<AiStudioModelRouteDefinition> {
  private static readonly instance = new AiStudioModelProvider();

  public readonly id = "ai-studio";
  public readonly exactSlugs = ["ai-studio/gemini-4-hydrogen"] as const;
  public readonly slugPrefixes = ["ai-studio/"] as const;
  public readonly routes: readonly AiStudioModelRouteDefinition[] = [
    {
      slug: "ai-studio/gemini-4-hydrogen",
      displayName: "Gemini 4 Hydrogen",
      description: "Gemini 4 Hydrogen qua Google AI Studio",
      contextWindow: 1_000_000,
      autoCompactTokenLimit: 900_000,
      effectiveContextWindowPercent: 90,
      inputModalities: ["text", "image"],
      defaultReasoningLevel: "high",
      reasoningLevels: AI_STUDIO_REASONING_LEVELS,
    },
  ];

  public static getInstance(): AiStudioModelProvider {
    return AiStudioModelProvider.instance;
  }

  public override buildRouteFromDiscovered(
    entry: DiscoveredModelEntry,
  ): AiStudioModelRouteDefinition | undefined {
    const cleanRemoteId =
      entry.remoteModelId?.trim() ||
      entry.slug.replace(/^ai-studio\//i, "").trim();
    if (!cleanRemoteId) return undefined;

    const contextWindow = entry.contextWindow ?? 1_000_000;
    const effectiveContextWindowPercent = 90;
    return {
      slug: entry.slug.startsWith("ai-studio/") ? entry.slug : `ai-studio/${cleanRemoteId}`,
      remoteModelId: cleanRemoteId,
      displayName: entry.displayName,
      description: entry.description || `${entry.displayName} qua Google AI Studio`,
      contextWindow,
      autoCompactTokenLimit: Math.round(contextWindow * (effectiveContextWindowPercent / 100)),
      effectiveContextWindowPercent,
      inputModalities: entry.inputModalities ?? ["text", "image"],
      defaultReasoningLevel: entry.defaultReasoningLevel ?? "high",
      reasoningLevels: AI_STUDIO_REASONING_LEVELS,
    };
  }

  public resolveThinkingLevel(
    modelId = "ai-studio/gemini-4-hydrogen",
    requestedEffort?: string,
  ): AiStudioThinkingLevel {
    const resolved =
      (ModelConfigStore.getInstance().findResolvedRoute(this, modelId) as AiStudioModelRouteDefinition | undefined) ??
      this.findRoute(modelId) ??
      this.routes[0]!;
    return this.resolveReasoning(resolved, requestedEffort).mode ?? "High";
  }
}
