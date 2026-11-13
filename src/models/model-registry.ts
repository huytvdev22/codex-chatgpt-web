export type ModelReasoningEffort = "low" | "medium" | "high";
export type ModelInputModality = "text" | "image";
export type M365CapabilityMode =
  | "auto"
  | "quick"
  | "think"
  | "gpt-5.6-think"
  | "gpt-5.6-quick";

export interface ChatGptWebAccountCapabilities {
  solAvailable: boolean;
  extraHighAvailable?: boolean;
  proAvailable: boolean;
}

export interface ModelReasoningLevel {
  effort: ModelReasoningEffort;
  description: string;
  mode?: string;
}

export interface ModelRouteDefinition {
  slug: string;
  displayName: string;
  description: string;
  backendModel: string;
  contextWindow: number;
  autoCompactTokenLimit: number;
  effectiveContextWindowPercent: number;
  composerCharLimit: number;
  inputModalities: readonly ModelInputModality[];
  defaultReasoningLevel: ModelReasoningEffort;
  reasoningLevels: readonly ModelReasoningLevel[];
  metadata?: Readonly<Record<string, string>>;
}

export interface ModelProviderDefinition {
  id: ModelProviderId;
  exactSlugs: readonly string[];
  slugPrefixes: readonly string[];
  routes: readonly ModelRouteDefinition[];
}

export type ModelProviderId =
  | "chatgpt-web"
  | "m365-copilot";

const CHATGPT_WEB_ROUTE: ModelRouteDefinition = {
  slug: "chatgpt-web",
  displayName: "ChatGPT (Web)",
  description: "ChatGPT Web với chế độ thường hoặc suy nghĩ.",
  backendModel: "chatgpt-web",
  contextWindow: 100_000,
  autoCompactTokenLimit: 90_000,
  effectiveContextWindowPercent: 90,
  composerCharLimit: 500_000,
  inputModalities: ["text", "image"],
  defaultReasoningLevel: "low",
  reasoningLevels: [
    { effort: "low", description: "Normal", mode: "normal" },
    { effort: "high", description: "Thinking", mode: "thinking" },
  ],
};

export const MODEL_PROVIDERS: Readonly<Record<ModelProviderId, ModelProviderDefinition>> = {
  "chatgpt-web": {
    id: "chatgpt-web",
    exactSlugs: ["chatgpt-web"],
    slugPrefixes: ["chatgpt-web/"],
    routes: [CHATGPT_WEB_ROUTE],
  },
  "m365-copilot": {
    id: "m365-copilot",
    exactSlugs: ["m365-copilot"],
    slugPrefixes: ["m365-copilot/", "m365-"],
    routes: [
      {
        slug: "m365-copilot/gpt-5.6",
        displayName: "M365 - GPT 5.6",
        description: "GPT 5.6 qua Microsoft 365 Copilot Web",
        backendModel: "m365-copilot-gpt5.6",
        contextWindow: 100_000,
        autoCompactTokenLimit: 90_000,
        effectiveContextWindowPercent: 90,
        composerCharLimit: 100_000,
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
        backendModel: "m365-copilot",
        contextWindow: 100_000,
        autoCompactTokenLimit: 90_000,
        effectiveContextWindowPercent: 90,
        composerCharLimit: 100_000,
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

export function findModelProvider(modelId: string): ModelProviderDefinition | undefined {
  return Object.values(MODEL_PROVIDERS).find(provider =>
    provider.exactSlugs.includes(modelId)
    || provider.slugPrefixes.some(prefix => modelId.startsWith(prefix))
  );
}

export function isProviderModel(modelId: string, providerId: ModelProviderId): boolean {
  return findModelProvider(modelId)?.id === providerId;
}

export function listModelRoutes(providerId?: ModelProviderId): readonly ModelRouteDefinition[] {
  if (providerId) return MODEL_PROVIDERS[providerId].routes;
  return Object.values(MODEL_PROVIDERS).flatMap(provider => provider.routes);
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

export function resolveModelMode(modelId: string, requestedEffort?: string): string | undefined {
  return resolveModelReasoning(requireModelRoute(modelId), requestedEffort).mode;
}

export function resolveM365CapabilityMode(
  modelId?: string,
  requestedEffort?: string,
): M365CapabilityMode {
  if (!modelId) return "auto";
  const mode = resolveModelMode(modelId, requestedEffort);
  if (
    mode === "quick"
    || mode === "think"
    || mode === "gpt-5.6-think"
    || mode === "gpt-5.6-quick"
  ) {
    return mode;
  }
  return "auto";
}
