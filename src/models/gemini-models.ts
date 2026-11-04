export const GEMINI_WEB_MODEL_PREFIX = "gemini-web/";

export type GeminiCapabilityMode =
  | "flash"
  | "pro"
  | "flash-lite"
  | "argon"
  | "thinking"
  | "auto";

export interface GeminiModelRoute {
  slug: string;
  displayName: string;
  description: string;
  backendModel: string;
  capabilityMode: GeminiCapabilityMode;
  targetMenuLabel: string;
  modeId?: string;
  reasoningEffort?: "low" | "medium" | "high";
  defaultReasoningLevel?: "low" | "medium" | "high";
  supportedReasoningLevels?: readonly ("low" | "medium" | "high")[];
  contextWindow: number;
  autoCompactTokenLimit: number;
  effectiveContextWindowPercent: number;
  composerCharLimit: number;
  inputModalities?: readonly ("text" | "image")[];
}

export const GEMINI_MODEL_ROUTES: readonly GeminiModelRoute[] = [
  {
    slug: "gemini-web/3.8-flash",
    displayName: "Gemini 3.8 Flash (Web)",
    description: "Trợ giúp toàn diện, tốc độ xử lý cao, hỗ trợ 3 cấp độ tư duy: Thấp, Trung bình, Cao",
    backendModel: "gemini-3.8-flash",
    capabilityMode: "flash",
    targetMenuLabel: "3.8 Flash",
    modeId: "56fdd199312815e2",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: ["low", "medium", "high"],
    contextWindow: 128_000,
    autoCompactTokenLimit: 100_000,
    effectiveContextWindowPercent: 85,
    composerCharLimit: 100_000,
    inputModalities: ["text", "image"],
  },
  {
    slug: "gemini-web/3.1-pro",
    displayName: "Gemini 3.1 Pro (Web)",
    description: "Suy luận nâng cao, hỗ trợ 3 cấp độ tư duy: Thấp, Trung bình, Cao",
    backendModel: "gemini-3.1-pro",
    capabilityMode: "pro",
    targetMenuLabel: "3.1 Pro",
    modeId: "e6fa609c3fa255c0",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: ["low", "medium", "high"],
    contextWindow: 128_000,
    autoCompactTokenLimit: 100_000,
    effectiveContextWindowPercent: 85,
    composerCharLimit: 100_000,
    inputModalities: ["text", "image"],
  },
  {
    slug: "gemini-web/3.5-flash-lite",
    displayName: "Gemini 3.5 Flash-Lite (Web)",
    description: "Câu trả lời nhanh nhất, tiết kiệm tài nguyên, hỗ trợ 3 cấp độ tư duy: Thấp, Trung bình, Cao",
    backendModel: "gemini-3.5-flash-lite",
    capabilityMode: "flash-lite",
    targetMenuLabel: "3.5 Flash-Lite",
    modeId: "8c46e95b1a07cecc",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: ["low", "medium", "high"],
    contextWindow: 128_000,
    autoCompactTokenLimit: 100_000,
    effectiveContextWindowPercent: 85,
    composerCharLimit: 100_000,
    inputModalities: ["text", "image"],
  },
  {
    slug: "gemini-web/4-argon",
    displayName: "Gemini 4 Argon (Web)",
    description: "Mô hình thế hệ mới cho các nhiệm vụ phức tạp, hỗ trợ 3 cấp độ tư duy: Thấp, Trung bình, Cao",
    backendModel: "gemini-4-argon",
    capabilityMode: "argon",
    targetMenuLabel: "4 Argon",
    modeId: "95a4c0abcba24364",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: ["low", "medium", "high"],
    contextWindow: 128_000,
    autoCompactTokenLimit: 100_000,
    effectiveContextWindowPercent: 85,
    composerCharLimit: 100_000,
    inputModalities: ["text", "image"],
  },
  {
    slug: "gemini-web",
    displayName: "Google Gemini Web",
    description: "Google Gemini Web Session mặc định (3.8 Flash), hỗ trợ 3 cấp độ tư duy: Thấp, Trung bình, Cao",
    backendModel: "gemini-web",
    capabilityMode: "auto",
    targetMenuLabel: "3.8 Flash",
    modeId: "56fdd199312815e2",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: ["low", "medium", "high"],
    contextWindow: 128_000,
    autoCompactTokenLimit: 100_000,
    effectiveContextWindowPercent: 85,
    composerCharLimit: 100_000,
    inputModalities: ["text", "image"],
  },
];

export function isGeminiModelSlug(slug: string): boolean {
  if (typeof slug !== "string") return false;
  return (
    slug.startsWith(GEMINI_WEB_MODEL_PREFIX) ||
    slug === "gemini-web" ||
    slug.startsWith("gemini-")
  );
}

export function availableGeminiModelRoutes(): readonly GeminiModelRoute[] {
  return GEMINI_MODEL_ROUTES;
}

export function resolveGeminiCapabilityMode(
  slug?: string
): GeminiCapabilityMode {
  if (!slug) return "auto";
  const matched = GEMINI_MODEL_ROUTES.find((r) => r.slug === slug);
  if (matched) return matched.capabilityMode;
  if (slug.includes("thinking")) return "thinking";
  if (slug.includes("pro") || slug.includes("3.1")) return "pro";
  if (slug.includes("argon") || slug.includes("4")) return "argon";
  if (slug.includes("flash-lite") || slug.includes("3.5")) return "flash-lite";
  if (slug.includes("flash") || slug.includes("3.8")) return "flash";
  return "auto";
}

export function resolveGeminiTargetMenuLabel(slug?: string): string {
  const mode = resolveGeminiCapabilityMode(slug);
  switch (mode) {
    case "pro":
    case "thinking":
      return "3.1 Pro";
    case "flash-lite":
      return "3.5 Flash-Lite";
    case "argon":
      return "4 Argon";
    case "flash":
    default:
      return "3.8 Flash";
  }
}

export function resolveGeminiReasoningEffort(
  slug?: string,
  requestedEffort?: string,
): "low" | "medium" | "high" | undefined {
  if (requestedEffort === "low" || requestedEffort === "medium" || requestedEffort === "high") {
    return requestedEffort;
  }
  if (slug) {
    const route = GEMINI_MODEL_ROUTES.find((r) => r.slug === slug);
    if (route?.reasoningEffort) return route.reasoningEffort;
    if (slug.includes("thinking-high") || slug.includes("high")) return "high";
    if (slug.includes("thinking-low") || slug.includes("low")) return "low";
    if (slug.includes("thinking-medium") || slug.includes("medium")) return "medium";
    if (slug.includes("thinking")) return "high";
    if (route?.defaultReasoningLevel) return route.defaultReasoningLevel;
  }
  return "medium";
}
