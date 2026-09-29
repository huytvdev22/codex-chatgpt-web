export const M365_COPILOT_MODEL_PREFIX = "m365-copilot/";

export interface M365ModelRoute {
  slug: string;
  displayName: string;
  description: string;
  backendModel: string;
  contextWindow: number;
  autoCompactTokenLimit: number;
  effectiveContextWindowPercent: number;
  composerCharLimit: number;
}

export const M365_MODEL_ROUTES: readonly M365ModelRoute[] = [
  {
    slug: "m365-copilot/gpt-5",
    displayName: "M365 Copilot (Web)",
    description: "Microsoft 365 Copilot Web with Enterprise Commercial Data Protection and Temporary Chat",
    backendModel: "m365-copilot-gpt5",
    contextWindow: 100_000,
    autoCompactTokenLimit: 90_000,
    effectiveContextWindowPercent: 90,
    composerCharLimit: 100_000,
  },
  {
    slug: "m365-copilot/fast",
    displayName: "M365 Copilot Fast (Web)",
    description: "Microsoft 365 Copilot Web Fast Mode for rapid coding tasks",
    backendModel: "m365-copilot-fast",
    contextWindow: 100_000,
    autoCompactTokenLimit: 90_000,
    effectiveContextWindowPercent: 90,
    composerCharLimit: 100_000,
  },
];

export function isM365ModelSlug(slug: string): boolean {
  if (typeof slug !== "string") return false;
  return slug.startsWith(M365_COPILOT_MODEL_PREFIX) || slug === "m365-copilot" || slug.startsWith("m365-");
}

export function availableM365ModelRoutes(): readonly M365ModelRoute[] {
  return M365_MODEL_ROUTES;
}

export function requireM365ModelRoute(slug: string): M365ModelRoute {
  const match = M365_MODEL_ROUTES.find(r => r.slug === slug);
  if (match) return match;
  // Fallback to default route for any m365-* slug
  return {
    slug,
    displayName: `M365 Copilot (${slug})`,
    description: "Microsoft 365 Copilot Web with Enterprise Protection",
    backendModel: "m365-copilot-custom",
    contextWindow: 100_000,
    autoCompactTokenLimit: 90_000,
    effectiveContextWindowPercent: 90,
    composerCharLimit: 100_000,
  };
}
