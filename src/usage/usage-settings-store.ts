import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { createDefaultUsageSettings, type UsageSettings } from "./types";

export interface UsageSettingsSnapshot {
  settings: UsageSettings;
  filePath: string;
}

interface CachedFileState {
  filePath: string;
  mtimeMs: number;
  size: number;
  snapshot: UsageSettingsSnapshot;
}

export function sanitizeUsageSettings(raw: unknown): UsageSettings {
  const defaults = createDefaultUsageSettings();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaults;
  }
  const obj = raw as Record<string, unknown>;
  const updatedAt =
    typeof obj.updatedAt === "string" && Number.isFinite(Date.parse(obj.updatedAt))
      ? obj.updatedAt
      : null;
  return {
    version: 1,
    showChatFooter: obj.showChatFooter === true,
    updatedAt,
  };
}

/**
 * Kho đọc và hot-reload cấu hình hiển thị Token Usage từ `<configDir>/usage-settings.json`.
 */
export class UsageSettingsStore {
  private cache: CachedFileState | null = null;

  constructor(private readonly customFilePath?: string) {}

  public resolveFilePath(): string {
    return this.customFilePath ?? join(getConfigDir(), "usage-settings.json");
  }

  public getSnapshot(): UsageSettingsSnapshot {
    const filePath = this.resolveFilePath();
    if (
      !this.customFilePath &&
      !process.env.CODEX_CHATGPT_WEB_HOME?.trim() &&
      (process.env.NODE_ENV === "test" ||
        process.argv.some(
          (arg) => arg === "test" || /\.test\.[cm]?[jt]sx?$/i.test(arg),
        ))
    ) {
      return { settings: createDefaultUsageSettings(), filePath };
    }
    if (!existsSync(filePath)) {
      this.cache = null;
      return { settings: createDefaultUsageSettings(), filePath };
    }

    try {
      const stats = statSync(filePath);
      if (
        this.cache &&
        this.cache.filePath === filePath &&
        this.cache.mtimeMs === stats.mtimeMs &&
        this.cache.size === stats.size
      ) {
        return this.cache.snapshot;
      }

      const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      const settings = sanitizeUsageSettings(raw);
      const snapshot: UsageSettingsSnapshot = { settings, filePath };
      this.cache = {
        filePath,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        snapshot,
      };
      return snapshot;
    } catch {
      this.cache = null;
      return { settings: createDefaultUsageSettings(), filePath };
    }
  }

  public clearCache(): void {
    this.cache = null;
  }
}

export const usageSettingsStore = new UsageSettingsStore();
