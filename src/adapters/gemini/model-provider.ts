import { BaseModelProvider } from "../../models/base-model-provider";
import { ModelConfigStore } from "../../models/model-config-store";
import type {
  DiscoveredModelEntry,
  ModelRouteDefinition,
} from "../../models/types";

export type GeminiThinkingEffort = "low" | "medium" | "high";

export interface GeminiModelRouteDefinition
  extends ModelRouteDefinition<GeminiThinkingEffort> {
  readonly uiLabel: string;
  readonly isAccountDefault?: boolean;
}

export interface GeminiCapabilityTarget {
  readonly modelSlug: string;
  readonly modelLabel: string;
  readonly remoteModelId?: string;
  readonly isAccountDefault?: boolean;
  readonly thinkingEffort: GeminiThinkingEffort;
}

export const GEMINI_DEFAULT_MODEL_SLUG = "gemini/4-hydrogen";

const GEMINI_REASONING_LEVELS: GeminiModelRouteDefinition["reasoningLevels"] = [
  { effort: "low", description: "Low thinking (Fast and efficient)", mode: "low" },
  { effort: "medium", description: "Medium thinking (Balanced depth)", mode: "medium" },
  { effort: "high", description: "High thinking (Extra thorough)", mode: "high" },
];

/**
 * Danh mục model và ánh xạ Thinking Level cho Gemini Web (`gemini.google.com`).
 */
export class GeminiModelProvider extends BaseModelProvider<GeminiModelRouteDefinition> {
  private static readonly instance = new GeminiModelProvider();

  public readonly id = "gemini";
  public readonly exactSlugs = [
    "gemini",
    "gemini/4-hydrogen",
    "gemini/4-neon",
  ] as const;
  public readonly slugPrefixes = ["gemini/"] as const;
  public readonly routes: readonly GeminiModelRouteDefinition[] = [
    {
      slug: "gemini/4-hydrogen",
      uiLabel: "4 Hydrogen",
      isAccountDefault: true,
      displayName: "Gemini Web - 4 Hydrogen",
      description: "Everyday help — 4 Hydrogen qua Gemini Web",
      contextWindow: 1_000_000,
      autoCompactTokenLimit: 900_000,
      effectiveContextWindowPercent: 90,
      inputModalities: ["text", "image"],
      defaultReasoningLevel: "medium",
      reasoningLevels: GEMINI_REASONING_LEVELS,
    },
    {
      slug: "gemini/4-neon",
      uiLabel: "4 Neon",
      displayName: "Gemini Web - 4 Neon",
      description: "Deeper analysis — 4 Neon qua Gemini Web",
      contextWindow: 1_000_000,
      autoCompactTokenLimit: 900_000,
      effectiveContextWindowPercent: 90,
      inputModalities: ["text", "image"],
      defaultReasoningLevel: "medium",
      reasoningLevels: GEMINI_REASONING_LEVELS,
    },
  ];

  public static getInstance(): GeminiModelProvider {
    return GeminiModelProvider.instance;
  }

  public override buildRouteFromDiscovered(
    entry: DiscoveredModelEntry,
  ): GeminiModelRouteDefinition | undefined {
    const cleanSlug = entry.slug.trim();
    if (!cleanSlug) return undefined;
    const normalizedSlug =
      cleanSlug === "gemini"
        ? GEMINI_DEFAULT_MODEL_SLUG
        : cleanSlug.startsWith("gemini/")
          ? cleanSlug
          : `gemini/${cleanSlug}`;

    const uiLabel = (
      entry.uiLabel ||
      entry.displayName.replace(/^Gemini(?:\s+Web)?\s*-\s*/i, "")
    ).trim();
    if (!uiLabel) return undefined;

    const contextWindow = entry.contextWindow ?? 1_000_000;
    const effectiveContextWindowPercent = 90;

    return {
      slug: normalizedSlug,
      uiLabel,
      ...(entry.isAccountDefault !== undefined
        ? { isAccountDefault: entry.isAccountDefault }
        : {}),
      ...(entry.remoteModelId ? { remoteModelId: entry.remoteModelId } : {}),
      displayName: entry.displayName,
      description: entry.description || `${uiLabel} qua Gemini Web`,
      contextWindow,
      autoCompactTokenLimit: Math.round(
        contextWindow * (effectiveContextWindowPercent / 100),
      ),
      effectiveContextWindowPercent,
      inputModalities: entry.inputModalities ?? ["text", "image"],
      defaultReasoningLevel: entry.defaultReasoningLevel ?? "medium",
      reasoningLevels: GEMINI_REASONING_LEVELS,
    };
  }

  public override findRoute(
    modelId: string,
  ): GeminiModelRouteDefinition | undefined {
    const exact = super.findRoute(modelId);
    if (exact) return exact;
    if (modelId === "gemini" || modelId.startsWith("gemini/")) {
      return this.routes[0];
    }
    return undefined;
  }

  private resolveManagedRoute(modelId: string): GeminiModelRouteDefinition {
    const resolved = ModelConfigStore.getInstance().findResolvedRoute(
      this,
      modelId,
    ) as GeminiModelRouteDefinition | undefined;
    return resolved ?? this.findRoute(modelId) ?? this.routes[0]!;
  }

  public resolveThinkingEffort(
    modelId = GEMINI_DEFAULT_MODEL_SLUG,
    requestedEffort?: string,
  ): GeminiThinkingEffort {
    const route = this.resolveManagedRoute(modelId);
    return this.resolveReasoning(route, requestedEffort).mode ?? "medium";
  }

  public resolveCapabilityTarget(
    modelId = GEMINI_DEFAULT_MODEL_SLUG,
    requestedEffort?: string,
  ): GeminiCapabilityTarget {
    const route = this.resolveManagedRoute(modelId);
    const thinkingEffort =
      this.resolveReasoning(route, requestedEffort).mode ?? "medium";
    const uiLabel =
      route.uiLabel ||
      route.displayName.replace(/^Gemini(?:\s+Web)?\s*-\s*/i, "");
    return {
      modelSlug: route.slug,
      modelLabel: uiLabel,
      ...(route.remoteModelId ? { remoteModelId: route.remoteModelId } : {}),
      ...(route.isAccountDefault !== undefined
        ? { isAccountDefault: route.isAccountDefault }
        : {}),
      thinkingEffort,
    };
  }
}
