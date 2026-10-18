export const QWEN_WEB_MODEL_PREFIX = "qwen-web/";
export const QWEN_WEB_DEFAULT_SLUG = "qwen-web";

export type QwenWebCodexEffort = "none" | "low" | "medium" | "high" | "think";

export interface QwenWebModelRoute {
  slug: string;
  backendModel: string;
  displayName: string;
  description: string;
  contextWindow: number;
  autoCompactTokenLimit: number;
  composerCharLimit: number;
  supportedCodexEfforts?: readonly QwenWebCodexEffort[];
  defaultEffort?: QwenWebCodexEffort;
}

export const QWEN_WEB_DEFAULT_ROUTE: QwenWebModelRoute = {
  slug: QWEN_WEB_DEFAULT_SLUG,
  backendModel: "qwen-max",
  displayName: "Qwen (Web)",
  description: "Giao diện Qwen Chat Web (chat.qwen.ai) hỗ trợ thực thi công cụ và tư duy suy luận",
  contextWindow: 128_000,
  autoCompactTokenLimit: 96_000,
  composerCharLimit: 200_000,
  supportedCodexEfforts: ["none", "think"],
  defaultEffort: "none",
};

export const QWEN_WEB_THINK_ROUTE: QwenWebModelRoute = {
  slug: "qwen-web/think",
  backendModel: "qwen-max-thinking",
  displayName: "Qwen (Web Think)",
  description: "Qwen Chat Web với chế độ suy nghĩ sâu (Thinking Mode)",
  contextWindow: 128_000,
  autoCompactTokenLimit: 96_000,
  composerCharLimit: 200_000,
  supportedCodexEfforts: ["think"],
  defaultEffort: "think",
};

export const QWEN_ROUTES: readonly QwenWebModelRoute[] = [
  QWEN_WEB_DEFAULT_ROUTE,
  QWEN_WEB_THINK_ROUTE,
];

const routesBySlug = new Map<string, QwenWebModelRoute>(
  QWEN_ROUTES.map(route => [route.slug, route])
);

export function isQwenModelSlug(modelId: string): boolean {
  if (typeof modelId !== "string") return false;
  return modelId === QWEN_WEB_DEFAULT_SLUG || modelId.startsWith(QWEN_WEB_MODEL_PREFIX);
}

export function availableQwenWebModelRoutes(): readonly QwenWebModelRoute[] {
  return [QWEN_WEB_DEFAULT_ROUTE];
}

export function requireQwenWebModelRoute(modelId: string): QwenWebModelRoute {
  const route = routesBySlug.get(modelId);
  if (!route) {
    if (isQwenModelSlug(modelId)) {
      return QWEN_WEB_DEFAULT_ROUTE;
    }
    throw new Error(`Qwen web model không tồn tại: ${modelId}`);
  }
  return route;
}
