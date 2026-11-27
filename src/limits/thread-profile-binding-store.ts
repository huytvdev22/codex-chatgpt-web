import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";

const STORE_VERSION = 1;
const DEFAULT_MAX_BINDINGS = 512;
const PERSIST_DEBOUNCE_MS = 500;

export interface ThreadProfileBinding {
  providerId: string;
  profileId: string;
  modelSlug?: string;
  updatedAt: number;
}

export interface ThreadProfileBindingStoreOptions {
  filePath?: string;
  maxBindings?: number;
  debounceMs?: number;
}

function buildBindingKey(threadId: string, providerId: string): string {
  return `${threadId.trim()}::${providerId.trim().toLowerCase()}`;
}

/**
 * Lưu trữ bền vững ánh xạ `(threadId, providerId) -> profileId` theo cơ chế LRU
 * để sau khi failover sang profile mới, các lượt tiếp theo của cùng thread Codex
 * tiếp tục bám đúng tab và URL `/prompts/{id}` trên profile đó.
 */
export class ThreadProfileBindingStore {
  private readonly customFilePath?: string;
  private readonly maxBindings: number;
  private readonly debounceMs: number;
  private readonly bindings = new Map<string, ThreadProfileBinding>();
  private loadedFromPath: string | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPersistPath: string | null = null;

  constructor(options: ThreadProfileBindingStoreOptions = {}) {
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
    return (
      this.customFilePath || join(getConfigDir(), "thread-profile-bindings.json")
    );
  }

  private ensureLoaded(): void {
    const targetPath = this.resolveFilePath();
    if (this.loadedFromPath === targetPath) return;
    this.loadedFromPath = targetPath;
    this.bindings.clear();

    try {
      if (!existsSync(targetPath)) return;
      const decoded = JSON.parse(readFileSync(targetPath, "utf8")) as {
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

      for (const [key, rawEntry] of Object.entries(decoded.bindings)) {
        if (!key || !rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
          continue;
        }
        const entry = rawEntry as Record<string, unknown>;
        const providerId =
          typeof entry.providerId === "string"
            ? entry.providerId.trim().toLowerCase()
            : "";
        const profileId =
          typeof entry.profileId === "string"
            ? entry.profileId.trim().toLowerCase()
            : "";
        if (!providerId || !profileId) continue;
        const modelSlug =
          typeof entry.modelSlug === "string" && entry.modelSlug.trim()
            ? entry.modelSlug.trim().toLowerCase()
            : undefined;
        const updatedAt =
          typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
            ? entry.updatedAt
            : Date.now();
        this.bindings.set(key, {
          providerId,
          profileId,
          ...(modelSlug ? { modelSlug } : {}),
          updatedAt,
        });
      }
      this.evictOverflow();
    } catch {
      /* File hỏng hoặc không đọc được: khởi tạo rỗng an toàn */
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
      /* Best-effort persistence */
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

  public get(
    threadId?: string,
    providerId?: string,
  ): ThreadProfileBinding | undefined {
    const cleanThread = threadId?.trim();
    const cleanProvider = providerId?.trim().toLowerCase();
    if (!cleanThread || cleanThread === "default" || !cleanProvider) {
      return undefined;
    }
    this.ensureLoaded();
    const key = buildBindingKey(cleanThread, cleanProvider);
    const existing = this.bindings.get(key);
    if (!existing) return undefined;
    this.bindings.delete(key);
    this.bindings.set(key, existing);
    return { ...existing };
  }

  public bind(
    threadId: string | undefined,
    providerId: string,
    profileId: string,
    modelSlug?: string,
  ): void {
    const cleanThread = threadId?.trim();
    const cleanProvider = providerId.trim().toLowerCase();
    const cleanProfile = profileId.trim().toLowerCase();
    if (
      !cleanThread ||
      cleanThread === "default" ||
      !cleanProvider ||
      !cleanProfile
    ) {
      return;
    }
    this.ensureLoaded();
    const key = buildBindingKey(cleanThread, cleanProvider);
    const cleanModel = modelSlug?.trim().toLowerCase();
    const entry: ThreadProfileBinding = {
      providerId: cleanProvider,
      profileId: cleanProfile,
      ...(cleanModel ? { modelSlug: cleanModel } : {}),
      updatedAt: Date.now(),
    };
    this.bindings.delete(key);
    this.bindings.set(key, entry);
    this.evictOverflow();
    this.schedulePersist();
  }

  public delete(threadId?: string, providerId?: string): boolean {
    const cleanThread = threadId?.trim();
    const cleanProvider = providerId?.trim().toLowerCase();
    if (!cleanThread || cleanThread === "default" || !cleanProvider) {
      return false;
    }
    this.ensureLoaded();
    const removed = this.bindings.delete(
      buildBindingKey(cleanThread, cleanProvider),
    );
    if (removed) {
      this.schedulePersist();
    }
    return removed;
  }

  public flush(): void {
    if (this.persistTimer) {
      this.writeNow(this.pendingPersistPath ?? this.resolveFilePath());
    }
  }
}

export const threadProfileBindingStore = new ThreadProfileBindingStore();
