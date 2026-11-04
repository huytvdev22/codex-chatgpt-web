const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const GOOGLE_AI_STUDIO_HOME_URL = "https://aistudio.google.com/u/0/prompts/new_chat?model=gemini-flash-latest";
const MAX_GOOGLE_AI_STUDIO_SURFACES = 3;
const MAX_STORED_CONVERSATIONS = 256;
const CONVERSATION_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const PROMPT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function normalizeConversationKey(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return CONVERSATION_KEY_PATTERN.test(trimmed) ? trimmed : null;
}

function normalizeGoogleAIStudioPromptId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!PROMPT_ID_PATTERN.test(trimmed)) return null;
  if (["new_chat", "undefined", "null", "new"].includes(trimmed.toLowerCase())) return null;
  return trimmed;
}

function parseGoogleAIStudioPromptId(rawUrl) {
  if (typeof rawUrl !== "string") return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname !== "aistudio.google.com") return null;
    const match = /^\/u\/\d+\/prompts\/([A-Za-z0-9_-]{8,128})(?:\/|$)/.exec(parsed.pathname)
      || /^\/prompts\/([A-Za-z0-9_-]{8,128})(?:\/|$)/.exec(parsed.pathname);
    return match ? normalizeGoogleAIStudioPromptId(match[1]) : null;
  } catch {
    return null;
  }
}

function googleAIStudioPromptUrl(promptId) {
  const normalized = normalizeGoogleAIStudioPromptId(promptId);
  if (!normalized) throw new Error("Google AI Studio prompt id is invalid");
  return `https://aistudio.google.com/u/0/prompts/${encodeURIComponent(normalized)}`;
}

function defaultRegistryPath(descriptorPath) {
  if (typeof descriptorPath !== "string" || !descriptorPath.trim()) return null;
  return path.join(path.dirname(descriptorPath), "google-ai-studio-conversations.json");
}

class GoogleAIStudioSurfaceManager {
  constructor({
    descriptorPath = null,
    registryPath = defaultRegistryPath(descriptorPath),
    maxSurfaces = MAX_GOOGLE_AI_STUDIO_SURFACES,
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
      const conversationId = normalizeGoogleAIStudioPromptId(value?.conversationId || value?.promptId);
      if (!key || !conversationId) continue;
      const updatedAt = typeof value?.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString();
      this.records.set(key, {
        conversationId,
        url: googleAIStudioPromptUrl(conversationId),
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
    while (this.records.size > MAX_STORED_CONVERSATIONS) {
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
    const record = this.get(conversationKey);
    if (record && record.conversationId && parseGoogleAIStudioPromptId(record.url)) {
      return record.url;
    }
    return GOOGLE_AI_STUDIO_HOME_URL;
  }

  bind(conversationKey, conversationId) {
    const key = normalizeConversationKey(conversationKey);
    const normalizedId = normalizeGoogleAIStudioPromptId(conversationId);
    if (!key) throw new Error("Google AI Studio prompt binding requires a valid conversationKey");
    if (!normalizedId) throw new Error("Google AI Studio prompt binding requires a valid conversationId");
    const updatedAt = new Date(this.now()).toISOString();
    const record = {
      conversationId: normalizedId,
      url: googleAIStudioPromptUrl(normalizedId),
      updatedAt,
    };
    this.records.delete(key);
    this.records.set(key, record);
    this.save();
    return normalizedId;
  }

  googleAIStudioTabs(turnTabs) {
    return [...(turnTabs?.values?.() || [])].filter(tab => tab?.provider === "google-ai-studio");
  }

  evictOldestRetainedTab(turnTabs, removeTab) {
    const candidate = this.googleAIStudioTabs(turnTabs)
      .filter(tab => tab.status === "ready")
      .sort((left, right) => (left.lastHeartbeatAt ?? 0) - (right.lastHeartbeatAt ?? 0))[0];
    if (!candidate) return false;
    removeTab(candidate);
    return true;
  }

  prepareAllocation(turnTabs, conversationKey, removeTab) {
    const key = normalizeConversationKey(conversationKey);
    const existing = key
      ? this.googleAIStudioTabs(turnTabs).find(tab => tab.status === "ready" && tab.conversationKey === key)
      : null;
    if (existing) return existing;
    for (const reclaimable of this.googleAIStudioTabs(turnTabs).filter(tab => tab.status === "ready" && tab.interactionMode !== "manual")) {
      removeTab(reclaimable);
    }
    while (this.googleAIStudioTabs(turnTabs).length >= this.maxSurfaces) {
      if (!this.evictOldestRetainedTab(turnTabs, removeTab)) {
        throw new Error(
          `Google AI Studio already has ${this.maxSurfaces} active browser tabs; wait for one turn to finish before starting another`,
        );
      }
    }
    return null;
  }
}

module.exports = {
  GOOGLE_AI_STUDIO_HOME_URL,
  MAX_GOOGLE_AI_STUDIO_SURFACES,
  GoogleAIStudioSurfaceManager,
  googleAIStudioPromptUrl,
  normalizeGoogleAIStudioPromptId,
  parseGoogleAIStudioPromptId,
};

