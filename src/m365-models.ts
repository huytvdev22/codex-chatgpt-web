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
  inputModalities?: readonly ("text" | "image")[];
}

export const M365_MODEL_ROUTES: readonly M365ModelRoute[] = [
  {
    slug: "m365-copilot/gpt-5.6",
    displayName: "M365 - GPT 5.6",
    description: "GPT 5.6 qua Microsoft 365 Copilot Web",
    backendModel: "m365-copilot-gpt5.6",
    capabilityMode: "gpt-5.6-quick",
    contextWindow: 100_000,
    autoCompactTokenLimit: 90_000,
    effectiveContextWindowPercent: 90,
    composerCharLimit: 100_000,
    inputModalities: ["text", "image"],
  },
  {
    slug: "m365-copilot",
    displayName: "M365 Copilot",
    description: "Microsoft 365 Copilot Web",
    backendModel: "m365-copilot",
    capabilityMode: "quick",
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

export function resolveM365CapabilityMode(
  slug?: string,
  reasoning?: string,
): M365CapabilityMode {
  if (!slug || typeof slug !== "string") return "auto";
  const matched = M365_MODEL_ROUTES.find(r => r.slug === slug);
  if (matched) {
    const deeper = reasoning === "high"
      || reasoning === "xhigh"
      || reasoning === "max"
      || reasoning === "ultra";
    if (matched.slug === "m365-copilot/gpt-5.6") {
      return deeper ? "gpt-5.6-think" : "gpt-5.6-quick";
    }
    if (matched.slug === "m365-copilot") {
      return deeper ? "think" : "quick";
    }
    return matched.capabilityMode;
  }

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
