import type { Page } from "playwright-core";

export const CHATGPT_ORIGIN = "https://chatgpt.com";
export const CHATGPT_HOME_URL = `${CHATGPT_ORIGIN}/`;
export const CHATGPT_CONVERSATION_ID_WAIT_TIMEOUT_MS = 15_000;

const CHATGPT_RESERVED_IDS = new Set([
  "new",
  "auth",
  "login",
  "c",
  "g",
  "share",
  "backend-api",
]);
const CHATGPT_CONVERSATION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{7,128}$/i;
const CHATGPT_CONVERSATION_PATH_PATTERN = /^\/(?:g\/[^/]+\/)?c\/([^/]+)\/?$/i;

export function normalizeChatGptConversationId(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || CHATGPT_RESERVED_IDS.has(trimmed.toLowerCase())) {
    return undefined;
  }
  return CHATGPT_CONVERSATION_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function buildChatGptConversationUrl(conversationId: string): string {
  const normalized = normalizeChatGptConversationId(conversationId);
  if (!normalized) {
    throw new Error(`ChatGPT conversation id is invalid: ${String(conversationId)}`);
  }
  return `${CHATGPT_ORIGIN}/c/${normalized}`;
}

export function parseChatGptConversationId(
  rawUrl: string,
): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.origin !== CHATGPT_ORIGIN || url.username || url.password) {
    return undefined;
  }
  const match = CHATGPT_CONVERSATION_PATH_PATTERN.exec(url.pathname);
  return normalizeChatGptConversationId(match?.[1]);
}

export function isChatGptAuthUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.hostname === "auth.openai.com" || url.hostname === "auth0.openai.com") {
    return true;
  }
  return url.origin === CHATGPT_ORIGIN && /^\/auth(?:\/|$)/i.test(url.pathname);
}

export async function waitForChatGptConversationId(
  page: Page,
  timeoutMs = CHATGPT_CONVERSATION_ID_WAIT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (signal?.aborted) return undefined;
    const conversationId = parseChatGptConversationId(page.url());
    if (conversationId) return conversationId;
    await new Promise((resolve) => setTimeout(resolve, 120));
  } while (Date.now() < deadline);
  return undefined;
}
