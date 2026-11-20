import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import {
  createDefaultPersonalizationSettings,
  PERSONALIZATION_LIMITS,
  VALID_PERSONALIZATION_TONES,
  type PersonalizationSettings,
  type PersonalizationTone,
  type SavedMemoryItem,
} from "./types";

export interface PersonalizationSnapshot {
  settings: PersonalizationSettings;
  digest: string;
  filePath: string;
}

interface CachedFileState {
  filePath: string;
  mtimeMs: number;
  size: number;
  snapshot: PersonalizationSnapshot;
}

function normalizeText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n/g, "\n").trim().slice(0, maxLength);
}

function normalizeTone(value: unknown): PersonalizationTone {
  if (typeof value === "string" && (VALID_PERSONALIZATION_TONES as readonly string[]).includes(value)) {
    return value as PersonalizationTone;
  }
  return "default";
}

function normalizeIsoTimestamp(value: unknown, fallback: string): string {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return value;
  }
  return fallback;
}

/**
 * Chuẩn hóa dữ liệu cấu hình Personalization từ JSON thô trên đĩa.
 */
export function sanitizePersonalizationSettings(raw: unknown): PersonalizationSettings {
  const defaults = createDefaultPersonalizationSettings();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaults;
  }

  const record = raw as Record<string, unknown>;
  const now = new Date().toISOString();
  const memories: SavedMemoryItem[] = [];

  if (Array.isArray(record.memories)) {
    for (const entry of record.memories) {
      if (memories.length >= PERSONALIZATION_LIMITS.maxMemories) break;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const item = entry as Record<string, unknown>;
      const content = normalizeText(item.content, PERSONALIZATION_LIMITS.memoryContent);
      if (!content) continue;
      const id =
        typeof item.id === "string" && item.id.trim().length > 0
          ? item.id.trim().slice(0, 64)
          : randomUUID();
      const createdAt = normalizeIsoTimestamp(item.createdAt, now);
      const updatedAt = normalizeIsoTimestamp(item.updatedAt, createdAt);
      memories.push({
        id,
        content,
        enabled: item.enabled !== false,
        createdAt,
        updatedAt,
      });
    }
  }

  return {
    version: 1,
    enabled: record.enabled === true,
    workspaceMemoryEnabled: record.workspaceMemoryEnabled !== false,
    baseTone: normalizeTone(record.baseTone),
    nickname: normalizeText(record.nickname, PERSONALIZATION_LIMITS.nickname),
    roleOrStack: normalizeText(record.roleOrStack, PERSONALIZATION_LIMITS.roleOrStack),
    aboutYou: normalizeText(record.aboutYou, PERSONALIZATION_LIMITS.aboutYou),
    customInstructions: normalizeText(
      record.customInstructions,
      PERSONALIZATION_LIMITS.customInstructions,
    ),
    memories,
    updatedAt:
      typeof record.updatedAt === "string" && Number.isFinite(Date.parse(record.updatedAt))
        ? record.updatedAt
        : null,
  };
}

/**
 * Tính digest SHA-256 ngắn đại diện cho phần Global Personalization thực sự có hiệu lực.
 * Trả về chuỗi rỗng nếu Personalization đang tắt hoặc chưa có dữ liệu active nào.
 */
export function computeEffectivePersonalizationDigest(settings: PersonalizationSettings): string {
  if (!settings.enabled) return "";

  const activeMemories = settings.memories
    .filter((item) => item.enabled && item.content.trim().length > 0)
    .map((item) => item.content.trim());

  const hasContent =
    settings.baseTone !== "default" ||
    settings.nickname.length > 0 ||
    settings.roleOrStack.length > 0 ||
    settings.aboutYou.length > 0 ||
    settings.customInstructions.length > 0 ||
    activeMemories.length > 0;

  if (!hasContent) return "";

  const payload = {
    baseTone: settings.baseTone,
    nickname: settings.nickname,
    roleOrStack: settings.roleOrStack,
    aboutYou: settings.aboutYou,
    customInstructions: settings.customInstructions,
    memories: activeMemories,
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

/**
 * Kho đọc và hot-reload cấu hình Personalization từ `<configDir>/personalization.json`.
 * Tự kiểm tra `mtimeMs` + `size` để cập nhật tức thì mà không cần restart server.
 */
export class PersonalizationStore {
  private cache: CachedFileState | null = null;

  constructor(private readonly customFilePath?: string) {}

  public resolveFilePath(): string {
    return this.customFilePath ?? join(getConfigDir(), "personalization.json");
  }

  public getSnapshot(): PersonalizationSnapshot {
    const filePath = this.resolveFilePath();
    if (!existsSync(filePath)) {
      this.cache = null;
      const settings = createDefaultPersonalizationSettings();
      return { settings, digest: "", filePath };
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
      const settings = sanitizePersonalizationSettings(raw);
      const snapshot: PersonalizationSnapshot = {
        settings,
        digest: computeEffectivePersonalizationDigest(settings),
        filePath,
      };
      this.cache = {
        filePath,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        snapshot,
      };
      return snapshot;
    } catch {
      this.cache = null;
      const settings = createDefaultPersonalizationSettings();
      return { settings, digest: "", filePath };
    }
  }

  public clearCache(): void {
    this.cache = null;
  }
}

export const personalizationStore = new PersonalizationStore();
