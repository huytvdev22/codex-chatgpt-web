import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface BaseConversationRecord {
  createdAt: number;
  updatedAt: number;
}

export interface GenericConversationStoreOptions<
  TIdField extends string = "conversationId",
> {
  filePath: string;
  idField?: TIdField;
  isValidId?: (id: string) => boolean;
  onSaveError?: (err: unknown, filePath: string) => void;
}

export type StoredConversationRecord<
  TIdField extends string = "conversationId",
> = BaseConversationRecord & {
  [K in TIdField]: string;
};

/**
 * Hạ tầng lưu trữ ánh xạ threadId/conversationKey <-> provider conversation ID
 * dùng chung cho các Web Adapter, đồng thời bảo toàn schema JSON và bộ kiểm tra ID riêng của từng provider.
 */
export class GenericConversationStore<
  TIdField extends string = "conversationId",
> {
  private readonly filePath: string;
  private readonly idField: TIdField;
  private readonly isValidId: (id: string) => boolean;
  private readonly onSaveError?: (err: unknown, filePath: string) => void;
  private readonly cache = new Map<string, StoredConversationRecord<TIdField>>();
  private lastActiveId: string | null = null;
  private loaded = false;

  constructor(options: GenericConversationStoreOptions<TIdField>) {
    this.filePath = options.filePath;
    this.idField = (options.idField ?? "conversationId") as TIdField;
    this.isValidId = options.isValidId ?? (id => Boolean(id && id.trim()));
    this.onSaveError = options.onSaveError;
  }

  private createRecord(
    id: string,
    createdAt: number,
    updatedAt: number,
  ): StoredConversationRecord<TIdField> {
    return {
      [this.idField]: id,
      createdAt,
      updatedAt,
    } as StoredConversationRecord<TIdField>;
  }

  private extractRecordId(record: StoredConversationRecord<TIdField>): string {
    return record[this.idField];
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
            let rec: StoredConversationRecord<TIdField> | null = null;
            if (typeof value === "string") {
              id = value;
              const now = Date.now();
              rec = this.createRecord(value, now, now);
            } else if (
              value &&
              typeof value === "object" &&
              this.idField in value
            ) {
              rec = value as StoredConversationRecord<TIdField>;
              const candidate = (value as Record<string, unknown>)[this.idField];
              id = typeof candidate === "string" ? candidate : null;
            }
            if (id && this.isValidId(id) && rec) {
              this.cache.set(key, rec);
              this.lastActiveId = id;
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
      const data: Record<string, StoredConversationRecord<TIdField>> = {};
      for (const [key, record] of this.cache.entries()) {
        const id = this.extractRecordId(record);
        if (this.isValidId(id)) {
          data[key] = record;
        }
      }
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      this.onSaveError?.(err, this.filePath);
    }
  }

  public getRecord(
    key: string | undefined,
  ): StoredConversationRecord<TIdField> | undefined {
    this.load();
    if (!key) return undefined;
    const record = this.cache.get(key);
    if (!record) return undefined;
    const id = this.extractRecordId(record);
    return this.isValidId(id) ? record : undefined;
  }

  public getId(key: string | undefined): string | undefined {
    const record = this.getRecord(key);
    return record ? this.extractRecordId(record) : undefined;
  }

  public setId(key: string | undefined, id: string): void {
    if (!this.isValidId(id)) return;
    this.load();
    this.lastActiveId = id;
    if (key) {
      const now = Date.now();
      const existing = this.cache.get(key);
      this.cache.set(
        key,
        this.createRecord(id, existing ? existing.createdAt : now, now),
      );
      this.save();
    }
  }

  public deleteKey(key: string | undefined): boolean {
    if (!key) return false;
    this.load();
    const deleted = this.cache.delete(key);
    if (deleted) {
      if (this.lastActiveId === key) {
        this.lastActiveId = null;
      }
      this.save();
    }
    return deleted;
  }

  public clearAll(): void {
    this.load();
    this.cache.clear();
    this.lastActiveId = null;
    this.save();
  }
}
