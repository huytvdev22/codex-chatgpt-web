import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CodexParsedRequest } from "../../types";
import { isValidQwenConversationId, extractConversationIdFromUrl } from "./selectors";

export const QWEN_HOME_URL = "https://chat.qwen.ai/";

export function qwenConversationUrl(conversationId: string): string {
  if (!isValidQwenConversationId(conversationId)) {
    throw new Error(`invalid Qwen conversation ID: ${conversationId}`);
  }
  return `https://chat.qwen.ai/c/${conversationId.toLowerCase()}`;
}

export function parseQwenConversationId(url: string): string | null {
  return extractConversationIdFromUrl(url);
}

export function resolveQwenTargetUrl(conversationId?: string): string {
  if (conversationId && isValidQwenConversationId(conversationId)) {
    return qwenConversationUrl(conversationId);
  }
  return QWEN_HOME_URL;
}

/**
 * Tạo khóa định danh ổn định (conversationKey) từ threadId của Codex cho Qwen Web
 */
export function qwenConversationKey(
  parsed: CodexParsedRequest,
  rawConversationKey?: string,
): string | undefined {
  const source = rawConversationKey?.trim();
  if (!source) return undefined;

  return createHash("sha256").update(JSON.stringify({
    provider: "qwen-web",
    source,
    modelId: "qwen-web",
  })).digest("hex");
}

export interface QwenConversationRecord {
  conversationId: string;
  createdAt: number;
  updatedAt: number;
}

export class QwenConversationStore {
  private filePath: string;
  private cache: Map<string, QwenConversationRecord> = new Map();
  private lastActiveConversationId: string | null = null;
  private loaded = false;

  constructor(filePath?: string) {
    this.filePath =
      filePath ||
      process.env.QWEN_CONVERSATIONS_FILE ||
      join(process.cwd(), "scratch", ".qwen", "qwen-conversations.json");
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw);
        if (data && typeof data === "object") {
          for (const [key, value] of Object.entries(data)) {
            let id: string | null = null;
            let rec: QwenConversationRecord | null = null;
            if (typeof value === "string") {
              id = value;
              rec = { conversationId: value, createdAt: Date.now(), updatedAt: Date.now() };
            } else if (value && typeof value === "object" && "conversationId" in value) {
              rec = value as QwenConversationRecord;
              id = rec.conversationId;
            }
            if (id && isValidQwenConversationId(id) && rec) {
              this.cache.set(key, rec);
              this.lastActiveConversationId = id;
            }
          }
        }
      }
    } catch {
      this.cache.clear();
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data: Record<string, QwenConversationRecord> = {};
      for (const [key, record] of this.cache.entries()) {
        if (isValidQwenConversationId(record.conversationId)) {
          data[key] = record;
        }
      }
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error(`[Qwen ConversationStore] Không thể lưu file ${this.filePath}:`, err);
    }
  }

  public getConversationId(threadId: string | undefined): string | undefined {
    this.load();
    if (!threadId) return undefined;
    const record = this.cache.get(threadId);
    return record && isValidQwenConversationId(record.conversationId) ? record.conversationId : undefined;
  }

  public setConversationId(threadId: string | undefined, conversationId: string): void {
    if (!isValidQwenConversationId(conversationId)) return;
    this.load();
    this.lastActiveConversationId = conversationId;
    if (threadId) {
      const now = Date.now();
      const existing = this.cache.get(threadId);
      this.cache.set(threadId, {
        conversationId,
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
      });
      this.save();
    }
  }

  public deleteConversation(threadId: string | undefined): void {
    if (!threadId) return;
    this.load();
    if (this.cache.delete(threadId)) {
      if (this.lastActiveConversationId === threadId) {
        this.lastActiveConversationId = null;
      }
      this.save();
    }
  }

  public clearAll(): void {
    this.load();
    this.cache.clear();
    this.lastActiveConversationId = null;
    this.save();
  }
}

export const defaultQwenConversationStore = new QwenConversationStore();
