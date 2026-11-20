const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const DEFAULT_USAGE_SETTINGS = Object.freeze({
  version: 1,
  showChatFooter: false,
  updatedAt: null,
});

const VALID_RANGES = new Set(["today", "7d", "30d", "all"]);
const MAX_RECENT_TURNS = 50;

function defaultUsageSettings() {
  return { ...DEFAULT_USAGE_SETTINGS };
}

function sanitizeUsageSettings(raw, { stampUpdatedAt = false } = {}) {
  const defaults = defaultUsageSettings();
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
    showChatFooter: raw.showChatFooter === true,
    updatedAt,
  };
}

function readUsageSettings(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || parsed.version !== 1) return defaultUsageSettings();
    return sanitizeUsageSettings(parsed);
  } catch {
    return defaultUsageSettings();
  }
}

function writeUsageSettings(filePath, next) {
  const sanitized = sanitizeUsageSettings(next, { stampUpdatedAt: true });
  writePrivateFileAtomic(filePath, `${JSON.stringify(sanitized, null, 2)}\n`);
  return sanitized;
}

function readUsageHistory(historyFilePath) {
  if (!historyFilePath || !fs.existsSync(historyFilePath)) return [];
  try {
    const raw = fs.readFileSync(historyFilePath, "utf8");
    const items = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== "object") continue;
        if (typeof parsed.timestamp !== "string" || typeof parsed.totalTokens !== "number") continue;
        items.push(parsed);
      } catch {
        // Ignore malformed line
      }
    }
    return items;
  } catch {
    return [];
  }
}

function resolveRangeCutoffMs(range, now = new Date()) {
  if (range === "today") {
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    return startOfDay.getTime();
  }
  if (range === "7d") {
    return now.getTime() - 7 * 24 * 60 * 60 * 1000;
  }
  if (range === "30d") {
    return now.getTime() - 30 * 24 * 60 * 60 * 1000;
  }
  return null;
}

function aggregateGroup(map, key, record) {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = {
      key,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalDurationMs: 0,
      lastContextTokens: null,
      lastTimestamp: "",
    };
    map.set(key, bucket);
  }
  bucket.turns += 1;
  bucket.inputTokens += Math.max(0, Number(record.inputTokens) || 0);
  bucket.outputTokens += Math.max(0, Number(record.outputTokens) || 0);
  bucket.totalTokens += Math.max(0, Number(record.totalTokens) || 0);
  bucket.totalDurationMs += Math.max(0, Number(record.durationMs) || 0);
  if (typeof record.contextTokens === "number" && record.contextTokens > 0) {
    bucket.lastContextTokens = record.contextTokens;
  }
  if (record.timestamp >= bucket.lastTimestamp) {
    bucket.lastTimestamp = record.timestamp;
  }
}

function summarizeUsageRecords(records, range = "today", now = new Date()) {
  const safeRange = VALID_RANGES.has(range) ? range : "today";
  const cutoffMs = resolveRangeCutoffMs(safeRange, now);

  const filtered = records.filter((record) => {
    if (cutoffMs === null) return true;
    const ts = Date.parse(record.timestamp);
    return Number.isFinite(ts) && ts >= cutoffMs;
  });

  const totals = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    avgDurationMs: 0,
    lastContextTokens: null,
  };
  let totalDurationMs = 0;

  const providerMap = new Map();
  const modelMap = new Map();

  for (const record of filtered) {
    const inTok = Math.max(0, Number(record.inputTokens) || 0);
    const outTok = Math.max(0, Number(record.outputTokens) || 0);
    const totalTok = Math.max(0, Number(record.totalTokens) || inTok + outTok);
    const durMs = Math.max(0, Number(record.durationMs) || 0);

    totals.turns += 1;
    totals.inputTokens += inTok;
    totals.outputTokens += outTok;
    totals.totalTokens += totalTok;
    totalDurationMs += durMs;
    if (typeof record.contextTokens === "number" && record.contextTokens > 0) {
      totals.lastContextTokens = record.contextTokens;
    }

    const providerId = typeof record.providerId === "string" && record.providerId.trim()
      ? record.providerId.trim()
      : "unknown";
    const modelId = typeof record.modelId === "string" && record.modelId.trim()
      ? record.modelId.trim()
      : providerId;

    aggregateGroup(providerMap, providerId, record);
    aggregateGroup(modelMap, modelId, { ...record, providerId });
  }

  totals.avgDurationMs = totals.turns > 0 ? Math.round(totalDurationMs / totals.turns) : 0;

  const sortByTokensDesc = (a, b) => b.totalTokens - a.totalTokens || b.turns - a.turns;
  const byProvider = [...providerMap.values()].sort(sortByTokensDesc);
  const byModel = [...modelMap.values()].sort(sortByTokensDesc);
  const recentTurns = [...filtered].reverse().slice(0, MAX_RECENT_TURNS);

  return {
    range: safeRange,
    totals,
    byProvider,
    byModel,
    recentTurns,
  };
}

function createUsageStore(settingsFilePath, historyFilePath) {
  return {
    settingsFilePath,
    historyFilePath,
    read(range = "today") {
      const settings = readUsageSettings(settingsFilePath);
      const records = readUsageHistory(historyFilePath);
      const summary = summarizeUsageRecords(records, range);
      return { settings, summary };
    },
    saveSettings(next, range = "today") {
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        throw new Error("Usage settings must be a JSON object");
      }
      const settings = writeUsageSettings(settingsFilePath, next);
      const records = readUsageHistory(historyFilePath);
      const summary = summarizeUsageRecords(records, range);
      return { settings, summary };
    },
    clearHistory(range = "today") {
      try {
        if (historyFilePath && fs.existsSync(historyFilePath)) {
          fs.unlinkSync(historyFilePath);
        }
      } catch {
        // Ignore if already removed
      }
      const settings = readUsageSettings(settingsFilePath);
      const summary = summarizeUsageRecords([], range);
      return { settings, summary };
    },
  };
}

module.exports = {
  DEFAULT_USAGE_SETTINGS,
  createUsageStore,
  readUsageHistory,
  readUsageSettings,
  sanitizeUsageSettings,
  summarizeUsageRecords,
  writeUsageSettings,
};
