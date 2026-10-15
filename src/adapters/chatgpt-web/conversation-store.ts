import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../../config";
import type { CodexParsedRequest } from "../../types";

export const CHATGPT_HOME_URL = "https://chatgpt.com/";
export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
export const CHATGPT_CONVERSATION_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;
export const MAX_PERSISTED_CHATGPT_BINDINGS = 256;
export const STORE_VERSION = 1;

export interface ChatGptConversationBinding {
  conversationId: string;
  lastUsedAt: number;
}

export function normalizeChatGptConversationId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return CHATGPT_CONVERSATION_ID_PATTERN.test(trimmed) ? trimmed : null;
}

export function parseChatGptConversationId(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (!url.hostname.includes("chatgpt.com")) return null;
    const match = url.pathname.match(/^\/c\/([a-zA-Z0-9_-]+)\/?$/);
    return match ? normalizeChatGptConversationId(match[1]) : null;
  } catch {
    return null;
  }
}

export function chatGptConversationUrl(conversationId: string): string {
  const normalized = normalizeChatGptConversationId(conversationId);
  if (!normalized) throw new Error("ChatGPT conversation id is invalid");
  return `https://chatgpt.com/c/${normalized}`;
}

/**
 * Sinh khóa định danh cuộc trò chuyện ổn định cho ChatGPT Web dựa trên thread id của Codex
 */
export function chatGptConversationKey(
  parsed: CodexParsedRequest,
  rawConversationKey?: string,
): string | undefined {
  const source = rawConversationKey?.trim();
  if (!source) return undefined;

  return createHash("sha256").update(JSON.stringify({
    provider: "chatgpt",
    source,
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
  })).digest("hex");
}

export class ChatGptConversationStore {
  private filePath: string;
  private bindings = new Map<string, ChatGptConversationBinding>();

  constructor(customPath?: string) {
    this.filePath = customPath || join(getConfigDir(), "runtime", "chatgpt-conversations.json");
    this.load();
  }

  load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const content = readFileSync(this.filePath, "utf8");
      const decoded = JSON.parse(content);
      if (decoded?.version !== STORE_VERSION || !decoded.bindings || typeof decoded.bindings !== "object") return;

      this.bindings.clear();
      for (const [key, binding] of Object.entries(decoded.bindings)) {
        const conversationId = normalizeChatGptConversationId((binding as any)?.conversationId);
        if (!/^[a-f0-9]{64}$/.test(key) || !conversationId) continue;
        this.bindings.set(key, {
          conversationId,
          lastUsedAt: Number.isFinite((binding as any).lastUsedAt) ? (binding as any).lastUsedAt : 0,
        });
      }
    } catch {
      // Bỏ qua lỗi đọc hỏng để không làm crash luồng chat
    }
  }

  write(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const bindingsObj = Object.fromEntries(this.bindings.entries());
      const tempPath = `${this.filePath}.${Date.now()}.tmp`;
      writeFileSync(tempPath, JSON.stringify({ version: STORE_VERSION, bindings: bindingsObj }, null, 2), "utf8");
      writeFileSync(this.filePath, JSON.stringify({ version: STORE_VERSION, bindings: bindingsObj }, null, 2), "utf8");
    } catch (err) {
      console.warn(`[chatgpt-conversation-store] Không thể ghi file bindings: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  get(conversationKey: string): ChatGptConversationBinding | null {
    const found = this.bindings.get(conversationKey);
    return found ? { ...found } : null;
  }

  bind(conversationKey: string, conversationId: string): string {
    if (!/^[a-f0-9]{64}$/.test(conversationKey)) {
      throw new Error("ChatGPT conversation key is invalid");
    }
    const normalized = normalizeChatGptConversationId(conversationId);
    if (!normalized) throw new Error("ChatGPT conversation id is invalid");

    this.bindings.set(conversationKey, { conversationId: normalized, lastUsedAt: Date.now() });

    // Giới hạn số lượng binding tối đa, loại bỏ binding cũ nhất
    while (this.bindings.size > MAX_PERSISTED_CHATGPT_BINDINGS) {
      const oldest = [...this.bindings.entries()]
        .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
      if (!oldest) break;
      this.bindings.delete(oldest[0]);
    }

    this.write();
    return normalized;
  }

  delete(conversationKey: string): void {
    if (this.bindings.delete(conversationKey)) {
      this.write();
    }
  }

  clear(): void {
    this.bindings.clear();
    this.write();
  }
}

export const defaultChatGptConversationStore = new ChatGptConversationStore();

/**
 * Quyết định URL điều hướng cho ChatGPT Web:
 * - Nếu không bật useSavedChats: luôn dùng temporary-chat=true
 * - Nếu bật useSavedChats: nếu có conversationId đã lưu thì vào /c/<id>, ngược lại vào trang chủ https://chatgpt.com/
 */
export function resolveChatGptTargetUrl(options: {
  conversationKey?: string;
  useSavedChats?: boolean;
  store?: ChatGptConversationStore;
}): { url: string; isSavedChat: boolean; conversationId: string | null } {
  const useSavedChats = options.useSavedChats === true;
  if (!useSavedChats) {
    return {
      url: CHATGPT_TEMPORARY_CHAT_URL,
      isSavedChat: false,
      conversationId: null,
    };
  }

  const store = options.store || defaultChatGptConversationStore;
  if (options.conversationKey) {
    const binding = store.get(options.conversationKey);
    if (binding?.conversationId) {
      return {
        url: chatGptConversationUrl(binding.conversationId),
        isSavedChat: true,
        conversationId: binding.conversationId,
      };
    }
  }

  return {
    url: CHATGPT_HOME_URL,
    isSavedChat: true,
    conversationId: null,
  };
}
