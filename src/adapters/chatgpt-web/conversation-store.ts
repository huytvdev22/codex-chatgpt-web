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
            } else if (value && typeof value === "object" && "conversationId" in value) {
              this.cache.set(key, value as ChatGptConversationRecord);
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
    if (!threadId) return undefined;
    this.load();
    const record = this.cache.get(threadId);
    return record?.conversationId;
  }

  public setConversationId(threadId: string | undefined, conversationId: string): void {
    if (!threadId || !conversationId) return;
    this.load();
    const now = Date.now();
    const existing = this.cache.get(threadId);
    this.cache.set(threadId, {
      conversationId,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    });
    this.save();
  }

  public deleteConversation(threadId: string | undefined): void {
    if (!threadId) return;
    this.load();
    if (this.cache.delete(threadId)) {
      this.save();
    }
  }

  public clearAll(): void {
    this.load();
    this.cache.clear();
    this.save();
  }
}

export const defaultChatGptConversationStore = new ChatGptConversationStore();
