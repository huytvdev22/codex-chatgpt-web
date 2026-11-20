const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const {
  detectSuggestedSkillDirectories,
  expandSkillPath,
  mergeDiscoveredAndDirectorySkills,
  normalizePathKey,
  scanSkillDirectories,
} = require("./skill-directory-scanner.cjs");

function getDefaultSkillDirectories() {
  const defaultCodexHome = path.resolve(path.join(os.homedir(), ".codex"));
  const envCodexHome = typeof process.env.CODEX_HOME === "string" ? process.env.CODEX_HOME.trim() : "";
  if (envCodexHome && path.resolve(envCodexHome) !== defaultCodexHome) {
    return [{ path: path.join(envCodexHome, "skills"), enabled: true }];
  }
  return [{ path: "~/.codex/skills", enabled: true }];
}

const DEFAULT_SKILLS_SETTINGS = Object.freeze({
  version: 1,
  enabled: true,
  autoDiscoverHostSkills: true,
  includeSystemSkills: false,
  disabledSkills: [],
  skillDirectories: Object.freeze([{ path: "~/.codex/skills", enabled: true }]),
  updatedAt: null,
});

const VALID_SOURCES = new Set(["workspace", "custom", "user", "system", "unknown"]);
const MAX_DISABLED_SKILLS = 200;
const MAX_SKILL_DIRECTORIES = 30;

function defaultSkillsSettings() {
  return {
    version: 1,
    enabled: true,
    autoDiscoverHostSkills: true,
    includeSystemSkills: false,
    disabledSkills: [],
    skillDirectories: getDefaultSkillDirectories(),
    updatedAt: null,
  };
}

function normalizeDisabledSkills(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const result = [];
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

function normalizeSkillDirectories(raw) {
  if (raw === undefined) {
    return getDefaultSkillDirectories();
  }
  if (!Array.isArray(raw)) return [];

  const seen = new Set();
  const result = [];
  for (const item of raw) {
    let rawPath = "";
    let enabled = true;

    if (typeof item === "string") {
      rawPath = item;
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      rawPath = typeof item.path === "string" ? item.path : "";
      enabled = item.enabled !== false;
    } else {
      continue;
    }

    const cleaned = rawPath.trim().slice(0, 500);
    if (!cleaned) continue;

    const key = normalizePathKey(expandSkillPath(cleaned));
    if (!key || seen.has(key)) continue;
    seen.add(key);

    result.push({ path: cleaned, enabled });
    if (result.length >= MAX_SKILL_DIRECTORIES) break;
  }

  return result;
}

function sanitizeSkillsSettings(raw, { stampUpdatedAt = false } = {}) {
  const defaults = defaultSkillsSettings();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaults;
  }

  const now = new Date().toISOString();
  const updatedAt = stampUpdatedAt
    ? now
    : typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt))
      ? raw.updatedAt
      : null;

  return {
    version: 1,
    enabled: raw.enabled !== false,
    autoDiscoverHostSkills: raw.autoDiscoverHostSkills !== false,
    includeSystemSkills: raw.includeSystemSkills === true,
    disabledSkills: normalizeDisabledSkills(raw.disabledSkills),
    skillDirectories: normalizeSkillDirectories(raw.skillDirectories),
    updatedAt,
  };
}

function readSkillsSettings(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || parsed.version !== 1) return defaultSkillsSettings();
    return sanitizeSkillsSettings(parsed);
  } catch {
    return defaultSkillsSettings();
  }
}

function readDiscoveredSkills(discoveredFilePath) {
  if (!discoveredFilePath) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(discoveredFilePath, "utf8"));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.skills)) return [];
    const results = [];
    for (const item of parsed.skills) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const name = typeof item.name === "string" ? item.name.trim() : "";
      const absolutePath = typeof item.absolutePath === "string" ? item.absolutePath.trim() : "";
      if (!name || !absolutePath) continue;
      results.push({
        name,
        description: typeof item.description === "string" ? item.description.trim() : "",
        absolutePath,
        source: VALID_SOURCES.has(item.source) ? item.source : "unknown",
        lastSeenAt:
          typeof item.lastSeenAt === "string" && Number.isFinite(Date.parse(item.lastSeenAt))
            ? item.lastSeenAt
            : new Date().toISOString(),
        allowImplicitInvocation: item.allowImplicitInvocation !== false,
      });
    }
    return results;
  } catch {
    return [];
  }
}

function writeSkillsSettings(filePath, next) {
  const sanitized = sanitizeSkillsSettings(next, { stampUpdatedAt: true });
  writePrivateFileAtomic(filePath, `${JSON.stringify(sanitized, null, 2)}\n`);
  return sanitized;
}

function buildSkillsPayload(settings, discoveredFilePath) {
  const hostSkills = readDiscoveredSkills(discoveredFilePath);
  const scan = scanSkillDirectories(settings.skillDirectories);
  const suggestedDirectories = detectSuggestedSkillDirectories(settings.skillDirectories);
  const discoveredSkills = mergeDiscoveredAndDirectorySkills(hostSkills, scan.skills);

  return {
    settings,
    directories: scan.directories,
    suggestedDirectories,
    discoveredSkills,
  };
}

function createSkillsStore(filePath, discoveredFilePath) {
  return {
    filePath,
    discoveredFilePath,
    read() {
      const settings = readSkillsSettings(filePath);
      return buildSkillsPayload(settings, discoveredFilePath);
    },
    save(next) {
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        throw new Error("Skills settings must be a JSON object");
      }
      const settings = writeSkillsSettings(filePath, next);
      return buildSkillsPayload(settings, discoveredFilePath);
    },
    resolveAllowedDirectory(targetPath) {
      const targetKey = normalizePathKey(expandSkillPath(targetPath));
      if (!targetKey) return null;

      const settings = readSkillsSettings(filePath);
      const allowedCandidates = [
        ...settings.skillDirectories.map((item) => item.path),
        ...detectSuggestedSkillDirectories(settings.skillDirectories).map((item) => item.path),
      ];

      for (const candidate of allowedCandidates) {
        const resolved = expandSkillPath(candidate);
        if (normalizePathKey(resolved) === targetKey && fs.existsSync(resolved)) {
          try {
            if (fs.statSync(resolved).isDirectory()) {
              return resolved;
            }
          } catch {
            return null;
          }
        }
      }
      return null;
    },
  };
}

module.exports = {
  DEFAULT_SKILLS_SETTINGS,
  createSkillsStore,
  getDefaultSkillDirectories,
  readDiscoveredSkills,
  readSkillsSettings,
  sanitizeSkillsSettings,
  writeSkillsSettings,
};
