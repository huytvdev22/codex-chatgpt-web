const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const GEMINI_HOME_URL = "https://gemini.google.com/app";
const MAX_GEMINI_SURFACES = 3;
const MAX_STORED_GEMINI_CONVERSATIONS = 256;
const CONVERSATION_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const GEMINI_CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function normalizeConversationKey(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return CONVERSATION_KEY_PATTERN.test(trimmed) ? trimmed : null;
}

function normalizeGeminiConversationId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!GEMINI_CONVERSATION_ID_PATTERN.test(trimmed)) return null;
  if (["app", "undefined", "null", "new"].includes(trimmed.toLowerCase())) return null;
  return trimmed;
}

function parseGeminiConversationId(rawUrl) {
  if (typeof rawUrl !== "string") return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname !== "gemini.google.com") return null;
    const match = /^\/app\/([A-Za-z0-9_-]{8,128})(?:\/|$)/.exec(parsed.pathname);
    return match ? normalizeGeminiConversationId(match[1]) : null;
  } catch {
    return null;
  }
}

function geminiConversationUrl(conversationId) {
  const normalized = normalizeGeminiConversationId(conversationId);
  if (!normalized) throw new Error("Gemini conversation id is invalid");
  return `https://gemini.google.com/app/${encodeURIComponent(normalized)}`;
}

function defaultRegistryPath(descriptorPath) {
  if (typeof descriptorPath !== "string" || !descriptorPath.trim()) return null;
  return path.join(path.dirname(descriptorPath), "gemini-conversations.json");
}

class GeminiSurfaceManager {
  constructor({
    descriptorPath = null,
    registryPath = defaultRegistryPath(descriptorPath),
    maxSurfaces = MAX_GEMINI_SURFACES,
    now = () => Date.now(),
  } = {}) {
    this.registryPath = registryPath;
    this.maxSurfaces = maxSurfaces;
    this.now = now;
    this.records = new Map();
    this.load();
  }

  load() {
    this.records.clear();
    if (!this.registryPath || !fs.existsSync(this.registryPath)) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.registryPath, "utf8"));
    } catch {
      return;
    }
    const entries = parsed && typeof parsed === "object" && parsed.conversations && typeof parsed.conversations === "object"
      ? Object.entries(parsed.conversations)
      : [];
    for (const [rawKey, value] of entries) {
      const key = normalizeConversationKey(rawKey);
      const conversationId = normalizeGeminiConversationId(value?.conversationId);
      if (!key || !conversationId) continue;
      const updatedAt = typeof value?.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString();
      this.records.set(key, {
        conversationId,
        url: geminiConversationUrl(conversationId),
        updatedAt,
      });
    }
    this.trimRecords();
  }

  save() {
    this.trimRecords();
    if (!this.registryPath) return;
    const conversations = {};
    for (const [key, record] of this.records.entries()) {
      conversations[key] = {
        conversationId: record.conversationId,
        url: record.url,
        updatedAt: record.updatedAt,
      };
    }
    writePrivateFileAtomic(this.registryPath, `${JSON.stringify({
      version: 1,
      conversations,
    }, null, 2)}\n`);
  }

  trimRecords() {
    while (this.records.size > MAX_STORED_GEMINI_CONVERSATIONS) {
      const oldest = [...this.records.entries()]
        .sort((left, right) => Date.parse(left[1].updatedAt || "") - Date.parse(right[1].updatedAt || ""))[0];
      if (!oldest) break;
      this.records.delete(oldest[0]);
    }
  }

  get(conversationKey) {
    const key = normalizeConversationKey(conversationKey);
    if (!key) return null;
    return this.records.get(key) || null;
  }

  conversationId(conversationKey) {
    return this.get(conversationKey)?.conversationId || null;
  }

  initialUrl(conversationKey) {
    return this.get(conversationKey)?.url || GEMINI_HOME_URL;
  }

  bind(conversationKey, conversationId) {
    const key = normalizeConversationKey(conversationKey);
    const normalizedId = normalizeGeminiConversationId(conversationId);
    if (!key) throw new Error("Gemini conversation binding requires a valid conversationKey");
    if (!normalizedId) throw new Error("Gemini conversation binding requires a valid conversationId");
    const updatedAt = new Date(this.now()).toISOString();
    const record = {
      conversationId: normalizedId,
      url: geminiConversationUrl(normalizedId),
      updatedAt,
    };
    this.records.delete(key);
    this.records.set(key, record);
    this.save();
    return normalizedId;
  }

  geminiTabs(turnTabs) {
    return [...(turnTabs?.values?.() || [])].filter(tab => tab?.provider === "gemini");
  }

  evictOldestRetainedTab(turnTabs, removeTab) {
    const candidate = this.geminiTabs(turnTabs)
      .filter(tab => tab.status === "ready")
      .sort((left, right) => (left.lastHeartbeatAt ?? 0) - (right.lastHeartbeatAt ?? 0))[0];
    if (!candidate) return false;
    removeTab(candidate);
    return true;
  }

  prepareAllocation(turnTabs, conversationKey, removeTab) {
    const key = normalizeConversationKey(conversationKey);
    const existing = key
      ? this.geminiTabs(turnTabs).find(tab => tab.status === "ready" && tab.conversationKey === key)
      : null;
    if (existing) return existing;
    for (const reclaimable of this.geminiTabs(turnTabs).filter(tab => tab.status === "ready" && tab.interactionMode !== "manual")) {
      removeTab(reclaimable);
    }
    while (this.geminiTabs(turnTabs).length >= this.maxSurfaces) {
      if (!this.evictOldestRetainedTab(turnTabs, removeTab)) {
        throw new Error(
          `Google Gemini already has ${this.maxSurfaces} active browser tabs; wait for one turn to finish before starting another`,
        );
      }
    }
    return null;
  }
}

module.exports = {
  GEMINI_HOME_URL,
  MAX_GEMINI_SURFACES,
  GeminiSurfaceManager,
  geminiConversationUrl,
  normalizeGeminiConversationId,
  parseGeminiConversationId,
};

