import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";

const COOLDOWNS_FILE_NAME = "profile-cooldowns.json";
export const DEFAULT_QUOTA_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const MIN_QUOTA_COOLDOWN_MS = 60_000;
const MAX_QUOTA_COOLDOWN_MS = 48 * 60 * 60 * 1000;

export interface ProfileModelCooldownEntry {
  providerId: string;
  profileId: string;
  modelSlug: string;
  reason: string;
  exhaustedAt: string;
  resetAt: string;
  cooldownUntilMs: number;
}

interface ProfileCooldownFile {
  version: 1;
  updatedAt: string | null;
  entries: Record<string, ProfileModelCooldownEntry>;
}

interface CachedCooldownFile {
  filePath: string;
  mtimeMs: number;
  size: number;
  data: ProfileCooldownFile;
}

export function buildProfileCooldownKey(
  providerId: string,
  profileId: string,
  modelSlug: string,
): string {
  const cleanProvider = providerId.trim().toLowerCase() || "unknown";
  const cleanProfile = profileId.trim().toLowerCase() || "default";
  const cleanModel = modelSlug.trim().toLowerCase() || "default";
  return `${cleanProvider}::${cleanProfile}::${cleanModel}`;
}

/**
 * Trích xuất thời gian chờ mở lại quota từ thông báo lỗi của AI Studio / provider
 * (ví dụ: `resets in 15 hours, 24 minutes`, `resets in 45 minutes`).
 */
