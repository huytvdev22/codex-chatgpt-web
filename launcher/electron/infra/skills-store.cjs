const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const DEFAULT_SKILLS_SETTINGS = Object.freeze({
  version: 1,
  enabled: true,
  autoDiscoverHostSkills: true,
  includeSystemSkills: false,
  disabledSkills: [],
  updatedAt: null,
});

const VALID_SOURCES = new Set(["workspace", "user", "system", "unknown"]);
const MAX_DISABLED_SKILLS = 200;

function defaultSkillsSettings() {
  return {
    ...DEFAULT_SKILLS_SETTINGS,
    disabledSkills: [],
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

function createSkillsStore(filePath, discoveredFilePath) {
  return {
    filePath,
    discoveredFilePath,
    read() {
      return {
        settings: readSkillsSettings(filePath),
        discoveredSkills: readDiscoveredSkills(discoveredFilePath),
      };
    },
    save(next) {
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        throw new Error("Skills settings must be a JSON object");
      }
      const settings = writeSkillsSettings(filePath, next);
      return {
        settings,
        discoveredSkills: readDiscoveredSkills(discoveredFilePath),
      };
    },
  };
}

module.exports = {
  DEFAULT_SKILLS_SETTINGS,
  createSkillsStore,
  readDiscoveredSkills,
  readSkillsSettings,
  sanitizeSkillsSettings,
  writeSkillsSettings,
};
