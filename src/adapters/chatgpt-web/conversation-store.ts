import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ChatGptConversationRecord {
  conversationId: string;
  createdAt: number;
  updatedAt: number;
}

export class ChatGptConversationStore {
  private filePath: string;
  private cache: Map<string, ChatGptConversationRecord> = new Map();
  private lastActiveConversationId: string | null = null;
  private loaded = false;

  constructor(filePath?: string) {
    this.filePath =
      filePath ||
      process.env.CHATGPT_CONVERSATIONS_FILE ||
      join(process.cwd(), "scratch", ".chatgpt", "chatgpt-conversations.json");
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
            if (typeof value === "string") {
              this.cache.set(key, {
                conversationId: value,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              });
              this.lastActiveConversationId = value;
            } else if (value && typeof value === "object" && "conversationId" in value) {
              const rec = value as ChatGptConversationRecord;
              this.cache.set(key, rec);
              this.lastActiveConversationId = rec.conversationId;
            }
          }
        }
      }
    } catch {
      // Bỏ qua lỗi đọc file, khởi tạo cache rỗng
      this.cache.clear();
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data: Record<string, ChatGptConversationRecord> = {};
      for (const [key, record] of this.cache.entries()) {
        data[key] = record;
      }
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error(`[ChatGPT ConversationStore] Không thể lưu file ${this.filePath}:`, err);
    }
  }

  public getConversationId(threadId: string | undefined): string | undefined {
    this.load();
    if (threadId) {
      const record = this.cache.get(threadId);
      return record?.conversationId;
    }
    return this.lastActiveConversationId || undefined;
  }

  public setConversationId(threadId: string | undefined, conversationId: string): void {
    if (!conversationId) return;
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

export const defaultChatGptConversationStore = new ChatGptConversationStore();
