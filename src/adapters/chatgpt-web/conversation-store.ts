import { join } from "node:path";
import type { CodexParsedRequest } from "../../types";
import {
  buildWebConversationKey,
  GenericConversationStore,
} from "../web/conversation";

/**
 * Tạo khóa định danh ổn định (conversationKey) từ threadId của Codex
 * Tương thích hoàn toàn với cơ chế của Launcher và M365 Copilot
 */
export function chatGptConversationKey(
  _parsed: CodexParsedRequest,
  rawConversationKey?: string,
): string | undefined {
  return buildWebConversationKey({
    provider: "chatgpt-web",
    source: rawConversationKey,
    modelId: "chatgpt-web",
  });
}

export const CHATGPT_HOME_URL = "https://chatgpt.com/";
export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
export const CHATGPT_CONVERSATION_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;

export function isValidChatGptConversationId(
  value: unknown,
): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return (
    CHATGPT_CONVERSATION_ID_PATTERN.test(trimmed) &&
    trimmed !== "local-chatgpt"
  );
}

export function normalizeChatGptConversationId(value: unknown): string | null {
  return isValidChatGptConversationId(value) ? value.trim() : null;
}

export function chatGptConversationUrl(conversationId: string): string {
  const normalized = normalizeChatGptConversationId(conversationId);
  if (!normalized) throw new Error("ChatGPT conversation id is invalid");
  return `https://chatgpt.com/c/${normalized}`;
}

export function parseChatGptConversationId(rawUrl: string): string | null {
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { return null; }
  if (!url.hostname.includes("chatgpt.com") || url.username || url.password) return null;
  const match = url.pathname.match(/^\/c\/([a-zA-Z0-9_-]+)\/?$/i);
  return normalizeChatGptConversationId(match?.[1]);
}

export function resolveChatGptTargetUrl(
  targetOrOptions?: string | {
    conversationKey?: string | null;
    useSavedChats?: boolean;
    store?: ChatGptConversationStore | null;
  } | null
): any {
  if (typeof targetOrOptions === "object" && targetOrOptions !== null) {
    const { conversationKey, useSavedChats = false, store } = targetOrOptions;
    if (!useSavedChats) {
      return {
        url: CHATGPT_TEMPORARY_CHAT_URL,
        isSavedChat: false,
        conversationId: null,
      };
    }
    const convId = conversationKey && store ? store.get(conversationKey)?.conversationId || null : null;
    if (convId) {
      return {
        url: chatGptConversationUrl(convId),
        isSavedChat: true,
        conversationId: convId,
      };
    }
    return {
      url: CHATGPT_HOME_URL,
      isSavedChat: true,
      conversationId: null,
    };
  }

  if (typeof targetOrOptions === "string") {
    const normalized = normalizeChatGptConversationId(targetOrOptions);
    if (normalized) return chatGptConversationUrl(normalized);
  }
  return CHATGPT_HOME_URL;
}

export interface ChatGptConversationRecord {
  conversationId: string;
  createdAt: number;
  updatedAt: number;
}

export class ChatGptConversationStore {
  private readonly store: GenericConversationStore<"conversationId">;

  constructor(filePath?: string) {
    const resolvedPath =
      filePath ||
      process.env.CHATGPT_CONVERSATIONS_FILE ||
      join(process.cwd(), "scratch", ".chatgpt", "chatgpt-conversations.json");
    this.store = new GenericConversationStore({
      filePath: resolvedPath,
      idField: "conversationId",
      isValidId: isValidChatGptConversationId,
      onSaveError: (err, fp) => {
        console.error(`[ChatGPT ConversationStore] Không thể lưu file ${fp}:`, err);
      },
    });
  }

  public get(conversationKey: string): { conversationId: string; lastUsedAt: number } | null {
    const record = this.store.getRecord(conversationKey);
    if (!record) return null;
    return {
      conversationId: record.conversationId,
      lastUsedAt: record.updatedAt || record.createdAt || Date.now(),
    };
  }

  public bind(conversationKey: string, conversationId: string): string {
    const normalized = normalizeChatGptConversationId(conversationId);
    if (!normalized) throw new Error("ChatGPT conversation id is invalid");
    this.setConversationId(conversationKey, normalized);
    return normalized;
  }

  public getConversationId(threadId: string | undefined): string | undefined {
    return this.store.getId(threadId);
  }

  public setConversationId(threadId: string | undefined, conversationId: string): void {
    this.store.setId(threadId, conversationId);
  }

  public deleteConversation(threadId: string | undefined): void {
    this.store.deleteKey(threadId);
  }

  public clearAll(): void {
    this.store.clearAll();
  }
}

export const defaultChatGptConversationStore = new ChatGptConversationStore();
