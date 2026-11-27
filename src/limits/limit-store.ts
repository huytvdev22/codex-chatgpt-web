import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import {
  buildLimitEntryKey,
  computeLimitBucketSeverity,
  DEFAULT_LIMIT_WARNING_THRESHOLD_PERCENT,
  type LimitBucketSeverity,
  type LimitSourceKind,
  type LimitStatusKind,
  type LimitStoreFile,
  type ProviderLimitBucket,
  type ProviderLimitCheckResult,
  type StoredProfileLimitRecord,
} from "./types";

const LIMITS_FILE_NAME = "provider-limits.json";
const MAX_TEXT_LENGTH = 500;

interface CachedLimitFile {
  filePath: string;
  mtimeMs: number;
  size: number;
  data: LimitStoreFile;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function createEmptyLimitStoreFile(): LimitStoreFile {
  return {
    version: 1,
    updatedAt: null,
    entries: {},
  };
}

function sanitizeOptionalString(value: unknown, maxLen = MAX_TEXT_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

function sanitizeSourceKind(value: unknown): LimitSourceKind | null {
  if (value === "network-json" || value === "dom" || value === "dom-fallback") {
    return value;
  }
  return null;
}

function sanitizeStoredStatus(
  value: unknown,
): StoredProfileLimitRecord["status"] | null {
  if (
    value === "ok" ||
    value === "warning" ||
    value === "exhausted" ||
    value === "signed_out" ||
    value === "challenge" ||
    value === "error"
  ) {
    return value;
  }
  return null;
}

function sanitizeSeverity(
  value: unknown,
  percentUsed: number | null,
): LimitBucketSeverity {
  if (
    value === "ok" ||
    value === "warning" ||
    value === "exhausted" ||
    value === "info"
  ) {
    return value;
  }
  return computeLimitBucketSeverity(percentUsed, DEFAULT_LIMIT_WARNING_THRESHOLD_PERCENT);
}

function sanitizeBucket(raw: unknown): ProviderLimitBucket | null {
  if (!isPlainObject(raw)) return null;
  const id = sanitizeOptionalString(raw.id, 80);
  const label = sanitizeOptionalString(raw.label, 140);
  if (!id || !label) return null;
  const percentUsed =
    typeof raw.percentUsed === "number" && Number.isFinite(raw.percentUsed)
      ? Math.max(0, Math.min(100, Math.round(raw.percentUsed)))
      : null;
  const usedText = sanitizeOptionalString(raw.usedText, 120) ?? undefined;
  const remainingText = sanitizeOptionalString(raw.remainingText, 120) ?? undefined;
  const resetAt =
    typeof raw.resetAt === "string" && Number.isFinite(Date.parse(raw.resetAt))
      ? raw.resetAt
      : null;
  const resetText = sanitizeOptionalString(raw.resetText, 160);
  return {
    id,
    label,
    percentUsed,
    ...(usedText ? { usedText } : {}),
    ...(remainingText ? { remainingText } : {}),
    ...(resetAt !== null ? { resetAt } : {}),
    ...(resetText !== null ? { resetText } : {}),
    severity: sanitizeSeverity(raw.severity, percentUsed),
  };
}

function sanitizeStoredRecord(
  raw: unknown,
): StoredProfileLimitRecord | null {
  if (!isPlainObject(raw)) return null;
  const providerId = sanitizeOptionalString(raw.providerId, 60);
  const profileId = sanitizeOptionalString(raw.profileId, 40) ?? "default";
  const status = sanitizeStoredStatus(raw.status);
  if (!providerId || !status) return null;
  const buckets = Array.isArray(raw.buckets)
    ? raw.buckets
        .map(sanitizeBucket)
        .filter((item): item is ProviderLimitBucket => item !== null)
    : [];
  const checkedAt =
    typeof raw.checkedAt === "string" && Number.isFinite(Date.parse(raw.checkedAt))
      ? raw.checkedAt
      : null;
  const profileName = sanitizeOptionalString(raw.profileName, 80) ?? undefined;

  return {
    providerId,
    profileId,
    ...(profileName ? { profileName } : {}),
    status,
    planName: sanitizeOptionalString(raw.planName, 120),
    sourceUrl: sanitizeOptionalString(raw.sourceUrl, 300),
    sourceKind: sanitizeSourceKind(raw.sourceKind),
    scopeNote: sanitizeOptionalString(raw.scopeNote, 300),
    providerUpdatedText: sanitizeOptionalString(raw.providerUpdatedText, 160),
    buckets,
    rawSummary: sanitizeOptionalString(raw.rawSummary, 800),
    checkedAt,
    lastError: sanitizeOptionalString(raw.lastError, 500),
  };
}

export function sanitizeLimitStoreFile(raw: unknown): LimitStoreFile {
  if (!isPlainObject(raw)) return createEmptyLimitStoreFile();
  const updatedAt =
    typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt))
      ? raw.updatedAt
      : null;
  const entries: Record<string, StoredProfileLimitRecord> = {};
  if (isPlainObject(raw.entries)) {
    for (const value of Object.values(raw.entries)) {
      const sanitized = sanitizeStoredRecord(value);
      if (!sanitized) continue;
      const key = buildLimitEntryKey(sanitized.providerId, sanitized.profileId);
      entries[key] = sanitized;
    }
  }
  return {
    version: 1,
    updatedAt,
    entries,
  };
}

