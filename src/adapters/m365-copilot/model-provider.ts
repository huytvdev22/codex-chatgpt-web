import { BaseModelProvider } from "../../models/base-model-provider";
import { ModelConfigStore } from "../../models/model-config-store";
import type {
  DiscoveredModelEntry,
  M365DiscoveredCapabilityMeta,
  ModelRouteDefinition,
} from "../../models/types";

export type M365CapabilityMode =
  | "auto"
  | "quick"
  | "think"
  | "gpt-5.6-think"
  | "gpt-5.6-quick";

export type M365ModelRouteDefinition = ModelRouteDefinition<M365CapabilityMode>;

export interface M365ResolvedCapabilityTarget {
  readonly mode: string;
  readonly spec?: M365DiscoveredCapabilityMeta & {
    readonly isQuickThink: "quick" | "think" | "single";
  };
}

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
      contextWindow: 1_000_000,
      autoCompactTokenLimit: 900_000,
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
      contextWindow: 1_000_000,
      autoCompactTokenLimit: 900_000,
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

  public override buildRouteFromDiscovered(
    entry: DiscoveredModelEntry,
  ): M365ModelRouteDefinition | undefined {
    const slug = entry.slug.trim();
    if (!slug) return undefined;
    const contextWindow = entry.contextWindow ?? 1_000_000;
    const effectiveContextWindowPercent = 90;
    return {
      slug,
      displayName: entry.displayName,
      description: entry.description || `${entry.displayName} qua Microsoft 365 Copilot Web`,
      contextWindow,
      autoCompactTokenLimit: Math.round(contextWindow * (effectiveContextWindowPercent / 100)),
      effectiveContextWindowPercent,
      inputModalities: entry.inputModalities ?? ["text", "image"],
      defaultReasoningLevel: entry.defaultReasoningLevel === "high" ? "high" : "low",
      reasoningLevels: [
        { effort: "low", description: "Quick", mode: "quick" },
        { effort: "high", description: "Deeper", mode: "think" },
      ],
      ...(entry.capabilityMeta ? { capabilityMeta: entry.capabilityMeta } : {}),
    };
  }

  public resolveCapabilityMode(
    modelId?: string,
    requestedEffort?: string,
  ): M365CapabilityMode {
    if (!modelId) return "auto";
    const resolved = ModelConfigStore.getInstance().findResolvedRoute(this, modelId) as
      | M365ModelRouteDefinition
      | undefined;
    const route = resolved ?? this.findRoute(modelId);
    if (!route) return "auto";
    return this.resolveReasoning(route, requestedEffort).mode ?? "auto";
  }

  /**
   * Trả về mode built-in hoặc thông số capability selector động (cho model mới phát hiện qua Refresh).
   */
  public resolveCapabilityTarget(
    modelId?: string,
    requestedEffort?: string,
  ): M365ResolvedCapabilityTarget {
    if (!modelId) return { mode: "auto" };
    const resolved = ModelConfigStore.getInstance().findResolvedRoute(this, modelId) as
      | M365ModelRouteDefinition
      | undefined;
    const route = resolved ?? this.findRoute(modelId);
    if (!route) return { mode: "auto" };

    const effort = this.resolveReasoning(route, requestedEffort);
    const isBuiltin = this.routes.some(builtin => builtin.slug === route.slug);
    if (!isBuiltin && route.capabilityMeta) {
      return {
        mode: route.slug,
        spec: {
          ...route.capabilityMeta,
          isQuickThink: effort.effort === "high" ? "think" : "quick",
        },
      };
    }

    return {
      mode: effort.mode ?? "auto",
    };
  }
}
