const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const PERSONALIZATION_LIMITS = Object.freeze({
  nickname: 80,
  roleOrStack: 200,
  aboutYou: 500,
  customInstructions: 1500,
  memoryContent: 200,
  maxMemories: 50,
});

const VALID_PERSONALIZATION_TONES = new Set([
  "default",
  "concise_technical",
  "friendly",
  "formal",
  "mentor",
]);

const DEFAULT_PERSONALIZATION = Object.freeze({
  version: 1,
  enabled: false,
  workspaceMemoryEnabled: true,
  baseTone: "default",
  nickname: "",
  roleOrStack: "",
  aboutYou: "",
  customInstructions: "",
  memories: [],
  updatedAt: null,
});

function defaultPersonalization() {
  return {
    ...DEFAULT_PERSONALIZATION,
    memories: [],
  };
}

function normalizeText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n/g, "\n").trim().slice(0, maxLength);
}

function normalizeIsoTimestamp(value, fallback) {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return value;
  }
  return fallback;
}

function sanitizePersonalization(raw, { stampUpdatedAt = false } = {}) {
  const defaults = defaultPersonalization();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaults;
  }

  const now = new Date().toISOString();
  const memories = [];
  if (Array.isArray(raw.memories)) {
    for (const entry of raw.memories) {
      if (memories.length >= PERSONALIZATION_LIMITS.maxMemories) break;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const content = normalizeText(entry.content, PERSONALIZATION_LIMITS.memoryContent);
      if (!content) continue;
      const id = typeof entry.id === "string" && entry.id.trim().length > 0
        ? entry.id.trim().slice(0, 64)
        : randomUUID();
      const createdAt = normalizeIsoTimestamp(entry.createdAt, now);
      const updatedAt = normalizeIsoTimestamp(entry.updatedAt, createdAt);
      memories.push({
        id,
        content,
        enabled: entry.enabled !== false,
        createdAt,
        updatedAt,
      });
    }
  }

  const baseTone = typeof raw.baseTone === "string" && VALID_PERSONALIZATION_TONES.has(raw.baseTone)
    ? raw.baseTone
    : defaults.baseTone;

  const updatedAt = stampUpdatedAt
    ? now
    : typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt))
      ? raw.updatedAt
      : null;

  return {
    version: 1,
    enabled: raw.enabled === true,
    workspaceMemoryEnabled: raw.workspaceMemoryEnabled !== false,
    baseTone,
    nickname: normalizeText(raw.nickname, PERSONALIZATION_LIMITS.nickname),
    roleOrStack: normalizeText(raw.roleOrStack, PERSONALIZATION_LIMITS.roleOrStack),
    aboutYou: normalizeText(raw.aboutYou, PERSONALIZATION_LIMITS.aboutYou),
    customInstructions: normalizeText(
      raw.customInstructions,
      PERSONALIZATION_LIMITS.customInstructions,
    ),
    memories,
    updatedAt,
  };
}

function readPersonalization(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || parsed.version !== 1) return defaultPersonalization();
    return sanitizePersonalization(parsed);
  } catch {
    return defaultPersonalization();
  }
}

function writePersonalization(filePath, next) {
  const sanitized = sanitizePersonalization(next, { stampUpdatedAt: true });
  writePrivateFileAtomic(filePath, `${JSON.stringify(sanitized, null, 2)}\n`);
  return sanitized;
}

function createPersonalizationStore(filePath) {
  return {
    filePath,
    read() {
      return readPersonalization(filePath);
    },
    save(next) {
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        throw new Error("Personalization settings must be a JSON object");
      }
      return writePersonalization(filePath, next);
    },
  };
}

module.exports = {
  DEFAULT_PERSONALIZATION,
  PERSONALIZATION_LIMITS,
  VALID_PERSONALIZATION_TONES,
  createPersonalizationStore,
  readPersonalization,
  sanitizePersonalization,
  writePersonalization,
};
