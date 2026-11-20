import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
  HostSkillEntry,
  ScannedSkillDirectory,
  SkillDirectoryEntry,
  SkillSourceKind,
} from "./types";

const MAX_SCAN_DEPTH = 3;
const MAX_SKILLS_PER_DIR = 200;
const MAX_SKILL_CONTENT_BYTES = 64 * 1024;
const SKILL_FILE_NAME = "SKILL.md";

const IGNORED_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
  "__pycache__",
]);

export interface DirectoryScanResult {
  directories: ScannedSkillDirectory[];
  skills: HostSkillEntry[];
}

export interface ParsedSkillDocument {
  name: string;
  description: string;
  body: string;
}

function normalizeSlash(value: string): string {
  return value.replace(/\\/g, "/");
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Quét thư mục chứa Skills trên ổ đĩa theo chuẩn `SKILL.md` (hỗ trợ YAML frontmatter,
 * `agents/openai.yaml`, chống symlink loop và giới hạn độ sâu an toàn).
 */
export class SkillDirectoryScanner {
  public expandPath(rawPath: string): string {
    const trimmed = rawPath.trim();
    if (!trimmed) return "";
    if (trimmed === "~") {
      return homedir();
    }
    if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
      return resolve(join(homedir(), trimmed.slice(2)));
    }
    return resolve(trimmed);
  }

  public parseSkillDocument(rawMarkdown: string, fallbackName: string): ParsedSkillDocument {
    const normalized = rawMarkdown.replace(/^\uFEFF/, "");
    let name = "";
    let description = "";
    let body = normalized.trim();

    const frontmatterMatch = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (frontmatterMatch) {
      const yaml = frontmatterMatch[1] || "";
      body = normalized.slice(frontmatterMatch[0].length).trim();
      const lines = yaml.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const fieldMatch = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
        if (!fieldMatch) continue;

        const key = fieldMatch[1]?.toLowerCase();
        const rawVal = (fieldMatch[2] ?? "").trim();

        if (key !== "name" && key !== "description") continue;

        let value = "";
        if (rawVal === ">" || rawVal === ">-" || rawVal === "|" || rawVal === "|-") {
          const collected: string[] = [];
          while (i + 1 < lines.length) {
            const nextLine = lines[i + 1] ?? "";
            if (/^[ \t]+/.test(nextLine)) {
              collected.push(nextLine.trim());
              i++;
            } else if (nextLine.trim() === "") {
              collected.push("");
              i++;
            } else {
              break;
            }
          }
          value =
            rawVal.startsWith("|")
              ? collected.join("\n").trim()
              : collected.filter(Boolean).join(" ").trim();
        } else {
          value = unquoteYamlScalar(rawVal);
        }

        if (key === "name" && value) {
          name = value.slice(0, 120);
        } else if (key === "description" && value) {
          description = value.slice(0, 600);
        }
      }
    }

    if (!description && body) {
      for (const line of body.split(/\r?\n/)) {
        const cleaned = line.trim();
        if (!cleaned || cleaned.startsWith("#") || cleaned.startsWith("```")) continue;
        description = cleaned.slice(0, 300);
        break;
      }
    }

    return {
      name: name || fallbackName.trim() || "unnamed-skill",
      description,
      body: body || normalized.trim(),
    };
  }

  public readAllowImplicitInvocation(skillDir: string): boolean {
    const policyPath = join(skillDir, "agents", "openai.yaml");
    if (!existsSync(policyPath)) return true;
    try {
      const content = readFileSync(policyPath, "utf8");
      if (/allow_implicit_invocation\s*:\s*false\b/i.test(content)) {
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  public readSkillContent(
    absolutePath: string,
    maxBytes = MAX_SKILL_CONTENT_BYTES,
  ): string | null {
    try {
      if (!existsSync(absolutePath)) return null;
      const stats = statSync(absolutePath);
      if (!stats.isFile()) return null;
      const raw = readFileSync(absolutePath, "utf8");
      const trimmed = raw.trim();
      if (!trimmed) return null;
      if (Buffer.byteLength(trimmed, "utf8") <= maxBytes) {
        return trimmed;
      }
      return `${trimmed.slice(0, maxBytes)}\n\n[...truncated SKILL.md...]`;
    } catch {
      return null;
    }
  }

  public scanDirectory(entry: SkillDirectoryEntry): {
    summary: ScannedSkillDirectory;
    skills: HostSkillEntry[];
  } {
    const resolvedPath = this.expandPath(entry.path);
    if (!resolvedPath) {
      return {
        summary: {
          path: entry.path,
          resolvedPath: "",
          enabled: entry.enabled,
          exists: false,
          skillCount: 0,
          error: "Empty directory path",
        },
        skills: [],
      };
    }

    if (!existsSync(resolvedPath)) {
      return {
        summary: {
          path: entry.path,
          resolvedPath,
          enabled: entry.enabled,
          exists: false,
          skillCount: 0,
          error: "Directory not found",
        },
        skills: [],
      };
    }

    let rootStats;
    try {
      rootStats = statSync(resolvedPath);
    } catch (error) {
      return {
        summary: {
          path: entry.path,
          resolvedPath,
          enabled: entry.enabled,
          exists: false,
          skillCount: 0,
          error: error instanceof Error ? error.message : String(error),
        },
        skills: [],
      };
    }

    if (!rootStats.isDirectory()) {
      return {
        summary: {
          path: entry.path,
          resolvedPath,
          enabled: entry.enabled,
          exists: false,
          skillCount: 0,
          error: "Path is not a directory",
        },
        skills: [],
      };
    }

    const skills: HostSkillEntry[] = [];
    const visitedRealDirs = new Set<string>();
    const seenFiles = new Set<string>();

    const walk = (currentDir: string, depth: number) => {
      if (skills.length >= MAX_SKILLS_PER_DIR) return;

      let realDir = currentDir;
      try {
        realDir = realpathSync(currentDir);
      } catch {
        return;
      }
      if (visitedRealDirs.has(realDir)) return;
      visitedRealDirs.add(realDir);

      const directSkillPath = join(currentDir, SKILL_FILE_NAME);
      if (existsSync(directSkillPath)) {
        try {
          const st = statSync(directSkillPath);
          if (st.isFile()) {
            const realSkillPath = realpathSync(directSkillPath);
            if (!seenFiles.has(realSkillPath)) {
              seenFiles.add(realSkillPath);
              const raw = readFileSync(directSkillPath, "utf8");
              const fallbackName = basename(currentDir);
              const parsed = this.parseSkillDocument(raw, fallbackName);
              const source = this.classifyDirectorySkillSource(directSkillPath, resolvedPath);
              const allowImplicitInvocation = this.readAllowImplicitInvocation(currentDir);

              skills.push({
                name: parsed.name,
                description: parsed.description,
                shortPath: directSkillPath,
                absolutePath: directSkillPath,
                source,
                directoryPath: entry.path,
                allowImplicitInvocation,
              });
            }
            // Một thư mục đã chứa SKILL.md thường là gốc 1 skill hoàn chỉnh; không đào sâu vào scripts/ hay references/
            if (depth > 0) return;
          }
        } catch {
          // Bỏ qua file không đọc được
        }
      }

      if (depth >= MAX_SCAN_DEPTH) return;

      let dirEntries;
      try {
        dirEntries = readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      dirEntries.sort((a, b) => a.name.localeCompare(b.name));

      for (const dirent of dirEntries) {
        if (skills.length >= MAX_SKILLS_PER_DIR) break;
        const childName = dirent.name;
        if (IGNORED_DIR_NAMES.has(childName)) continue;
        if (childName.startsWith(".") && childName !== ".system") continue;

        const childPath = join(currentDir, childName);
        let isDir = dirent.isDirectory();
        if (!isDir && dirent.isSymbolicLink()) {
          try {
            isDir = statSync(childPath).isDirectory();
          } catch {
            isDir = false;
          }
        }
        if (isDir) {
          walk(childPath, depth + 1);
        }
      }
    };

    walk(resolvedPath, 0);

    return {
      summary: {
        path: entry.path,
        resolvedPath,
        enabled: entry.enabled,
        exists: true,
        skillCount: skills.length,
        error: null,
      },
      skills,
    };
  }

  public scanDirectories(entries: readonly SkillDirectoryEntry[]): DirectoryScanResult {
    const directories: ScannedSkillDirectory[] = [];
    const skills: HostSkillEntry[] = [];

    for (const entry of entries) {
      const result = this.scanDirectory(entry);
      directories.push(result.summary);
      if (entry.enabled) {
        skills.push(...result.skills);
      }
    }

    return { directories, skills };
  }

  private classifyDirectorySkillSource(
    absolutePath: string,
    rootPath: string,
  ): SkillSourceKind {
    const normPath = normalizeSlash(absolutePath).toLowerCase();
    const normRoot = normalizeSlash(rootPath).toLowerCase();

    if (
      normRoot.endsWith("/.system") ||
      normRoot.includes("/.codex/skills/.system") ||
      normPath.includes("/.codex/skills/.system/") ||
      normPath.includes("/.system/")
    ) {
      return "system";
    }

    const parentDir = normalizeSlash(dirname(absolutePath)).toLowerCase();
    if (parentDir.includes("/.system/")) {
      return "system";
    }

    return "custom";
  }
}

export const skillDirectoryScanner = new SkillDirectoryScanner();
