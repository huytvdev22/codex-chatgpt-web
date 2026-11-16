import type { Page } from "playwright-core";

export const M365_CHAT_URL = "https://m365.cloud.microsoft/chat";
export const M365_CONVERSATION_ORIGIN = "https://m365.cloud.microsoft";

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const CONVERSATION_ID_EXACT = new RegExp(`^${UUID_PATTERN}$`, "i");
const CONVERSATION_PATH = new RegExp(`^/chat/conversation/(${UUID_PATTERN})/?$`, "i");

export function normalizeM365ConversationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return CONVERSATION_ID_EXACT.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

export function buildM365ConversationUrl(conversationId: string): string {
  const normalized = normalizeM365ConversationId(conversationId);
  if (!normalized) {
    throw new Error(`M365 conversation id is invalid: ${String(conversationId)}`);
  }
  return `${M365_CONVERSATION_ORIGIN}/chat/conversation/${normalized}`;
}

export function parseM365ConversationId(rawUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.origin !== M365_CONVERSATION_ORIGIN || url.username || url.password) return undefined;
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
