export const M365_COPILOT_MODEL_PREFIX = "m365-copilot/";

export type M365CapabilityMode =
  | "auto"
  | "quick"
  | "think"
  | "gpt-5.6-think"
  | "gpt-5.6-quick";

export interface M365ModelRoute {
  slug: string;
  displayName: string;
  description: string;
  backendModel: string;
  capabilityMode: M365CapabilityMode;
  contextWindow: number;
  autoCompactTokenLimit: number;
  effectiveContextWindowPercent: number;
  composerCharLimit: number;
  legacy?: boolean;
  inputModalities?: readonly ("text" | "image")[];
}

export const M365_MODEL_ROUTES: readonly M365ModelRoute[] = [
  {
    slug: "m365-copilot/auto",
    displayName: "M365 Copilot Auto (Web)",
    description: "Microsoft 365 Copilot Web - Tự động cân nhắc thời gian suy nghĩ (Auto mode)",
    backendModel: "m365-copilot-auto",
    capabilityMode: "auto",
    contextWindow: 100_000,
    autoCompactTokenLimit: 90_000,
    effectiveContextWindowPercent: 90,
    composerCharLimit: 100_000,
    inputModalities: ["text", "image"],
  },
  {
    slug: "m365-copilot/gpt-5.6-think",
    displayName: "M365 Copilot GPT 5.6 Think Deeper (Web)",
    description: "OpenAI GPT 5.6 Think deeper qua Microsoft 365 Copilot Web (Mô hình suy nghĩ chuyên sâu)",
    backendModel: "m365-copilot-gpt5.6-think",
    capabilityMode: "gpt-5.6-think",
    contextWindow: 100_000,
    autoCompactTokenLimit: 90_000,
    effectiveContextWindowPercent: 90,
    composerCharLimit: 100_000,
    inputModalities: ["text", "image"],
  },
  {
    slug: "m365-copilot/gpt-5.6-quick",
    displayName: "M365 Copilot GPT 5.6 Quick Response (Web)",
    description: "OpenAI GPT 5.6 Quick response qua Microsoft 365 Copilot Web (Mô hình phản hồi nhanh)",
    backendModel: "m365-copilot-gpt5.6-quick",
    capabilityMode: "gpt-5.6-quick",
    contextWindow: 100_000,
    autoCompactTokenLimit: 90_000,
    effectiveContextWindowPercent: 90,
    composerCharLimit: 100_000,
    inputModalities: ["text", "image"],
  },
  {
    slug: "m365-copilot/think",
    displayName: "M365 Copilot Think Deeper (Web)",
    description: "Microsoft 365 Copilot Web - Think deeper (Suy nghĩ lâu hơn cho câu trả lời tốt hơn)",
    backendModel: "m365-copilot-think",
    capabilityMode: "think",
    contextWindow: 100_000,
    autoCompactTokenLimit: 90_000,
    effectiveContextWindowPercent: 90,
    composerCharLimit: 100_000,
    inputModalities: ["text", "image"],
  },
  {
    slug: "m365-copilot/quick",
    displayName: "M365 Copilot Quick Response (Web)",
    description: "Microsoft 365 Copilot Web - Quick response (Trả lời nhanh ngay lập tức)",
    backendModel: "m365-copilot-quick",
    capabilityMode: "quick",
    contextWindow: 100_000,
    autoCompactTokenLimit: 90_000,
    effectiveContextWindowPercent: 90,
    composerCharLimit: 100_000,
    inputModalities: ["text", "image"],
  },
  // Backward compatibility routes (ẩn khỏi menu chọn model bằng legacy: true)
  {
    slug: "m365-copilot/gpt-5",
    displayName: "M365 Copilot GPT-5.6 (Web - Legacy)",
    description: "Microsoft 365 Copilot Web (Mặc định GPT 5.6 Think deeper)",
    backendModel: "m365-copilot-gpt5",
    capabilityMode: "gpt-5.6-think",
    legacy: true,
    contextWindow: 100_000,
    autoCompactTokenLimit: 90_000,
    effectiveContextWindowPercent: 90,
    composerCharLimit: 100_000,
    inputModalities: ["text", "image"],
  },
  {
    slug: "m365-copilot/fast",
    displayName: "M365 Copilot Fast (Web - Legacy)",
    description: "Microsoft 365 Copilot Web Fast Mode (Mặc định Quick response)",
    backendModel: "m365-copilot-fast",
    capabilityMode: "quick",
    legacy: true,
    contextWindow: 100_000,
    autoCompactTokenLimit: 90_000,
    effectiveContextWindowPercent: 90,
    composerCharLimit: 100_000,
    inputModalities: ["text", "image"],
  },
];

export function isM365ModelSlug(slug: string): boolean {
  if (typeof slug !== "string") return false;
  return slug.startsWith(M365_COPILOT_MODEL_PREFIX) || slug === "m365-copilot" || slug.startsWith("m365-");
}

export function availableM365ModelRoutes(): readonly M365ModelRoute[] {
  return M365_MODEL_ROUTES;
}

export function resolveM365CapabilityMode(slug?: string): M365CapabilityMode {
  if (!slug || typeof slug !== "string") return "auto";
  const matched = M365_MODEL_ROUTES.find(r => r.slug === slug);
  if (matched) return matched.capabilityMode;

  const lower = slug.toLowerCase();
  if (lower.includes("5.6") || lower.includes("gpt5.6") || lower.includes("gpt-5.6")) {
    if (lower.includes("think") || lower.includes("reason") || lower.includes("deep")) {
      return "gpt-5.6-think";
    }
    return "gpt-5.6-quick";
  }
  if (lower.includes("think") || lower.includes("reason") || lower.includes("deep")) {
    return "think";
  }
  if (lower.includes("quick") || lower.includes("fast") || lower.includes("instant")) {
    return "quick";
  }
  return "auto";
}

export function requireM365ModelRoute(slug: string): M365ModelRoute {
  const match = M365_MODEL_ROUTES.find(r => r.slug === slug);
  if (match) return match;
  const capabilityMode = resolveM365CapabilityMode(slug);
  // Fallback to default route for any m365-* slug
  return {
    slug,
    displayName: `M365 Copilot (${slug})`,
    description: "Microsoft 365 Copilot Web with Enterprise Protection",
    backendModel: "m365-copilot-custom",
    capabilityMode,
    contextWindow: 100_000,
    autoCompactTokenLimit: 90_000,
    effectiveContextWindowPercent: 90,
    composerCharLimit: 100_000,
  };
}
