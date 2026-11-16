import { BaseModelProvider } from "../../models/base-model-provider";
import type { ModelRouteDefinition } from "../../models/types";

export type AiStudioThinkingLevel = "Low" | "Medium" | "High";

export type AiStudioModelRouteDefinition = ModelRouteDefinition<AiStudioThinkingLevel>;

/**
 * Danh mục model và ánh xạ Thinking Level cho Google AI Studio Web (`aistudio.google.com`).
 */
export class AiStudioModelProvider extends BaseModelProvider<AiStudioModelRouteDefinition> {
  private static readonly instance = new AiStudioModelProvider();

  public readonly id = "ai-studio";
  public readonly exactSlugs = ["ai-studio/gemini-4-hydrogen"] as const;
  public readonly slugPrefixes = [] as const;
  public readonly routes: readonly AiStudioModelRouteDefinition[] = [
    {
      slug: "ai-studio/gemini-4-hydrogen",
      displayName: "Gemini 4 Hydrogen",
      description: "Gemini 4 Hydrogen qua Google AI Studio",
      contextWindow: 100_000,
      autoCompactTokenLimit: 90_000,
      effectiveContextWindowPercent: 90,
      inputModalities: ["text", "image"],
      defaultReasoningLevel: "high",
      reasoningLevels: [
        { effort: "low", description: "Low thinking", mode: "Low" },
        { effort: "medium", description: "Medium thinking", mode: "Medium" },
        { effort: "high", description: "High thinking", mode: "High" },
      ],
    },
  ];

  public static getInstance(): AiStudioModelProvider {
    return AiStudioModelProvider.instance;
  }

  public resolveThinkingLevel(
    modelId = "ai-studio/gemini-4-hydrogen",
    requestedEffort?: string,
  ): AiStudioThinkingLevel {
    return this.resolveReasoningMode(modelId, requestedEffort) ?? "High";
  }
}