/**
 * Kho lưu trữ cache hạn mức tài khoản theo cặp `(providerId, profileId)` tại `<configDir>/provider-limits.json`.
 */
export class LimitStore {
  private static readonly defaultInstance = new LimitStore();
  private cache: CachedLimitFile | null = null;

  constructor(private readonly customFilePath?: string) {}

  public static getInstance(): LimitStore {
    return LimitStore.defaultInstance;
  }

  public resolveFilePath(): string {
    return this.customFilePath ?? join(getConfigDir(), LIMITS_FILE_NAME);
  }

  public readFile(): LimitStoreFile {
    const filePath = this.resolveFilePath();
    if (!existsSync(filePath)) {
      this.cache = null;
      return createEmptyLimitStoreFile();
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
      const data = sanitizeLimitStoreFile(parsed);
      this.cache = {
        filePath,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        data,
      };
      return data;
    } catch {
      this.cache = null;
      return createEmptyLimitStoreFile();
    }
  }

  public writeFile(data: LimitStoreFile): LimitStoreFile {
    const filePath = this.resolveFilePath();
    const sanitized = sanitizeLimitStoreFile(data);
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

  public saveCheckResult(options: {
    providerId: string;
    profileId: string;
    profileName?: string;
    result: ProviderLimitCheckResult;
    checkedAt?: string;
  }): StoredProfileLimitRecord {
    const file = this.readFile();
    const checkedAt = options.checkedAt ?? new Date().toISOString();
    const key = buildLimitEntryKey(options.providerId, options.profileId);
    const record: StoredProfileLimitRecord = {
      providerId: options.providerId,
      profileId: options.profileId,
      ...(options.profileName ? { profileName: options.profileName } : {}),
      status: options.result.status,
      planName: options.result.planName ?? null,
      sourceUrl: options.result.sourceUrl,
      sourceKind: options.result.sourceKind,
      scopeNote: options.result.scopeNote ?? null,
      providerUpdatedText: options.result.providerUpdatedText ?? null,
      buckets: options.result.buckets,
      rawSummary: options.result.rawSummary ?? null,
      checkedAt,
      lastError: options.result.lastError ?? null,
    };

    const nextEntries = { ...file.entries, [key]: record };
    this.writeFile({
      version: 1,
      updatedAt: checkedAt,
      entries: nextEntries,
    });
    return record;
  }

  public savePassiveCooldownResult(options: {
    providerId: string;
    profileId: string;
    profileName?: string;
    buckets: ProviderLimitBucket[];
    rawSummary: string;
    lastError: string;
    checkedAt?: string;
  }): StoredProfileLimitRecord {
    const file = this.readFile();
    const checkedAt = options.checkedAt ?? new Date().toISOString();
    const key = buildLimitEntryKey(options.providerId, options.profileId);
    const existing = file.entries[key];
    const record: StoredProfileLimitRecord = {
      providerId: options.providerId,
      profileId: options.profileId,
      ...(options.profileName
        ? { profileName: options.profileName }
        : existing?.profileName
          ? { profileName: existing.profileName }
          : {}),
      status: "exhausted",
      planName: existing?.planName ?? null,
      sourceUrl: existing?.sourceUrl ?? null,
      sourceKind: "dom-fallback",
      scopeNote: existing?.scopeNote ?? "Passive quota limit detected during turn execution.",
      providerUpdatedText: existing?.providerUpdatedText ?? null,
      buckets: options.buckets,
      rawSummary: options.rawSummary,
      checkedAt,
      lastError: options.lastError,
    };
    this.writeFile({
      version: 1,
      updatedAt: checkedAt,
      entries: { ...file.entries, [key]: record },
    });
    return record;
  }

  public clearPassiveExhaustedIfExpired(
    providerId: string,
    profileId: string,
  ): boolean {
    const file = this.readFile();
    const key = buildLimitEntryKey(providerId, profileId);
    const existing = file.entries[key];
    if (
      !existing ||
      existing.status !== "exhausted" ||
      existing.sourceKind !== "dom-fallback"
    ) {
      return false;
    }
    const nextEntries = { ...file.entries };
    delete nextEntries[key];
    this.writeFile({
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: nextEntries,
    });
    return true;
  }

  public saveFailure(options: {
    providerId: string;
    profileId: string;
    profileName?: string;
    status: Extract<LimitStatusKind, "signed_out" | "challenge" | "error">;
    sourceUrl?: string | null;
    message: string;
    checkedAt?: string;
  }): StoredProfileLimitRecord {
    const file = this.readFile();
    const checkedAt = options.checkedAt ?? new Date().toISOString();
    const key = buildLimitEntryKey(options.providerId, options.profileId);
    const existing = file.entries[key];
    const record: StoredProfileLimitRecord = {
      providerId: options.providerId,
      profileId: options.profileId,
      ...(options.profileName
        ? { profileName: options.profileName }
        : existing?.profileName
          ? { profileName: existing.profileName }
          : {}),
      status: options.status,
      planName: options.status === "signed_out" ? null : existing?.planName ?? null,
      sourceUrl: options.sourceUrl ?? existing?.sourceUrl ?? null,
      sourceKind: existing?.sourceKind ?? null,
      scopeNote: existing?.scopeNote ?? null,
      providerUpdatedText: existing?.providerUpdatedText ?? null,
      buckets: options.status === "signed_out" ? [] : existing?.buckets ?? [],
      rawSummary: existing?.rawSummary ?? null,
      checkedAt,
      lastError: options.message,
    };
    this.writeFile({
      version: 1,
      updatedAt: checkedAt,
      entries: { ...file.entries, [key]: record },
    });
    return record;
  }

  public pruneRemovedProfiles(
    validProfileKeys: ReadonlySet<string>,
    providerIdsToPrune: ReadonlySet<string>,
  ): boolean {
    const file = this.readFile();
    let changed = false;
    const nextEntries: Record<string, StoredProfileLimitRecord> = {};
    for (const [key, entry] of Object.entries(file.entries)) {
      if (
        providerIdsToPrune.has(entry.providerId) &&
        !validProfileKeys.has(key)
      ) {
        changed = true;
        continue;
      }
      nextEntries[key] = entry;
    }
    if (changed) {
      this.writeFile({
        version: 1,
        updatedAt: new Date().toISOString(),
        entries: nextEntries,
      });
    }
    return changed;
  }

  public clearCache(): void {
    this.cache = null;
  }
}

export const limitStore = LimitStore.getInstance();
