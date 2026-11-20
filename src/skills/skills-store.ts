import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import {
  createDefaultSkillsSettings,
  type DiscoveredSkillRecord,
  type HostSkillEntry,
  type SkillSourceKind,
  type SkillsSettings,
} from "./types";

export interface SkillsSnapshot {
  settings: SkillsSettings;
  filePath: string;
}

interface CachedFileState {
  filePath: string;
  mtimeMs: number;
  size: number;
  snapshot: SkillsSnapshot;
}

const MAX_DISABLED_SKILLS = 200;
const VALID_SOURCES = new Set<SkillSourceKind>(["workspace", "user", "system", "unknown"]);

function normalizeSkillNameList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const cleaned = item.trim().slice(0, 120);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
    if (result.length >= MAX_DISABLED_SKILLS) break;
  }
  return result;
}

export function sanitizeSkillsSettings(raw: unknown): SkillsSettings {
  const defaults = createDefaultSkillsSettings();
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
    enabled: obj.enabled !== false,
    autoDiscoverHostSkills: obj.autoDiscoverHostSkills !== false,
    includeSystemSkills: obj.includeSystemSkills === true,
    disabledSkills: normalizeSkillNameList(obj.disabledSkills),
    updatedAt,
  };
}

/**
 * Kho đọc và hot-reload cấu hình Native Skills Bridge từ `<configDir>/skills.json`,
 * đồng thời lưu cache metadata các skill Codex đã gửi để Launcher UI hiển thị cho người dùng bật/tắt.
 */
export class SkillsStore {
  private cache: CachedFileState | null = null;
  private lastDiscoveredDigest = "";

  constructor(
    private readonly customFilePath?: string,
    private readonly customDiscoveredFilePath?: string,
  ) {}

  public resolveFilePath(): string {
    return this.customFilePath ?? join(getConfigDir(), "skills.json");
  }

  public resolveDiscoveredFilePath(): string {
    return this.customDiscoveredFilePath ?? join(getConfigDir(), "discovered-skills.json");
  }

  public getSnapshot(): SkillsSnapshot {
    const filePath = this.resolveFilePath();
    if (!existsSync(filePath)) {
      this.cache = null;
      return { settings: createDefaultSkillsSettings(), filePath };
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
      const settings = sanitizeSkillsSettings(raw);
      const snapshot: SkillsSnapshot = { settings, filePath };
      this.cache = {
        filePath,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        snapshot,
      };
      return snapshot;
    } catch {
      this.cache = null;
      return { settings: createDefaultSkillsSettings(), filePath };
    }
  }

  public recordDiscoveredSkills(skills: readonly HostSkillEntry[]): void {
    if (skills.length === 0) return;
    try {
      const digestInput = skills.map((s) => ({
        name: s.name,
        description: s.description,
        absolutePath: s.absolutePath,
        source: s.source,
      }));
      const digest = createHash("sha256")
        .update(JSON.stringify(digestInput))
        .digest("hex")
        .slice(0, 16);

      const filePath = this.resolveDiscoveredFilePath();
      if (this.lastDiscoveredDigest === digest && existsSync(filePath)) {
        return;
      }

      const now = new Date().toISOString();
      const records: DiscoveredSkillRecord[] = digestInput.map((item) => ({
        name: item.name,
        description: item.description,
        absolutePath: item.absolutePath,
        source: VALID_SOURCES.has(item.source) ? item.source : "unknown",
        lastSeenAt: now,
      }));

      atomicWriteFile(
        filePath,
        `${JSON.stringify({ version: 1, updatedAt: now, skills: records }, null, 2)}\n`,
      );
      this.lastDiscoveredDigest = digest;
    } catch {
      // Non-fatal: failure to cache discovered metadata must never block turns
    }
  }

  public clearCache(): void {
    this.cache = null;
    this.lastDiscoveredDigest = "";
  }
}

export const skillsStore = new SkillsStore();
