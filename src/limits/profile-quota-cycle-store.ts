import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import { buildProfileCooldownKey } from "./profile-cooldown-store";

const QUOTA_CYCLES_FILE_NAME = "profile-quota-cycles.json";

/**
 * Cửa sổ mặc định 24 giờ cho các chu kỳ chưa từng ghi nhận mốc reset từ lỗi limit.
 */
export const DEFAULT_QUOTA_CYCLE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ProfileQuotaCycleEntry {
  providerId: string;
  profileId: string;
  modelSlug: string;
  cycleStartedAt: string;
  cycleStartedAtMs: number;
  tokensUsed: number;
  turnsUsed: number;
  lastUsedAt: string;
  lastResetAt: string | null;
  pendingResetAtMs: number | null;
}

export interface ProfileQuotaCycleSummary {
  providerId: string;
  profileId: string;
  modelSlug: string;
  tokensUsed: number;
  turnsUsed: number;
  cycleStartedAt: string;
  lastResetAt: string | null;
}

interface ProfileQuotaCycleFile {
  version: 1;
  updatedAt: string | null;
  entries: Record<string, ProfileQuotaCycleEntry>;
}

interface CachedQuotaCycleFile {
  filePath: string;
  mtimeMs: number;
  size: number;
  data: ProfileQuotaCycleFile;
}

function createEmptyFile(): ProfileQuotaCycleFile {
  return {
    version: 1,
    updatedAt: null,
    entries: {},
  };
}

function sanitizeCycleEntry(raw: unknown): ProfileQuotaCycleEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const providerId =
    typeof obj.providerId === "string" ? obj.providerId.trim().toLowerCase() : "";
  const profileId =
    typeof obj.profileId === "string" && obj.profileId.trim()
      ? obj.profileId.trim().toLowerCase()
      : "default";
  const modelSlug =
    typeof obj.modelSlug === "string" && obj.modelSlug.trim()
      ? obj.modelSlug.trim().toLowerCase()
      : "default";
  const cycleStartedAtMs =
    typeof obj.cycleStartedAtMs === "number" && Number.isFinite(obj.cycleStartedAtMs)
      ? obj.cycleStartedAtMs
      : typeof obj.cycleStartedAt === "string" && Number.isFinite(Date.parse(obj.cycleStartedAt))
        ? Date.parse(obj.cycleStartedAt)
        : NaN;
  if (!providerId || !Number.isFinite(cycleStartedAtMs)) return null;

  const tokensUsed =
    typeof obj.tokensUsed === "number" && Number.isFinite(obj.tokensUsed)
      ? Math.max(0, Math.round(obj.tokensUsed))
      : 0;
  const turnsUsed =
    typeof obj.turnsUsed === "number" && Number.isFinite(obj.turnsUsed)
      ? Math.max(0, Math.round(obj.turnsUsed))
      : 0;
  const cycleStartedAt = new Date(cycleStartedAtMs).toISOString();
  const lastUsedAt =
    typeof obj.lastUsedAt === "string" && Number.isFinite(Date.parse(obj.lastUsedAt))
      ? obj.lastUsedAt
      : cycleStartedAt;
  const lastResetAt =
    typeof obj.lastResetAt === "string" && Number.isFinite(Date.parse(obj.lastResetAt))
      ? obj.lastResetAt
      : null;
  const pendingResetAtMs =
    typeof obj.pendingResetAtMs === "number" && Number.isFinite(obj.pendingResetAtMs)
      ? obj.pendingResetAtMs
      : null;

  return {
    providerId,
    profileId,
    modelSlug,
    cycleStartedAt,
    cycleStartedAtMs,
    tokensUsed,
    turnsUsed,
    lastUsedAt,
    lastResetAt,
    pendingResetAtMs,
  };
}

function sanitizeCycleFile(raw: unknown): ProfileQuotaCycleFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return createEmptyFile();
  }
  const obj = raw as Record<string, unknown>;
  const updatedAt =
    typeof obj.updatedAt === "string" && Number.isFinite(Date.parse(obj.updatedAt))
      ? obj.updatedAt
      : null;
  const entries: Record<string, ProfileQuotaCycleEntry> = {};
  if (obj.entries && typeof obj.entries === "object" && !Array.isArray(obj.entries)) {
    for (const rawEntry of Object.values(obj.entries)) {
      const sanitized = sanitizeCycleEntry(rawEntry);
      if (!sanitized) continue;
      entries[
        buildProfileCooldownKey(
          sanitized.providerId,
          sanitized.profileId,
          sanitized.modelSlug,
        )
      ] = sanitized;
    }
  }
  return {
    version: 1,
    updatedAt,
    entries,
  };
}

