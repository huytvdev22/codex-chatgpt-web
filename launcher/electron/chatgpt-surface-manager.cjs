const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const CHATGPT_HOME_URL = "https://chatgpt.com/";
const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
const CHATGPT_ORIGIN = "https://chatgpt.com";
const CHATGPT_CONVERSATION_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;
const MAX_CHATGPT_SURFACES = 3;
const STORE_VERSION = 1;
const MAX_PERSISTED_CHATGPT_BINDINGS = 256;

function normalizeChatGptConversationId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return CHATGPT_CONVERSATION_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function chatGptConversationUrl(conversationId) {
  const normalized = normalizeChatGptConversationId(conversationId);
  if (!normalized) throw new Error("ChatGPT conversation id is invalid");
  return `https://chatgpt.com/c/${normalized}`;
}

function parseChatGptConversationId(rawUrl) {
  let url;
  try { url = new URL(rawUrl); }
  catch { return null; }
  if (!url.hostname.includes("chatgpt.com") || url.username || url.password) return null;
  const match = url.pathname.match(/^\/c\/([a-zA-Z0-9_-]+)\/?$/i);
  return normalizeChatGptConversationId(match?.[1]);
}

class ChatGptConversationStore {
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
        const conversationId = normalizeChatGptConversationId(binding?.conversationId);
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
      throw new Error("ChatGPT conversation key is invalid");
    }
    const normalized = normalizeChatGptConversationId(conversationId);
    if (!normalized) throw new Error("ChatGPT conversation id is invalid");
    this.bindings.set(conversationKey, { conversationId: normalized, lastUsedAt: Date.now() });
    while (this.bindings.size > MAX_PERSISTED_CHATGPT_BINDINGS) {
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
 * Quản lý riêng policy và persistent binding của ChatGPT Web.
 * Điều phối mapping conversationKey (từ Codex thread) sang ChatGPT conversation URL (/c/<id>).
 */
class ChatGptSurfaceManager {
  constructor({ descriptorPath, getUseSavedChats }) {
    this.store = new ChatGptConversationStore(
      path.join(path.dirname(descriptorPath), "chatgpt-conversations.json"),
    );
    this.getUseSavedChats = typeof getUseSavedChats === "function" ? getUseSavedChats : () => false;
  }

  conversationId(conversationKey) {
    return conversationKey ? this.store.get(conversationKey)?.conversationId || null : null;
  }

  initialUrl(conversationKey) {
    if (!this.getUseSavedChats()) {
      return CHATGPT_TEMPORARY_CHAT_URL;
    }
    const conversationId = this.conversationId(conversationKey);
    return conversationId ? chatGptConversationUrl(conversationId) : CHATGPT_HOME_URL;
  }

  bind(conversationKey, conversationId) {
    return this.store.bind(conversationKey, conversationId);
  }

  prepareAllocation(turnTabs, conversationKey, removeTab) {
    const tabs = [...turnTabs.values()].filter(tab => (tab.provider || "chatgpt") === "chatgpt");
    if (tabs.some(tab => tab.conversationKey === conversationKey)) return;

    const limit = MAX_CHATGPT_SURFACES;
    while (tabs.length >= limit) {
      const reclaimable = tabs
        .filter(tab => tab.status === "ready")
        .sort((left, right) => (left.lastHeartbeatAt || 0) - (right.lastHeartbeatAt || 0))[0];
      if (!reclaimable) {
        throw new Error(`ChatGPT Web already has ${limit} active conversation surfaces`);
      }
      removeTab(reclaimable);
      tabs.splice(tabs.indexOf(reclaimable), 1);
    }
  }
}

module.exports = {
  MAX_CHATGPT_SURFACES,
  CHATGPT_HOME_URL,
  CHATGPT_TEMPORARY_CHAT_URL,
  ChatGptConversationStore,
  ChatGptSurfaceManager,
  chatGptConversationUrl,
  normalizeChatGptConversationId,
  parseChatGptConversationId,
};
