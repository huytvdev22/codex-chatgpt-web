import { BaseModelProvider } from "../../models/base-model-provider";
import type { ModelRouteDefinition } from "../../models/types";

export type M365CapabilityMode =
  | "auto"
  | "quick"
  | "think"
  | "gpt-5.6-think"
  | "gpt-5.6-quick";

export type M365ModelRouteDefinition = ModelRouteDefinition<M365CapabilityMode>;

/**
 * Triển khai danh mục model và ánh xạ capability mode cho adapter Microsoft 365 Copilot Web.
 */
export class M365ModelProvider extends BaseModelProvider<M365ModelRouteDefinition> {
  private static readonly instance = new M365ModelProvider();

  public readonly id = "m365-copilot";
  public readonly exactSlugs = ["m365-copilot"] as const;
  public readonly slugPrefixes = ["m365-copilot/", "m365-"] as const;
  public readonly routes: readonly M365ModelRouteDefinition[] = [
    {
      slug: "m365-copilot/gpt-5.6",
      displayName: "M365 - GPT 5.6",
      description: "GPT 5.6 qua Microsoft 365 Copilot Web",
      contextWindow: 100_000,
      autoCompactTokenLimit: 90_000,
      effectiveContextWindowPercent: 90,
      inputModalities: ["text", "image"],
      defaultReasoningLevel: "low",
      reasoningLevels: [
        { effort: "low", description: "Quick", mode: "gpt-5.6-quick" },
        { effort: "high", description: "Deeper", mode: "gpt-5.6-think" },
      ],
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
      reasoningLevels: [
        { effort: "low", description: "Quick", mode: "quick" },
        { effort: "high", description: "Deeper", mode: "think" },
      ],
    },
  ];

  public static getInstance(): M365ModelProvider {
    return M365ModelProvider.instance;
  }

  public resolveCapabilityMode(
    modelId?: string,
    requestedEffort?: string,
  ): M365CapabilityMode {
    if (!modelId) return "auto";
    return this.resolveReasoningMode(modelId, requestedEffort) ?? "auto";
  }
}

