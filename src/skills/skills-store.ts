import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import {
  skillDirectoryScanner,
  type SkillDirectoryScanner,
} from "./skill-directory-scanner";
import {
  createDefaultSkillsSettings,
  getDefaultSkillDirectories,
  type DiscoveredSkillRecord,
  type HostSkillEntry,
  type SkillDirectoryEntry,
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

interface CachedDirectoryScan {
  key: string;
  scannedAt: number;
  skills: HostSkillEntry[];
}

const MAX_DISABLED_SKILLS = 200;
const MAX_SKILL_DIRECTORIES = 30;
const DIRECTORY_SCAN_CACHE_TTL_MS = 5_000;
const VALID_SOURCES = new Set<SkillSourceKind>([
  "workspace",
  "custom",
  "user",
  "system",
  "unknown",
]);

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

function normalizeSkillDirectories(raw: unknown): SkillDirectoryEntry[] {
  if (raw === undefined) {
    return getDefaultSkillDirectories();
  }
  if (!Array.isArray(raw)) {
    return [];
  }

  const seen = new Set<string>();
  const result: SkillDirectoryEntry[] = [];
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

  for (const item of raw) {
    let rawPath = "";
    let enabled = true;

    if (typeof item === "string") {
      rawPath = item;
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      rawPath = typeof obj.path === "string" ? obj.path : "";
      enabled = obj.enabled !== false;
    } else {
      continue;
    }

    const cleaned = rawPath.trim().slice(0, 500);
    if (!cleaned) continue;

    const expanded = skillDirectoryScanner.expandPath(cleaned);
    const dedupKey = (caseInsensitive ? expanded.toLowerCase() : expanded).replace(/[\\/]+$/, "");
    if (!dedupKey || seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    result.push({
      path: cleaned,
      enabled,
    });
    if (result.length >= MAX_SKILL_DIRECTORIES) break;
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
    skillDirectories: normalizeSkillDirectories(obj.skillDirectories),
    updatedAt,
  };
}

/**
 * Kho đọc và hot-reload cấu hình Native Skills Bridge từ `<configDir>/skills.json`,
 * quét các thư mục skill đã cấu hình và lưu cache metadata các skill Codex đã gửi.
 */
export class SkillsStore {
  private cache: CachedFileState | null = null;
  private directoryScanCache: CachedDirectoryScan | null = null;
  private lastDiscoveredDigest = "";

  constructor(
    private readonly customFilePath?: string,
    private readonly customDiscoveredFilePath?: string,
    private readonly scanner: SkillDirectoryScanner = skillDirectoryScanner,
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

  public getDirectorySkills(settings?: SkillsSettings): HostSkillEntry[] {
    const activeSettings = settings ?? this.getSnapshot().settings;
    if (!activeSettings.enabled || activeSettings.skillDirectories.length === 0) {
      return [];
    }

    const enabledDirs = activeSettings.skillDirectories.filter((entry) => entry.enabled);
    if (enabledDirs.length === 0) {
      return [];
    }

    const cacheKey = JSON.stringify(enabledDirs);
    const now = Date.now();
    if (
      this.directoryScanCache &&
      this.directoryScanCache.key === cacheKey &&
      now - this.directoryScanCache.scannedAt < DIRECTORY_SCAN_CACHE_TTL_MS
    ) {
      return this.directoryScanCache.skills;
    }

    const result = this.scanner.scanDirectories(enabledDirs);
    this.directoryScanCache = {
      key: cacheKey,
      scannedAt: now,
      skills: result.skills,
    };
    return result.skills;
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
    this.directoryScanCache = null;
    this.lastDiscoveredDigest = "";
  }
}

export const skillsStore = new SkillsStore();
