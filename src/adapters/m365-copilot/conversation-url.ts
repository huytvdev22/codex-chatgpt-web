import type { Page } from "playwright-core";

export const M365_CHAT_URL = "https://m365.cloud.microsoft/chat";
export const M365_CONVERSATION_ORIGIN = "https://m365.cloud.microsoft";
export const COPILOT_CONVERSATION_ORIGIN = "https://copilot.cloud.microsoft";

const M365_ALLOWED_ORIGINS = new Set([
  M365_CONVERSATION_ORIGIN,
  COPILOT_CONVERSATION_ORIGIN,
]);

const M365_LOGIN_HOSTS = new Set([
  "login.microsoftonline.com",
  "login.live.com",
  "account.activedirectory.windowsazure.com",
]);

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const CONVERSATION_ID_EXACT = new RegExp(`^${UUID_PATTERN}$`, "i");
const CONVERSATION_PATH = new RegExp(`^/chat/conversation/(${UUID_PATTERN})/?$`, "i");

export function normalizeM365ConversationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return CONVERSATION_ID_EXACT.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

export function resolveM365Origin(rawUrl?: string): string {
  if (!rawUrl) return M365_CONVERSATION_ORIGIN;
  try {
    const url = new URL(rawUrl);
    if (!url.username && !url.password && M365_ALLOWED_ORIGINS.has(url.origin)) {
      return url.origin;
    }
  } catch {
    // fallback về origin mặc định khi URL chưa hợp lệ
  }
  return M365_CONVERSATION_ORIGIN;
}

export function isM365ChatHomeUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!M365_ALLOWED_ORIGINS.has(url.origin) || url.username || url.password) {
    return false;
  }
  return /^\/chat\/?$/i.test(url.pathname);
}

export function isM365LoginUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (M365_LOGIN_HOSTS.has(url.hostname)) return true;
  return M365_ALLOWED_ORIGINS.has(url.origin) && /^\/login(?:\/|$)/i.test(url.pathname);
}

export function buildM365ConversationUrl(
  conversationId: string,
  origin: string = M365_CONVERSATION_ORIGIN,
): string {
  const normalized = normalizeM365ConversationId(conversationId);
  if (!normalized) {
    throw new Error(`M365 conversation id is invalid: ${String(conversationId)}`);
  }
  const resolvedOrigin = M365_ALLOWED_ORIGINS.has(origin)
    ? origin
    : M365_CONVERSATION_ORIGIN;
  return `${resolvedOrigin}/chat/conversation/${normalized}`;
}

export function parseM365ConversationId(rawUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (!M365_ALLOWED_ORIGINS.has(url.origin) || url.username || url.password) return undefined;
  return CONVERSATION_PATH.exec(url.pathname)?.[1]?.toLowerCase();
}

export async function waitForM365ConversationId(
  page: Page,
  timeoutMs = 10_000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const conversationId = parseM365ConversationId(page.url());
    if (conversationId) return conversationId;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return undefined;
}
