import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { getCodexHome, sha256 } from "../codex-integration-shared";
import { VERSION } from "../version";

const MANAGED_MANIFEST_FILE = ".codex-chatgpt-web-managed.json";

interface ManagedSkillManifest {
  version: string;
  files: Record<string, string>;
}

export interface BundledSkillSyncResult {
  synced: string[];
  skipped: string[];
  unchanged: string[];
}

function hasBundledSkills(dir: string): boolean {
  return existsSync(join(dir, "gemini-image", "SKILL.md"));
}

/**
 * Tìm thư mục chứa các Codex skills đóng gói kèm repo / runtime bundle (`assets/skills`).
 */
export function resolveBundledSkillsRoot(): string | undefined {
  const candidates = [
    resolve(import.meta.dir, "..", "assets", "skills"),
    resolve(import.meta.dir, "..", "..", "assets", "skills"),
    resolve(process.cwd(), "assets", "skills"),
  ];
  return candidates.find((candidate) => hasBundledSkills(candidate));
}

function collectRelativeFiles(rootDir: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(abs);
        continue;
      }
      if (entry.isFile() && statSync(abs).isFile()) {
        files.push(relative(rootDir, abs).split(sep).join("/"));
      }
    }
  };
  visit(rootDir);
  return files.sort();
}

function readManagedManifest(destSkillDir: string): ManagedSkillManifest | null {
  const manifestPath = join(destSkillDir, MANAGED_MANIFEST_FILE);
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<ManagedSkillManifest>;
    if (!parsed || typeof parsed.version !== "string" || !parsed.files || typeof parsed.files !== "object") {
      return null;
    }
    return {
      version: parsed.version,
      files: parsed.files as Record<string, string>,
    };
  } catch {
    return null;
  }
}

/**
 * Đồng bộ các skill đóng gói (`assets/skills/*`) sang `~/.codex/skills/*`
 * để Codex tự nhận diện `$gemini-image` ngay cả ở chế độ `auth_mode: "apikey"`.
 * Không ghi đè nếu thư mục skill đích đã tồn tại nhưng không có manifest do bridge quản lý.
 */
export function syncBundledCodexSkills(options: {
  sourceSkillsDir?: string;
  targetSkillsDir?: string;
} = {}): BundledSkillSyncResult {
  const result: BundledSkillSyncResult = { synced: [], skipped: [], unchanged: [] };
  const sourceSkillsDir = options.sourceSkillsDir ?? resolveBundledSkillsRoot();
  if (!sourceSkillsDir || !existsSync(sourceSkillsDir)) {
    return result;
  }

  const targetSkillsDir = options.targetSkillsDir ?? join(getCodexHome(), "skills");
  mkdirSync(targetSkillsDir, { recursive: true });

  for (const entry of readdirSync(sourceSkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillName = entry.name;
    const srcSkillDir = join(sourceSkillsDir, skillName);
    if (!existsSync(join(srcSkillDir, "SKILL.md"))) continue;

    const destSkillDir = join(targetSkillsDir, skillName);
    const relFiles = collectRelativeFiles(srcSkillDir);
    const nextHashes: Record<string, string> = {};
    const fileBuffers = new Map<string, Buffer>();
    for (const relPath of relFiles) {
      const data = readFileSync(join(srcSkillDir, relPath));
      fileBuffers.set(relPath, data);
      nextHashes[relPath] = sha256(data);
    }

    if (existsSync(destSkillDir)) {
      const existingManifest = readManagedManifest(destSkillDir);
      if (!existingManifest) {
        result.skipped.push(skillName);
        continue;
      }

      const upToDate =
        existingManifest.version === VERSION &&
        relFiles.length === Object.keys(existingManifest.files).length &&
        relFiles.every((relPath) => {
          const destFile = join(destSkillDir, relPath);
          if (!existsSync(destFile)) return false;
          return (
            existingManifest.files[relPath] === nextHashes[relPath] &&
            sha256(readFileSync(destFile)) === nextHashes[relPath]
          );
        });

      if (upToDate) {
        result.unchanged.push(skillName);
        continue;
      }
    }

    for (const relPath of relFiles) {
      const destFile = join(destSkillDir, relPath);
      mkdirSync(dirname(destFile), { recursive: true });
      writeFileSync(destFile, fileBuffers.get(relPath)!);
      if (process.platform !== "win32" && (relPath.endsWith(".mjs") || relPath.endsWith(".sh"))) {
        chmodSync(destFile, 0o755);
      }
    }

    const nextManifest: ManagedSkillManifest = {
      version: VERSION,
      files: nextHashes,
    };
    writeFileSync(
      join(destSkillDir, MANAGED_MANIFEST_FILE),
      `${JSON.stringify(nextManifest, null, 2)}\n`,
    );
    result.synced.push(skillName);
  }

  return result;
}
