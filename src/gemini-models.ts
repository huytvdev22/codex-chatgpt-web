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
    description: "Trợ giúp toàn diện, tốc độ xử lý cao trên giao diện Gemini Web",
    backendModel: "gemini-3.8-flash",
    capabilityMode: "flash",
    targetMenuLabel: "3.8 Flash",
    contextWindow: 128_000,
    autoCompactTokenLimit: 100_000,
    effectiveContextWindowPercent: 85,
    composerCharLimit: 100_000,
    inputModalities: ["text", "image"],
  },
  {
    slug: "gemini-web/3.1-pro",
    displayName: "Gemini 3.1 Pro (Web)",
    description: "Suy luận nâng cao, giải quyết tác vụ phức tạp",
    backendModel: "gemini-3.1-pro",
    capabilityMode: "pro",
    targetMenuLabel: "3.1 Pro",
    contextWindow: 128_000,
    autoCompactTokenLimit: 100_000,
    effectiveContextWindowPercent: 85,
    composerCharLimit: 100_000,
    inputModalities: ["text", "image"],
  },
  {
    slug: "gemini-web/3.5-flash-lite",
    displayName: "Gemini 3.5 Flash-Lite (Web)",
    description: "Câu trả lời nhanh nhất, tiết kiệm tài nguyên",
    backendModel: "gemini-3.5-flash-lite",
    capabilityMode: "flash-lite",
    targetMenuLabel: "3.5 Flash-Lite",
    contextWindow: 128_000,
    autoCompactTokenLimit: 100_000,
    effectiveContextWindowPercent: 85,
    composerCharLimit: 100_000,
    inputModalities: ["text", "image"],
  },
  {
    slug: "gemini-web/4-argon",
    displayName: "Gemini 4 Argon (Web)",
    description: "Mô hình thế hệ mới cho các nhiệm vụ phức tạp",
    backendModel: "gemini-4-argon",
    capabilityMode: "argon",
    targetMenuLabel: "4 Argon",
    contextWindow: 128_000,
    autoCompactTokenLimit: 100_000,
    effectiveContextWindowPercent: 85,
    composerCharLimit: 100_000,
    inputModalities: ["text", "image"],
  },
  {
    slug: "gemini-web/thinking",
    displayName: "Gemini Thinking (Web)",
    description: "Gemini kích hoạt chế độ suy luận sâu (Thinking)",
    backendModel: "gemini-thinking",
    capabilityMode: "thinking",
    targetMenuLabel: "3.1 Pro", // Thinking hoạt động trên nền tảng Pro
    contextWindow: 128_000,
    autoCompactTokenLimit: 100_000,
    effectiveContextWindowPercent: 85,
    composerCharLimit: 100_000,
    inputModalities: ["text", "image"],
  },
  {
    slug: "gemini-web",
    displayName: "Google Gemini Web",
    description: "Google Gemini Web Session mặc định",
    backendModel: "gemini-web",
    capabilityMode: "auto",
    targetMenuLabel: "3.8 Flash",
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
