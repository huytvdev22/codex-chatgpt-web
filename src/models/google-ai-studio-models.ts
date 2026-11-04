/**
 * Định nghĩa Model Route cho Google AI Studio (aistudio.google.com).
 * Chỉ giữ duy nhất 1 bản mặc định theo cấu hình:
 * URL new chat: https://aistudio.google.com/u/0/prompts/new_chat?model=gemini-flash-latest
 */

export const GOOGLE_AI_STUDIO_DEFAULT_SLUG = "google-ai-studio";

export type GoogleAIStudioCodexEffort = "low" | "medium" | "high";

export interface GoogleAIStudioModelRoute {
  slug: string;
  backendModel: string;
  displayName: string;
  description: string;
  contextWindow: number;
  autoCompactTokenLimit: number;
  composerCharLimit: number;
  effectiveContextWindowPercent: number;
  supportedCodexEfforts: readonly GoogleAIStudioCodexEffort[];
  defaultEffort: GoogleAIStudioCodexEffort;
  urlModelParam: string;
}

export const GOOGLE_AI_STUDIO_DEFAULT_ROUTE: GoogleAIStudioModelRoute = {
  slug: GOOGLE_AI_STUDIO_DEFAULT_SLUG,
  backendModel: "gemini-flash-latest",
  displayName: "Google AI Studio",
  description: "Google AI Studio với Gemini Flash Latest và tùy chỉnh Thinking Level (Low/Medium/High).",
  contextWindow: 1_000_000,
  autoCompactTokenLimit: 800_000,
  composerCharLimit: 500_000,
  effectiveContextWindowPercent: 90,
  supportedCodexEfforts: ["low", "medium", "high"],
  defaultEffort: "medium",
  urlModelParam: "gemini-flash-latest",
};

export const GOOGLE_AI_STUDIO_ROUTES: readonly GoogleAIStudioModelRoute[] = [
  GOOGLE_AI_STUDIO_DEFAULT_ROUTE,
];

/**
 * Kiểm tra xem một modelId có phải là Google AI Studio không.
 */
export function isGoogleAIStudioModelSlug(modelId: string): boolean {
  if (typeof modelId !== "string") return false;
  return modelId === GOOGLE_AI_STUDIO_DEFAULT_SLUG || modelId.startsWith(`${GOOGLE_AI_STUDIO_DEFAULT_SLUG}/`);
}

/**
 * Lấy danh sách các routes của Google AI Studio.
 */
export function availableGoogleAIStudioModelRoutes(): readonly GoogleAIStudioModelRoute[] {
  return GOOGLE_AI_STUDIO_ROUTES;
}

/**
 * Trả về Route tương ứng với modelId.
 */
export function requireGoogleAIStudioModelRoute(modelId: string): GoogleAIStudioModelRoute {
  if (isGoogleAIStudioModelSlug(modelId)) {
    return GOOGLE_AI_STUDIO_DEFAULT_ROUTE;
  }
  throw new Error(`Google AI Studio model không tồn tại: ${modelId}`);
}
