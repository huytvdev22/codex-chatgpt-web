const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const M365_CHAT_URL = "https://m365.cloud.microsoft/chat";
const M365_ORIGIN = "https://m365.cloud.microsoft";
const M365_CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_M365_SURFACES = 3;
const STORE_VERSION = 1;
const MAX_PERSISTED_M365_BINDINGS = 256;

function normalizeM365ConversationId(value) {
  return typeof value === "string" && M365_CONVERSATION_ID_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

function m365ConversationUrl(conversationId) {
  const normalized = normalizeM365ConversationId(conversationId);
  if (!normalized) throw new Error("M365 conversation id is invalid");
  return `${M365_CHAT_URL}/conversation/${normalized}`;
}

function parseM365ConversationId(rawUrl) {
  let url;
  try { url = new URL(rawUrl); }
  catch { return null; }
  if (url.origin !== M365_ORIGIN || url.username || url.password) return null;
  const match = url.pathname.match(/^\/chat\/conversation\/([^/]+)\/?$/i);
  return normalizeM365ConversationId(match?.[1]);
}

class M365ConversationStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.bindings = new Map();
    this.load();
  }

  load() {
    try {
      const decoded = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (decoded?.version !== STORE_VERSION || !decoded.bindings || typeof decoded.bindings !== "object") return;
      for (const [conversationKey, binding] of Object.entries(decoded.bindings)) {
        const conversationId = normalizeM365ConversationId(binding?.conversationId);
        if (!/^[a-f0-9]{64}$/.test(conversationKey) || !conversationId) continue;
        this.bindings.set(conversationKey, {
          conversationId,
          lastUsedAt: Number.isFinite(binding.lastUsedAt) ? binding.lastUsedAt : 0,
        });
      }
    } catch {}
  }

  write() {
    const bindings = Object.fromEntries(
      [...this.bindings.entries()].map(([key, value]) => [key, value]),
    );
    writePrivateFileAtomic(this.filePath, `${JSON.stringify({ version: STORE_VERSION, bindings }, null, 2)}\n`);
  }

  get(conversationKey) {
    const binding = this.bindings.get(conversationKey);
    return binding ? { ...binding } : null;
  }

  bind(conversationKey, conversationId) {
    if (!/^[a-f0-9]{64}$/.test(conversationKey)) {
      throw new Error("M365 conversation key is invalid");
    }
    const normalized = normalizeM365ConversationId(conversationId);
    if (!normalized) throw new Error("M365 conversation id is invalid");
    this.bindings.set(conversationKey, { conversationId: normalized, lastUsedAt: Date.now() });
    while (this.bindings.size > MAX_PERSISTED_M365_BINDINGS) {
      const oldest = [...this.bindings.entries()]
        .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
      if (!oldest) break;
      this.bindings.delete(oldest[0]);
    }
    this.write();
    return normalized;
  }
}

/**
 * Quản lý riêng policy và persistent binding của M365. BrowserHost chỉ điều phối
 * lifecycle chung, tránh rải nhánh provider-specific xuyên suốt implementation.
 */
class M365SurfaceManager {
  constructor({ descriptorPath }) {
    this.store = new M365ConversationStore(
      path.join(path.dirname(descriptorPath), "m365-conversations.json"),
    );
  }

  conversationId(conversationKey) {
    return conversationKey ? this.store.get(conversationKey)?.conversationId || null : null;
  }

  initialUrl(conversationKey) {
    const conversationId = this.conversationId(conversationKey);
    return conversationId ? m365ConversationUrl(conversationId) : M365_CHAT_URL;
  }

  bind(conversationKey, conversationId) {
    return this.store.bind(conversationKey, conversationId);
  }

  prepareAllocation(turnTabs, conversationKey, removeTab) {
    const tabs = [...turnTabs.values()].filter(tab => tab.provider === "m365");
    if (tabs.some(tab => tab.conversationKey === conversationKey)) return;

    const limit = MAX_M365_SURFACES;
    while (tabs.length >= limit) {
      const reclaimable = tabs
        .filter(tab => tab.status === "ready")
        .sort((left, right) => (left.lastHeartbeatAt || 0) - (right.lastHeartbeatAt || 0))[0];
      if (!reclaimable) {
        throw new Error(`M365 Copilot already has ${limit} active conversation surfaces`);
      }
      removeTab(reclaimable);
      tabs.splice(tabs.indexOf(reclaimable), 1);
    }
  }

}

module.exports = {
  MAX_M365_SURFACES,
  M365_CHAT_URL,
  M365ConversationStore,
  M365SurfaceManager,
  m365ConversationUrl,
  normalizeM365ConversationId,
  parseM365ConversationId,
};
