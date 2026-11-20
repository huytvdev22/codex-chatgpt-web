import type { Page } from "playwright-core";

export const AI_STUDIO_ORIGIN = "https://aistudio.google.com";
export const AI_STUDIO_DEFAULT_MODEL_SLUG = "gemini-4-hydrogen";
export const AI_STUDIO_NEW_CHAT_URL = `${AI_STUDIO_ORIGIN}/prompts/new_chat?model=${AI_STUDIO_DEFAULT_MODEL_SLUG}`;
export const AI_STUDIO_CONVERSATION_ID_WAIT_TIMEOUT_MS = 20_000;

const AI_STUDIO_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Chuẩn hóa ID hội thoại AI Studio (giữ nguyên phân biệt hoa/thường của Drive resource ID)
 * và loại bỏ placeholder `"new_chat"`.
 */
export function normalizeAiStudioConversationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "new_chat") return undefined;
  return AI_STUDIO_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * Dựng URL tạo chat mới cho model cụ thể trên Google AI Studio.
 */
export function buildAiStudioNewChatUrl(model = AI_STUDIO_DEFAULT_MODEL_SLUG): string {
  return `${AI_STUDIO_ORIGIN}/prompts/new_chat?model=${encodeURIComponent(model)}`;
}

/**
 * Dựng URL truy cập trực tiếp một hội thoại AI Studio đã lưu.
 */
export function buildAiStudioConversationUrl(conversationId: string): string {
  const normalized = normalizeAiStudioConversationId(conversationId);
  if (!normalized) {
    throw new Error(`AI Studio conversation id is invalid: ${String(conversationId)}`);
  }
  return `${AI_STUDIO_ORIGIN}/prompts/${normalized}`;
}

/**
 * Tách conversation ID từ URL `https://aistudio.google.com/prompts/<id>`.
 */
export function parseAiStudioConversationId(rawUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.origin !== AI_STUDIO_ORIGIN || url.username || url.password) {
    return undefined;
  }
  const match = /^\/prompts\/([^/]+)\/?$/.exec(url.pathname);
  return normalizeAiStudioConversationId(match?.[1]);
}

async function waitPollIntervalWithAbort(
  page: Page,
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (delayMs <= 0 || signal?.aborted) return;
  if (!signal) {
    await page.waitForTimeout(delayMs);
    return;
  }
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([
      page.waitForTimeout(delayMs).catch(() => {}),
      abortPromise,
    ]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Chờ URL chuyển từ `/prompts/new_chat` sang `/prompts/<id>` sau khi
 * `MakerSuiteService/CreatePrompt` lưu hội thoại mới bất đồng bộ.
 * Thoát ngay lập tức khi URL có ID hoặc khi `signal` bị hủy.
 */
export async function waitForAiStudioConversationId(
  page: Page,
  timeoutMs = AI_STUDIO_CONVERSATION_ID_WAIT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const conversationId = parseAiStudioConversationId(page.url());
    if (conversationId) return conversationId;
    if (signal?.aborted) return undefined;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return undefined;
    await waitPollIntervalWithAbort(page, Math.min(150, remainingMs), signal);
  }
}