/**
 * Chuẩn hóa entry theo mốc thời gian hiện tại:
 * - Nếu đã đi qua `pendingResetAtMs` (mốc mở lại sau khi bị limit) -> bắt đầu chu kỳ mới từ `pendingResetAtMs` với 0 token.
 * - Nếu chưa từng gặp limit nhưng đã quá `cycleWindowMs` (mặc định 24h) -> tự xoay chu kỳ mới về 0 token.
 */
function normalizeEntryForTime(
  entry: ProfileQuotaCycleEntry,
  nowMs: number,
  cycleWindowMs: number,
): { entry: ProfileQuotaCycleEntry; resetOccurred: boolean } {
  if (
    entry.pendingResetAtMs !== null &&
    nowMs >= entry.pendingResetAtMs &&
    entry.cycleStartedAtMs < entry.pendingResetAtMs
  ) {
    const resetIso = new Date(entry.pendingResetAtMs).toISOString();
    return {
      resetOccurred: true,
      entry: {
        ...entry,
        cycleStartedAt: resetIso,
        cycleStartedAtMs: entry.pendingResetAtMs,
        tokensUsed: 0,
        turnsUsed: 0,
        lastResetAt: resetIso,
        pendingResetAtMs: null,
      },
    };
  }

  if (
    entry.pendingResetAtMs === null &&
    nowMs - entry.cycleStartedAtMs >= cycleWindowMs
  ) {
    const windowIso = new Date(nowMs).toISOString();
    return {
      resetOccurred: true,
      entry: {
        ...entry,
        cycleStartedAt: windowIso,
        cycleStartedAtMs: nowMs,
        tokensUsed: 0,
        turnsUsed: 0,
        lastResetAt: entry.lastResetAt,
        pendingResetAtMs: null,
      },
    };
  }

  return { entry, resetOccurred: false };
}

/**
 * Kho lưu trữ tổng token và số lượt đã chạy trong chu kỳ quota hiện tại
 * theo khóa `(providerId, profileId, modelSlug)` tại `<configDir>/profile-quota-cycles.json`.
 */
export class ProfileQuotaCycleStore {
  private static readonly defaultInstance = new ProfileQuotaCycleStore();
  private cache: CachedQuotaCycleFile | null = null;

  constructor(
    private readonly customFilePath?: string,
    private readonly cycleWindowMs: number = DEFAULT_QUOTA_CYCLE_WINDOW_MS,
  ) {}

  public static getInstance(): ProfileQuotaCycleStore {
    return ProfileQuotaCycleStore.defaultInstance;
  }

  public resolveFilePath(): string {
    return this.customFilePath ?? join(getConfigDir(), QUOTA_CYCLES_FILE_NAME);
  }

  private shouldSkipImplicitTestWrite(): boolean {
    if (this.customFilePath) return false;
    if (process.env.CODEX_CHATGPT_WEB_HOME?.trim()) return false;
    return (
      process.env.NODE_ENV === "test" ||
      process.argv.some(
        (arg) => arg === "test" || /\.test\.[cm]?[jt]sx?$/i.test(arg),
      )
    );
  }

  public readFile(): ProfileQuotaCycleFile {
    const filePath = this.resolveFilePath();
    if (!existsSync(filePath)) {
      this.cache = null;
      return createEmptyFile();
    }
    try {
      const stats = statSync(filePath);
      if (
        this.cache &&
        this.cache.filePath === filePath &&
        this.cache.mtimeMs === stats.mtimeMs &&
        this.cache.size === stats.size
      ) {
        return this.cache.data;
      }
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      const data = sanitizeCycleFile(parsed);
      this.cache = {
        filePath,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        data,
      };
      return data;
    } catch {
      this.cache = null;
      return createEmptyFile();
    }
  }

  private writeFile(data: ProfileQuotaCycleFile): ProfileQuotaCycleFile {
    const filePath = this.resolveFilePath();
    const sanitized = sanitizeCycleFile(data);
    atomicWriteFile(filePath, `${JSON.stringify(sanitized, null, 2)}\n`);
    try {
      const stats = statSync(filePath);
      this.cache = {
        filePath,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        data: sanitized,
      };
    } catch {
      this.cache = null;
    }
    return sanitized;
  }

  public getTokensUsedInCurrentCycle(
    providerId: string,
    profileId: string,
    modelSlug: string,
    nowMs = Date.now(),
  ): number {
    if (this.shouldSkipImplicitTestWrite()) {
      return 0;
    }
    const key = buildProfileCooldownKey(providerId, profileId, modelSlug);
    const entry = this.readFile().entries[key];
    if (!entry) return 0;
    return normalizeEntryForTime(entry, nowMs, this.cycleWindowMs).entry.tokensUsed;
  }