export function parseQuotaResetDelayMs(
  message: string,
  fallbackMs = DEFAULT_QUOTA_COOLDOWN_MS,
): number {
  if (!message) return fallbackMs;

  const resetsMatch = /resets?\s+in\s+([^\n).;]+)/i.exec(message);
  const segment = resetsMatch?.[1] ?? message;

  let totalMs = 0;
  let matchedUnit = false;

  const hoursMatch = /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i.exec(segment);
  if (hoursMatch?.[1]) {
    const hours = Number.parseFloat(hoursMatch[1]);
    if (Number.isFinite(hours) && hours > 0) {
      totalMs += hours * 60 * 60 * 1000;
      matchedUnit = true;
    }
  }

  const minutesMatch = /(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/i.exec(segment);
  if (minutesMatch?.[1]) {
    const minutes = Number.parseFloat(minutesMatch[1]);
    if (Number.isFinite(minutes) && minutes > 0) {
      totalMs += minutes * 60 * 1000;
      matchedUnit = true;
    }
  }

  const secondsMatch = /(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i.exec(segment);
  if (secondsMatch?.[1] && (resetsMatch || !matchedUnit)) {
    const seconds = Number.parseFloat(secondsMatch[1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      totalMs += seconds * 1000;
      matchedUnit = true;
    }
  }

  if (!matchedUnit || totalMs <= 0) {
    return fallbackMs;
  }
  return Math.min(
    MAX_QUOTA_COOLDOWN_MS,
    Math.max(MIN_QUOTA_COOLDOWN_MS, Math.ceil(totalMs)),
  );
}

/**
 * Định dạng thời gian còn lại tới lúc mở lại hạn mức (ví dụ `15h 24m` hoặc `45m`).
 */
export function formatResetRemainingText(
  resetAtMs: number,
  nowMs = Date.now(),
): string {
  const remainingMs = Math.max(0, resetAtMs - nowMs);
  if (remainingMs < 60_000) return "<1m";
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function createEmptyCooldownFile(): ProfileCooldownFile {
  return {
    version: 1,
    updatedAt: null,
    entries: {},
  };
}

function sanitizeCooldownEntry(
  raw: unknown,
): ProfileModelCooldownEntry | null {
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
  const cooldownUntilMs =
    typeof obj.cooldownUntilMs === "number" && Number.isFinite(obj.cooldownUntilMs)
      ? obj.cooldownUntilMs
      : NaN;
  if (!providerId || !Number.isFinite(cooldownUntilMs)) return null;

  const exhaustedAt =
    typeof obj.exhaustedAt === "string" && Number.isFinite(Date.parse(obj.exhaustedAt))
      ? obj.exhaustedAt
      : new Date().toISOString();
  const resetAt =
    typeof obj.resetAt === "string" && Number.isFinite(Date.parse(obj.resetAt))
      ? obj.resetAt
      : new Date(cooldownUntilMs).toISOString();
  const reason =
    typeof obj.reason === "string" ? obj.reason.trim().slice(0, 500) : "";

  return {
    providerId,
    profileId,
    modelSlug,
    reason,
    exhaustedAt,
    resetAt,
    cooldownUntilMs,
  };
}

function sanitizeCooldownFile(raw: unknown): ProfileCooldownFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return createEmptyCooldownFile();
  }
  const obj = raw as Record<string, unknown>;
  const updatedAt =
    typeof obj.updatedAt === "string" && Number.isFinite(Date.parse(obj.updatedAt))
      ? obj.updatedAt
      : null;
  const entries: Record<string, ProfileModelCooldownEntry> = {};
  if (obj.entries && typeof obj.entries === "object" && !Array.isArray(obj.entries)) {
    for (const rawEntry of Object.values(obj.entries)) {
      const sanitized = sanitizeCooldownEntry(rawEntry);
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
 * Kho lưu trữ cooldown bị động theo cặp `(providerId, profileId, modelSlug)` tại
 * `<configDir>/profile-cooldowns.json` để nhớ tài khoản nào đang bị limit và khi nào mở lại.
 */
export class ProfileCooldownStore {
  private static readonly defaultInstance = new ProfileCooldownStore();
  private cache: CachedCooldownFile | null = null;

  constructor(private readonly customFilePath?: string) {}

  public static getInstance(): ProfileCooldownStore {
    return ProfileCooldownStore.defaultInstance;
  }

  public resolveFilePath(): string {
    return this.customFilePath ?? join(getConfigDir(), COOLDOWNS_FILE_NAME);
  }

  public readFile(): ProfileCooldownFile {
    const filePath = this.resolveFilePath();
    if (!existsSync(filePath)) {
      this.cache = null;
      return createEmptyCooldownFile();
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
      const data = sanitizeCooldownFile(parsed);
      this.cache = {
        filePath,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        data,
      };
      return data;
    } catch {
      this.cache = null;
      return createEmptyCooldownFile();
    }
  }

  private writeFile(data: ProfileCooldownFile): ProfileCooldownFile {
    const filePath = this.resolveFilePath();
    const sanitized = sanitizeCooldownFile(data);
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

  public markExhausted(options: {
    providerId: string;
    profileId: string;
    modelSlug: string;
    message: string;
    nowMs?: number;
    resetDelayMs?: number;
  }): ProfileModelCooldownEntry {
    const nowMs = options.nowMs ?? Date.now();
    const delayMs =
      options.resetDelayMs ?? parseQuotaResetDelayMs(options.message);
    const cooldownUntilMs = nowMs + Math.max(1_000, delayMs);
    const providerId = options.providerId.trim().toLowerCase();
    const profileId = options.profileId.trim().toLowerCase() || "default";
    const modelSlug = options.modelSlug.trim().toLowerCase() || "default";
    const key = buildProfileCooldownKey(providerId, profileId, modelSlug);

    const file = this.readFile();
    const nextEntries: Record<string, ProfileModelCooldownEntry> = {};
    for (const [entryKey, entry] of Object.entries(file.entries)) {
      if (entry.cooldownUntilMs > nowMs) {
        nextEntries[entryKey] = entry;
      }
    }

    const record: ProfileModelCooldownEntry = {
      providerId,
      profileId,
      modelSlug,
      reason: options.message.trim().slice(0, 500),
      exhaustedAt: new Date(nowMs).toISOString(),
      resetAt: new Date(cooldownUntilMs).toISOString(),
      cooldownUntilMs,
    };
    nextEntries[key] = record;

    this.writeFile({
      version: 1,
      updatedAt: record.exhaustedAt,
      entries: nextEntries,
    });
    return record;
  }

  public getActiveCooldown(
    providerId: string,
    profileId: string,
    modelSlug: string,
    nowMs = Date.now(),
  ): ProfileModelCooldownEntry | undefined {
    const key = buildProfileCooldownKey(providerId, profileId, modelSlug);
    const entry = this.readFile().entries[key];
    if (!entry || entry.cooldownUntilMs <= nowMs) return undefined;
    return entry;
  }

  public isCoolingDown(
    providerId: string,
    profileId: string,
    modelSlug: string,
    nowMs = Date.now(),
  ): boolean {
    return this.getActiveCooldown(providerId, profileId, modelSlug, nowMs) !== undefined;
  }

  public listActiveCooldownsForProfile(
    providerId: string,
    profileId: string,
    nowMs = Date.now(),
  ): ProfileModelCooldownEntry[] {
    const cleanProvider = providerId.trim().toLowerCase();
    const cleanProfile = profileId.trim().toLowerCase() || "default";
    return Object.values(this.readFile().entries).filter(
      (entry) =>
        entry.providerId === cleanProvider &&
        entry.profileId === cleanProfile &&
        entry.cooldownUntilMs > nowMs,
    );
  }

  public pruneExpired(nowMs = Date.now()): boolean {
    const file = this.readFile();
    let changed = false;
    const nextEntries: Record<string, ProfileModelCooldownEntry> = {};
    for (const [key, entry] of Object.entries(file.entries)) {
      if (entry.cooldownUntilMs <= nowMs) {
        changed = true;
        continue;
      }
      nextEntries[key] = entry;
    }
    if (changed) {
      this.writeFile({
        version: 1,
        updatedAt: new Date(nowMs).toISOString(),
        entries: nextEntries,
      });
    }
    return changed;
  }

  public clearProfileCooldowns(providerId: string, profileId: string): boolean {
    const cleanProvider = providerId.trim().toLowerCase();
    const cleanProfile = profileId.trim().toLowerCase() || "default";
    const file = this.readFile();
    let changed = false;
    const nextEntries: Record<string, ProfileModelCooldownEntry> = {};
    for (const [key, entry] of Object.entries(file.entries)) {
      if (
        entry.providerId === cleanProvider &&
        entry.profileId === cleanProfile
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

export const profileCooldownStore = ProfileCooldownStore.getInstance();
