import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";

export interface V2ConversationRecord {
  provider: string;
  conversationKey: string;
  conversationId?: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

interface PersistedV2ConversationMap {
  version: 1;
  records: Record<string, V2ConversationRecord>;
}

/**
 * Kho lưu trữ bền vững ánh xạ `provider + conversationKey -> conversationId`
 * cho `POST /v2/responses`, giúp mở lại đúng cuộc hội thoại đích sau khi tab bị đóng
 * hoặc Launcher khởi động lại.
 */
export class V2ConversationStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(getConfigDir(), "v2-conversations.json");
  }

  private compositeKey(provider: string, conversationKey: string): string {
    return `${provider}:${conversationKey}`;
  }

  private readAll(): Record<string, V2ConversationRecord> {
    if (!existsSync(this.filePath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<PersistedV2ConversationMap>;
      if (!parsed || typeof parsed !== "object" || !parsed.records || typeof parsed.records !== "object") {
        return {};
      }
      return parsed.records;
    } catch {
      return {};
    }
  }

  private writeAll(records: Record<string, V2ConversationRecord>): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const payload: PersistedV2ConversationMap = {
      version: 1,
      records,
    };
    atomicWriteFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  }

  /**
   * Tra cứu bản ghi hội thoại theo `provider` và `conversationKey`.
   */
  public get(provider: string, conversationKey: string): V2ConversationRecord | undefined {
    const records = this.readAll();
    return records[this.compositeKey(provider, conversationKey)];
  }

  /**
   * Tìm bản ghi đã lưu theo `provider` và `conversationId` thực tế của Web UI.
   */
  public findByConversationId(provider: string, conversationId: string): V2ConversationRecord | undefined {
    const records = this.readAll();
    const target = conversationId.trim();
    for (const record of Object.values(records)) {
      if (record.provider === provider && record.conversationId === target) {
        return record;
      }
    }
    return undefined;
  }

  /**
   * Lưu hoặc cập nhật ánh xạ `conversationKey -> conversationId` xuống đĩa.
   */
  public upsert(input: {
    provider: string;
    conversationKey: string;
    conversationId?: string;
    model: string;
  }): V2ConversationRecord {
    const records = this.readAll();
    const mapKey = this.compositeKey(input.provider, input.conversationKey);
    const existing = records[mapKey];
    const now = new Date().toISOString();
    const next: V2ConversationRecord = {
      provider: input.provider,
      conversationKey: input.conversationKey,
      ...(input.conversationId || existing?.conversationId
        ? { conversationId: input.conversationId || existing?.conversationId }
        : {}),
      model: input.model,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    records[mapKey] = next;
    this.writeAll(records);
    return next;
  }
}
