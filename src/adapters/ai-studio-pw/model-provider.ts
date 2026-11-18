import { BaseModelProvider } from "../../models/base-model-provider";
import type { ModelRouteDefinition } from "../../models/types";
import type { AiStudioThinkingLevel } from "../ai-studio/model-provider";

export type AiStudioPlaywrightModelRouteDefinition =
  ModelRouteDefinition<AiStudioThinkingLevel>;

/**
 * Danh mục model và ánh xạ Thinking Level cho Google AI Studio chạy qua Playwright CDP
 * (`ai-studio-pw/...`) để test A/B song song với `electron-control`.
 */
export class AiStudioPlaywrightModelProvider extends BaseModelProvider<AiStudioPlaywrightModelRouteDefinition> {
  private static readonly instance = new AiStudioPlaywrightModelProvider();

  public readonly id = "ai-studio-pw";
  public readonly exactSlugs = ["ai-studio-pw/gemini-4-hydrogen"] as const;
  public readonly slugPrefixes = [] as const;
  public readonly routes: readonly AiStudioPlaywrightModelRouteDefinition[] = [
    {
      slug: "ai-studio-pw/gemini-4-hydrogen",
      displayName: "Gemini 4 Hydrogen (Playwright A/B)",
      description: "Gemini 4 Hydrogen qua Google AI Studio (Playwright CDP)",
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

  public static getInstance(): AiStudioPlaywrightModelProvider {
    return AiStudioPlaywrightModelProvider.instance;
  }

  public resolveThinkingLevel(
    modelId = "ai-studio-pw/gemini-4-hydrogen",
    requestedEffort?: string,
  ): AiStudioThinkingLevel {
    return this.resolveReasoningMode(modelId, requestedEffort) ?? "High";
  }
}
