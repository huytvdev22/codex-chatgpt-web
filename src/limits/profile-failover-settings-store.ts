import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";

const SETTINGS_FILE_NAME = "profile-failover-settings.json";

export interface ProfileFailoverSettings {
  version: 1;
  autoSwitchProfileOnQuotaLimit: boolean;
  updatedAt: string | null;
}

interface CachedFailoverSettings {
  filePath: string;
  mtimeMs: number;
  size: number;
  data: ProfileFailoverSettings;
}

function createDefaultSettings(): ProfileFailoverSettings {
  return {
    version: 1,
    autoSwitchProfileOnQuotaLimit: false,
    updatedAt: null,
  };
}

export function sanitizeProfileFailoverSettings(
  raw: unknown,
): ProfileFailoverSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return createDefaultSettings();
  }
  const record = raw as Record<string, unknown>;
  const autoSwitchProfileOnQuotaLimit =
    record.autoSwitchProfileOnQuotaLimit === true;
  const updatedAt =
    typeof record.updatedAt === "string" &&
    Number.isFinite(Date.parse(record.updatedAt))
      ? record.updatedAt
      : null;
  return {
    version: 1,
    autoSwitchProfileOnQuotaLimit,
    updatedAt,
  };
}

/**
 * Kho đọc và hot-reload cấu hình tự động chuyển profile khi hết hạn mức
 * từ `<configDir>/profile-failover-settings.json`.
 */
export class ProfileFailoverSettingsStore {
  private static readonly defaultInstance = new ProfileFailoverSettingsStore();
  private cache: CachedFailoverSettings | null = null;

  constructor(private readonly customFilePath?: string) {}

  public static getInstance(): ProfileFailoverSettingsStore {
    return ProfileFailoverSettingsStore.defaultInstance;
  }

  public resolveFilePath(): string {
    return this.customFilePath ?? join(getConfigDir(), SETTINGS_FILE_NAME);
  }

  public read(): ProfileFailoverSettings {
    const filePath = this.resolveFilePath();
    if (!existsSync(filePath)) {
      this.cache = null;
      return createDefaultSettings();
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
      const data = sanitizeProfileFailoverSettings(parsed);
      this.cache = {
        filePath,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        data,
      };
      return data;
    } catch {
      this.cache = null;
      return createDefaultSettings();
    }
  }

  public isAutoSwitchEnabled(): boolean {
    return this.read().autoSwitchProfileOnQuotaLimit === true;
  }

  public save(
    patch: Partial<Pick<ProfileFailoverSettings, "autoSwitchProfileOnQuotaLimit">>,
  ): ProfileFailoverSettings {
    const current = this.read();
    const next: ProfileFailoverSettings = sanitizeProfileFailoverSettings({
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    const filePath = this.resolveFilePath();
    atomicWriteFile(filePath, `${JSON.stringify(next, null, 2)}\n`);
    try {
      const stats = statSync(filePath);
      this.cache = {
        filePath,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        data: next,
      };
    } catch {
      this.cache = null;
    }
    return next;
  }

  public clearCache(): void {
    this.cache = null;
  }
}

export const profileFailoverSettingsStore =
  ProfileFailoverSettingsStore.getInstance();
