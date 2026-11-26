import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";

const STORE_VERSION = 1;
const DEFAULT_MAX_BINDINGS = 512;
const PERSIST_DEBOUNCE_MS = 500;

export interface ThreadProviderBinding {
  providerId: string;
  modelId: string;
  reasoning?: string;
  lockedAt: number;
  updatedAt: number;
}

export interface ThreadProviderBindingStoreOptions {
  filePath?: string;
  maxBindings?: number;
  debounceMs?: number;
}

/**
 * Lưu trữ bền vững ánh xạ `threadId -> providerId` theo cơ chế LRU để khóa
 * mỗi cuộc trò chuyện Codex vào một provider duy nhất qua restart / `codex resume`.
 */
export class ThreadProviderBindingStore {
  private readonly customFilePath?: string;
  private readonly maxBindings: number;
  private readonly debounceMs: number;
  private readonly bindings = new Map<string, ThreadProviderBinding>();
  private loadedFromPath: string | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPersistPath: string | null = null;

  constructor(options: ThreadProviderBindingStoreOptions = {}) {
    this.customFilePath = options.filePath;
    this.maxBindings =
      typeof options.maxBindings === "number" &&
      Number.isInteger(options.maxBindings) &&
      options.maxBindings > 0
        ? options.maxBindings
        : DEFAULT_MAX_BINDINGS;
    this.debounceMs =
      typeof options.debounceMs === "number" &&
      Number.isFinite(options.debounceMs) &&
      options.debounceMs >= 0
        ? options.debounceMs
        : PERSIST_DEBOUNCE_MS;
  }

  private resolveFilePath(): string {
    return this.customFilePath || join(getConfigDir(), "thread-provider-bindings.json");
  }

  private ensureLoaded(): void {
    const targetPath = this.resolveFilePath();
    if (this.loadedFromPath === targetPath) return;
    this.loadedFromPath = targetPath;
    this.bindings.clear();

    try {
      if (!existsSync(targetPath)) return;
      const decoded = JSON.parse(readFileSync(targetPath, "utf-8")) as {
        version?: unknown;
        bindings?: unknown;
      };
      if (
        decoded?.version !== STORE_VERSION ||
        !decoded.bindings ||
        typeof decoded.bindings !== "object" ||
        Array.isArray(decoded.bindings)
      ) {
        return;
      }

      for (const [threadId, rawEntry] of Object.entries(decoded.bindings)) {
        const cleanThreadId = threadId.trim();
        if (!cleanThreadId || cleanThreadId === "default") continue;
        if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
        const entry = rawEntry as Record<string, unknown>;
        const providerId = typeof entry.providerId === "string" ? entry.providerId.trim() : "";
        const modelId = typeof entry.modelId === "string" ? entry.modelId.trim() : "";
        if (!providerId || !modelId) continue;
        const reasoning =
          typeof entry.reasoning === "string" && entry.reasoning.trim()
            ? entry.reasoning.trim()
            : undefined;
        const lockedAt =
          typeof entry.lockedAt === "number" && Number.isFinite(entry.lockedAt)
            ? entry.lockedAt
            : Date.now();
        const updatedAt =
          typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
            ? entry.updatedAt
            : lockedAt;
        this.bindings.set(cleanThreadId, {
          providerId,
          modelId,
          ...(reasoning ? { reasoning } : {}),
          lockedAt,
          updatedAt,
        });
      }
      this.evictOverflow();
    } catch {
      /* File hỏng hoặc không đọc được: bắt đầu rỗng, không làm gián đoạn request */
    }
  }

  private evictOverflow(): void {
    while (this.bindings.size > this.maxBindings) {
      const oldest = this.bindings.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.bindings.delete(oldest);
    }
  }

  private writeNow(targetPath: string): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.pendingPersistPath = null;
    try {
      const bindings = Object.fromEntries(this.bindings.entries());
      atomicWriteFile(
        targetPath,
        `${JSON.stringify({ version: STORE_VERSION, bindings }, null, 2)}\n`,
      );
    } catch {
      /* Best-effort persistence: lỗi đĩa không làm hỏng luồng responses */
    }
  }

  private schedulePersist(): void {
    const targetPath = this.resolveFilePath();
    if (this.debounceMs === 0) {
      this.writeNow(targetPath);
      return;
    }
    if (this.persistTimer) return;
    this.pendingPersistPath = targetPath;
    this.persistTimer = setTimeout(() => {
      this.writeNow(this.pendingPersistPath ?? targetPath);
    }, this.debounceMs);
    (this.persistTimer as { unref?: () => void }).unref?.();
  }

  public get(threadId?: string): ThreadProviderBinding | undefined {
    const cleanThreadId = threadId?.trim();
    if (!cleanThreadId || cleanThreadId === "default") return undefined;
    this.ensureLoaded();
    const existing = this.bindings.get(cleanThreadId);
    return existing ? { ...existing } : undefined;
  }

  public bind(
    threadId: string | undefined,
    input: {
      providerId: string;
      modelId: string;
      reasoning?: string;
    },
  ): ThreadProviderBinding | undefined {
    const cleanThreadId = threadId?.trim();
    const providerId = input.providerId.trim();
    const modelId = input.modelId.trim();
    if (!cleanThreadId || cleanThreadId === "default" || !providerId || !modelId) {
      return undefined;
    }
    this.ensureLoaded();
    const now = Date.now();
    const previous = this.bindings.get(cleanThreadId);
    const entry: ThreadProviderBinding = {
      providerId,
      modelId,
      ...(input.reasoning?.trim() ? { reasoning: input.reasoning.trim() } : {}),
      lockedAt: previous?.lockedAt ?? now,
      updatedAt: now,
    };
    this.bindings.delete(cleanThreadId);
    this.bindings.set(cleanThreadId, entry);
    this.evictOverflow();
    this.schedulePersist();
    return { ...entry };
  }

  public delete(threadId?: string): boolean {
    const cleanThreadId = threadId?.trim();
    if (!cleanThreadId || cleanThreadId === "default") return false;
    this.ensureLoaded();
    if (!this.bindings.delete(cleanThreadId)) return false;
    this.schedulePersist();
    return true;
  }

  public flush(): void {
    if (!this.persistTimer) return;
    this.writeNow(this.pendingPersistPath ?? this.resolveFilePath());
  }

  public get size(): number {
    this.ensureLoaded();
    return this.bindings.size;
  }
}

export const threadProviderBindingStore = new ThreadProviderBindingStore();
