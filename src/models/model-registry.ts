export type ModelReasoningEffort = "low" | "medium" | "high";
export type ModelInputModality = "text" | "image";
export type M365CapabilityMode =
  | "auto"
  | "quick"
  | "think"
  | "gpt-5.6-think"
  | "gpt-5.6-quick";

export interface ModelReasoningLevel {
  effort: ModelReasoningEffort;
  description: string;
  mode?: M365CapabilityMode;
}

export interface ModelRouteDefinition {
  slug: string;
  displayName: string;
  description: string;
  contextWindow: number;
  autoCompactTokenLimit: number;
  effectiveContextWindowPercent: number;
  inputModalities: readonly ModelInputModality[];
  defaultReasoningLevel: ModelReasoningEffort;
  reasoningLevels: readonly ModelReasoningLevel[];
}

export interface ModelProviderDefinition {
  id: ModelProviderId;
  exactSlugs: readonly string[];
  slugPrefixes: readonly string[];
  routes: readonly ModelRouteDefinition[];
}

export type ModelProviderId = "m365-copilot";

export const MODEL_PROVIDERS: Readonly<Record<ModelProviderId, ModelProviderDefinition>> = {
  "m365-copilot": {
    id: "m365-copilot",
    exactSlugs: ["m365-copilot"],
    slugPrefixes: ["m365-copilot/", "m365-"],
    routes: [
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
    ],
  },
};

const PROVIDER_LIST: readonly ModelProviderDefinition[] = Object.values(MODEL_PROVIDERS);
const ALL_MODEL_ROUTES: readonly ModelRouteDefinition[] = PROVIDER_LIST.flatMap(
  provider => provider.routes,
);

export function findModelProvider(modelId: string): ModelProviderDefinition | undefined {
  return PROVIDER_LIST.find(provider =>
    provider.exactSlugs.includes(modelId)
    || provider.slugPrefixes.some(prefix => modelId.startsWith(prefix))
  );
}

export function isProviderModel(modelId: string, providerId: ModelProviderId): boolean {
  return findModelProvider(modelId)?.id === providerId;
}

export function listModelRoutes(providerId?: ModelProviderId): readonly ModelRouteDefinition[] {
  return providerId ? MODEL_PROVIDERS[providerId].routes : ALL_MODEL_ROUTES;
}

export function findModelRoute(modelId: string): ModelRouteDefinition | undefined {
  const provider = findModelProvider(modelId);
  if (!provider) return undefined;
  return provider.routes.find(route => route.slug === modelId);
}

export function requireModelRoute(modelId: string): ModelRouteDefinition {
  const route = findModelRoute(modelId);
  if (!route) throw new Error(`Model không tồn tại: ${modelId}`);
  return route;
}

export function resolveModelReasoning(
  route: ModelRouteDefinition,
  requestedEffort?: string,
): ModelReasoningLevel {
  return route.reasoningLevels.find(level => level.effort === requestedEffort)
    ?? route.reasoningLevels.find(level => level.effort === route.defaultReasoningLevel)
    ?? route.reasoningLevels[0]!;
}

export function resolveModelMode(
  modelId: string,
  requestedEffort?: string,
): M365CapabilityMode | undefined {
  return resolveModelReasoning(requireModelRoute(modelId), requestedEffort).mode;
}

export function resolveM365CapabilityMode(
  modelId?: string,
  requestedEffort?: string,
): M365CapabilityMode {
  if (!modelId) return "auto";
  return resolveModelMode(modelId, requestedEffort) ?? "auto";
}