  public recordTurnUsage(options: {
    providerId: string;
    profileId: string;
    modelSlug: string;
    tokensUsed: number;
    nowMs?: number;
  }): ProfileQuotaCycleEntry | null {
    if (this.shouldSkipImplicitTestWrite()) {
      return null;
    }
    const nowMs = options.nowMs ?? Date.now();
    const providerId = options.providerId.trim().toLowerCase();
    const profileId = options.profileId.trim().toLowerCase() || "default";
    const modelSlug = options.modelSlug.trim().toLowerCase() || "default";
    if (!providerId) return null;

    const deltaTokens = Number.isFinite(options.tokensUsed)
      ? Math.max(0, Math.round(options.tokensUsed))
      : 0;
    const key = buildProfileCooldownKey(providerId, profileId, modelSlug);
    const file = this.readFile();
    const existing = file.entries[key];
    const nowIso = new Date(nowMs).toISOString();

    const baseEntry: ProfileQuotaCycleEntry = existing
      ? normalizeEntryForTime(existing, nowMs, this.cycleWindowMs).entry
      : {
          providerId,
          profileId,
          modelSlug,
          cycleStartedAt: nowIso,
          cycleStartedAtMs: nowMs,
          tokensUsed: 0,
          turnsUsed: 0,
          lastUsedAt: nowIso,
          lastResetAt: null,
          pendingResetAtMs: null,
        };

    const nextEntry: ProfileQuotaCycleEntry = {
      ...baseEntry,
      tokensUsed: baseEntry.tokensUsed + deltaTokens,
      turnsUsed: baseEntry.turnsUsed + 1,
      lastUsedAt: nowIso,
    };

    this.writeFile({
      version: 1,
      updatedAt: nowIso,
      entries: {
        ...file.entries,
        [key]: nextEntry,
      },
    });
    return nextEntry;
  }

  public markExhaustedWindow(options: {
    providerId: string;
    profileId: string;
    modelSlug: string;
    resetAtMs: number;
    nowMs?: number;
  }): ProfileQuotaCycleEntry | null {
    if (this.shouldSkipImplicitTestWrite()) {
      return null;
    }
    const nowMs = options.nowMs ?? Date.now();
    const providerId = options.providerId.trim().toLowerCase();
    const profileId = options.profileId.trim().toLowerCase() || "default";
    const modelSlug = options.modelSlug.trim().toLowerCase() || "default";
    if (!providerId || !Number.isFinite(options.resetAtMs)) return null;

    const key = buildProfileCooldownKey(providerId, profileId, modelSlug);
    const file = this.readFile();
    const existing = file.entries[key];
    const nowIso = new Date(nowMs).toISOString();

    const baseEntry: ProfileQuotaCycleEntry = existing
      ? normalizeEntryForTime(existing, nowMs, this.cycleWindowMs).entry
      : {
          providerId,
          profileId,
          modelSlug,
          cycleStartedAt: nowIso,
          cycleStartedAtMs: nowMs,
          tokensUsed: 0,
          turnsUsed: 0,
          lastUsedAt: nowIso,
          lastResetAt: null,
          pendingResetAtMs: null,
        };

    const nextEntry: ProfileQuotaCycleEntry = {
      ...baseEntry,
      pendingResetAtMs: Math.max(nowMs + 1_000, options.resetAtMs),
    };

    this.writeFile({
      version: 1,
      updatedAt: nowIso,
      entries: {
        ...file.entries,
        [key]: nextEntry,
      },
    });
    return nextEntry;
  }

  public listUsageForProfile(
    providerId: string,
    profileId: string,
    nowMs = Date.now(),
  ): ProfileQuotaCycleSummary[] {
    if (this.shouldSkipImplicitTestWrite()) {
      return [];
    }
    const cleanProvider = providerId.trim().toLowerCase();
    const cleanProfile = profileId.trim().toLowerCase() || "default";
    if (!cleanProvider) return [];

    const results: ProfileQuotaCycleSummary[] = [];
    for (const rawEntry of Object.values(this.readFile().entries)) {
      if (rawEntry.providerId !== cleanProvider || rawEntry.profileId !== cleanProfile) {
        continue;
      }
      const { entry } = normalizeEntryForTime(rawEntry, nowMs, this.cycleWindowMs);
      if (entry.tokensUsed <= 0 && entry.turnsUsed <= 0) continue;
      results.push({
        providerId: entry.providerId,
        profileId: entry.profileId,
        modelSlug: entry.modelSlug,
        tokensUsed: entry.tokensUsed,
        turnsUsed: entry.turnsUsed,
        cycleStartedAt: entry.cycleStartedAt,
        lastResetAt: entry.lastResetAt,
      });
    }

    results.sort((a, b) => b.tokensUsed - a.tokensUsed || b.turnsUsed - a.turnsUsed);
    return results;
  }
}

export const profileQuotaCycleStore = ProfileQuotaCycleStore.getInstance();
