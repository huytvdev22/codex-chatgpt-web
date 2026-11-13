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
  | "m365-copilot"
  | "gemini-web"
  | "qwen-web";

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
  "gemini-web": {
    id: "gemini-web",
    exactSlugs: ["gemini-web"],
    slugPrefixes: ["gemini-web/", "gemini-"],
    routes: [
      {
        slug: "gemini-web/3.8-flash",
        displayName: "Gemini 3.8 Flash (Web)",
        description: "Gemini Flash với ba cấp độ tư duy.",
        backendModel: "gemini-3.8-flash",
        contextWindow: 128_000,
        autoCompactTokenLimit: 100_000,
        effectiveContextWindowPercent: 85,
        composerCharLimit: 100_000,
        inputModalities: ["text", "image"],
        defaultReasoningLevel: "medium",
        reasoningLevels: [
          { effort: "low", description: "Thấp" },
          { effort: "medium", description: "Trung bình" },
          { effort: "high", description: "Cao" },
        ],
        metadata: { capabilityMode: "flash", targetMenuLabel: "3.8 Flash" },
      },
      {
        slug: "gemini-web/3.1-pro",
        displayName: "Gemini 3.1 Pro (Web)",
        description: "Gemini Pro với ba cấp độ tư duy.",
        backendModel: "gemini-3.1-pro",
        contextWindow: 128_000,
        autoCompactTokenLimit: 100_000,
        effectiveContextWindowPercent: 85,
        composerCharLimit: 100_000,
        inputModalities: ["text", "image"],
        defaultReasoningLevel: "medium",
        reasoningLevels: [
          { effort: "low", description: "Thấp" },
          { effort: "medium", description: "Trung bình" },
          { effort: "high", description: "Cao" },
        ],
        metadata: { capabilityMode: "pro", targetMenuLabel: "3.1 Pro" },
      },
      {
        slug: "gemini-web/3.5-flash-lite",
        displayName: "Gemini 3.5 Flash-Lite (Web)",
        description: "Gemini Flash-Lite với ba cấp độ tư duy.",
        backendModel: "gemini-3.5-flash-lite",
        contextWindow: 128_000,
        autoCompactTokenLimit: 100_000,
        effectiveContextWindowPercent: 85,
        composerCharLimit: 100_000,
        inputModalities: ["text", "image"],
        defaultReasoningLevel: "medium",
        reasoningLevels: [
          { effort: "low", description: "Thấp" },
          { effort: "medium", description: "Trung bình" },
          { effort: "high", description: "Cao" },
        ],
        metadata: { capabilityMode: "flash-lite", targetMenuLabel: "3.5 Flash-Lite" },
      },
      {
        slug: "gemini-web/4-argon",
        displayName: "Gemini 4 Argon (Web)",
        description: "Gemini Argon với ba cấp độ tư duy.",
        backendModel: "gemini-4-argon",
        contextWindow: 128_000,
        autoCompactTokenLimit: 100_000,
        effectiveContextWindowPercent: 85,
        composerCharLimit: 100_000,
        inputModalities: ["text", "image"],
        defaultReasoningLevel: "medium",
        reasoningLevels: [
          { effort: "low", description: "Thấp" },
          { effort: "medium", description: "Trung bình" },
          { effort: "high", description: "Cao" },
        ],
        metadata: { capabilityMode: "argon", targetMenuLabel: "4 Argon" },
      },
      {
        slug: "gemini-web",
        displayName: "Google Gemini Web",
        description: "Google Gemini Web mặc định.",
        backendModel: "gemini-web",
        contextWindow: 128_000,
        autoCompactTokenLimit: 100_000,
        effectiveContextWindowPercent: 85,
        composerCharLimit: 100_000,
        inputModalities: ["text", "image"],
        defaultReasoningLevel: "medium",
        reasoningLevels: [
          { effort: "low", description: "Thấp" },
          { effort: "medium", description: "Trung bình" },
          { effort: "high", description: "Cao" },
        ],
        metadata: { capabilityMode: "auto", targetMenuLabel: "3.8 Flash" },
      },
    ],
  },
  "qwen-web": {
    id: "qwen-web",
    exactSlugs: ["qwen-web"],
    slugPrefixes: ["qwen-web/"],
    routes: [
      {
        slug: "qwen-web",
        displayName: "Qwen3.7 Plus (Web)",
        description: "Qwen3.7 Plus qua Qwen Web, hỗ trợ văn bản và đa phương thức.",
        backendModel: "Qwen3.7-Plus",
        contextWindow: 128_000,
        autoCompactTokenLimit: 96_000,
        effectiveContextWindowPercent: 95,
        composerCharLimit: 200_000,
        inputModalities: ["text", "image"],
        defaultReasoningLevel: "low",
        reasoningLevels: [
          { effort: "low", description: "Off", mode: "normal" },
          { effort: "high", description: "Think", mode: "thinking" },
        ],
        metadata: { targetMenuLabel: "Qwen3.7-Plus" },
      },
      {
        slug: "qwen-web/qwen3.7-plus",
        displayName: "Qwen3.7 Plus (Web)",
        description: "Qwen3.7 Plus qua Qwen Web, hỗ trợ văn bản và đa phương thức.",
        backendModel: "Qwen3.7-Plus",
        contextWindow: 128_000,
        autoCompactTokenLimit: 96_000,
        effectiveContextWindowPercent: 95,
        composerCharLimit: 200_000,
        inputModalities: ["text", "image"],
        defaultReasoningLevel: "low",
        reasoningLevels: [
          { effort: "low", description: "Off", mode: "normal" },
          { effort: "high", description: "Think", mode: "thinking" },
        ],
        metadata: { targetMenuLabel: "Qwen3.7-Plus" },
      },
      {
        slug: "qwen-web/qwen3.8-max",
        displayName: "Qwen3.8 Max (Web)",
        description: "Model flagship Qwen3.8 Max qua Qwen Web.",
        backendModel: "Qwen3.8-Max",
        contextWindow: 128_000,
        autoCompactTokenLimit: 96_000,
        effectiveContextWindowPercent: 95,
        composerCharLimit: 200_000,
        inputModalities: ["text", "image"],
        defaultReasoningLevel: "low",
        reasoningLevels: [
          { effort: "low", description: "Off", mode: "normal" },
          { effort: "high", description: "Think", mode: "thinking" },
        ],
        metadata: { targetMenuLabel: "Qwen3.8-Max" },
      },
      {
        slug: "qwen-web/qwen4-max-preview",
        displayName: "Qwen4 Max Preview (Web)",
        description: "A preview of the flagship Qwen4 model delivering state-of-the-art performance.",
        backendModel: "Qwen4-Max-Preview",
        contextWindow: 128_000,
        autoCompactTokenLimit: 96_000,
        effectiveContextWindowPercent: 95,
        composerCharLimit: 200_000,
        inputModalities: ["text", "image"],
        defaultReasoningLevel: "low",
        reasoningLevels: [
          { effort: "low", description: "Off", mode: "normal" },
          { effort: "high", description: "Think", mode: "thinking" },
        ],
        metadata: { targetMenuLabel: "Qwen4-Max-Preview" },
      },
      {
        slug: "qwen-web/qwen3.8-omni-flash",
        displayName: "Qwen3.8 Omni Flash (Web)",
        description: "Qwen3.8 Omni Flash qua Qwen Web, tối ưu tác vụ đa phương thức tốc độ cao.",
        backendModel: "Qwen3.8-Omni-Flash",
        contextWindow: 128_000,
        autoCompactTokenLimit: 96_000,
        effectiveContextWindowPercent: 95,
        composerCharLimit: 200_000,
        inputModalities: ["text", "image"],
        defaultReasoningLevel: "low",
        reasoningLevels: [
          { effort: "low", description: "Off", mode: "normal" },
          { effort: "high", description: "Think", mode: "thinking" },
        ],
        metadata: { targetMenuLabel: "Qwen3.8-Omni-Flash" },
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

export function resolveGeminiTargetMenuLabel(modelId?: string): string {
  if (!modelId) return "3.8 Flash";
  return findModelRoute(modelId)?.metadata?.targetMenuLabel ?? "3.8 Flash";
}

export function resolveGeminiReasoningEffort(
  modelId?: string,
  requestedEffort?: string,
): ModelReasoningEffort {
  const route = modelId ? findModelRoute(modelId) : undefined;
  if (!route) return "medium";
  return resolveModelReasoning(route, requestedEffort).effort;
}

export function resolveQwenTargetMenuLabel(modelId?: string): string {
  if (!modelId) return "Qwen3.7-Plus";
  return findModelRoute(modelId)?.metadata?.targetMenuLabel ?? "Qwen3.7-Plus";
}
