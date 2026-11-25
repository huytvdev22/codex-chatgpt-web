import type { Page } from "playwright-core";

export const GEMINI_ORIGIN = "https://gemini.google.com";
export const GEMINI_HOME_URL = `${GEMINI_ORIGIN}/app`;
export const GEMINI_CONVERSATION_ID_WAIT_TIMEOUT_MS = 15_000;

const GEMINI_RESERVED_IDS = new Set([
  "new",
  "download",
  "extensions",
  "gems",
  "settings",
  "mystuff",
  "saved-info",
  "updates",
  "faq",
]);
const GEMINI_CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;
const GEMINI_CONVERSATION_PATH_PATTERN = /^\/(?:u\/\d+\/)?app\/([^/]+)\/?$/i;

export function normalizeGeminiConversationId(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || GEMINI_RESERVED_IDS.has(trimmed.toLowerCase())) {
    return undefined;
  }
  return GEMINI_CONVERSATION_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function buildGeminiConversationUrl(conversationId: string): string {
  const normalized = normalizeGeminiConversationId(conversationId);
  if (!normalized) {
    throw new Error(
      `Gemini conversation id is invalid: ${String(conversationId)}`,
    );
  }
  return `${GEMINI_ORIGIN}/app/${normalized}`;
}

export function parseGeminiConversationId(rawUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.origin !== GEMINI_ORIGIN || url.username || url.password) {
    return undefined;
  }
  const match = GEMINI_CONVERSATION_PATH_PATTERN.exec(url.pathname);
  return normalizeGeminiConversationId(match?.[1]);
}

export function isGeminiAuthUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return (
    url.hostname === "accounts.google.com" ||
    url.hostname === "myaccount.google.com" ||
    url.hostname === "gds.google.com" ||
    url.hostname === "consent.google.com"
  );
}

export async function waitForGeminiConversationId(
  page: Page,
  timeoutMs = GEMINI_CONVERSATION_ID_WAIT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (signal?.aborted) return undefined;
    const conversationId = parseGeminiConversationId(page.url());
    if (conversationId) return conversationId;
    await new Promise((resolve) => setTimeout(resolve, 120));
  } while (Date.now() < deadline);
  return undefined;
}
