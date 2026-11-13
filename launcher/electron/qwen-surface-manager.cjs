const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { processRunning } = require("./process-tree.cjs");

const QWEN_HOME_URL = "https://chat.qwen.ai/";
const QWEN_ORIGIN = "https://chat.qwen.ai";
const QWEN_CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QWEN_SURFACES = 3;
const STORE_VERSION = 1;
const MAX_PERSISTED_QWEN_BINDINGS = 256;

function normalizeQwenConversationId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return QWEN_CONVERSATION_ID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

function qwenConversationUrl(conversationId) {
  const normalized = normalizeQwenConversationId(conversationId);
  if (!normalized) throw new Error("Qwen conversation id is invalid");
  return `https://chat.qwen.ai/c/${normalized}`;
}

function parseQwenConversationId(rawUrl) {
  let url;
  try { url = new URL(rawUrl); }
  catch { return null; }
  if (!url.hostname.includes("chat.qwen.ai") || url.username || url.password) return null;
  const match = url.pathname.match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return normalizeQwenConversationId(match?.[1]);
}

class QwenConversationStore {
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
        const conversationId = normalizeQwenConversationId(binding?.conversationId);
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
      throw new Error("Qwen conversation key is invalid");
    }
    const normalized = normalizeQwenConversationId(conversationId);
    if (!normalized) throw new Error("Qwen conversation id is invalid");
    this.bindings.set(conversationKey, { conversationId: normalized, lastUsedAt: Date.now() });
    while (this.bindings.size > MAX_PERSISTED_QWEN_BINDINGS) {
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
 * Quản lý riêng policy và persistent binding của Qwen Web.
 * Điều phối mapping conversationKey sang Qwen conversation URL (/c/<uuid>).
 */
class QwenSurfaceManager {
  constructor({ descriptorPath, maxSurfaces = MAX_QWEN_SURFACES } = {}) {
    this.maxSurfaces = maxSurfaces;
    this.store = new QwenConversationStore(
      path.join(path.dirname(descriptorPath), "qwen-conversations.json"),
    );
  }

  conversationId(conversationKey) {
    return conversationKey ? this.store.get(conversationKey)?.conversationId || null : null;
  }

  initialUrl(conversationKey) {
    const conversationId = this.conversationId(conversationKey);
    return conversationId ? qwenConversationUrl(conversationId) : QWEN_HOME_URL;
  }

  bind(conversationKey, conversationId) {
    return this.store.bind(conversationKey, conversationId);
  }

  qwenTabs(turnTabs) {
    return [...(turnTabs?.values?.() || [])].filter(tab => tab?.provider === "qwen");
  }

  evictOldestRetainedTab(turnTabs, removeTab) {
    const candidate = this.qwenTabs(turnTabs)
      .filter(tab => tab.status === "ready")
      .sort((left, right) => (left.lastHeartbeatAt ?? 0) - (right.lastHeartbeatAt ?? 0))[0];
    if (!candidate) return false;
    removeTab(candidate);
    return true;
  }

  prepareAllocation(turnTabs, conversationKey, removeTab) {
    const tabs = this.qwenTabs(turnTabs);

    // 1. Dọn dẹp tab trùng lặp của cùng conversationKey:
    // prepareAllocation chỉ được gọi khi beginTurn KHÔNG tái sử dụng được tab cũ.
    // Nếu tab cũ đang running và helper process vẫn sống -> xung đột lượt chạy đồng thời.
    // Nếu tab cũ là ready, error, aborted hoặc orphan running -> đóng ngay để không tích tụ tab thừa.
    if (conversationKey) {
      const existingSameKey = tabs.filter(tab => tab.conversationKey === conversationKey);
      for (const tab of existingSameKey) {
        if (tab.status === "running" && tab.helperPid && processRunning(tab.helperPid)) {
          throw new Error("Qwen Web conversation is currently active with another turn; wait for it to complete");
        }
        removeTab(tab);
        const idx = tabs.indexOf(tab);
        if (idx !== -1) tabs.splice(idx, 1);
      }
    }

    // 2. Dọn dẹp bất kỳ tab Qwen nào bị lỗi hoặc bị hủy (error/aborted)
    for (const dead of tabs.filter(tab => tab.status === "error" || tab.status === "aborted")) {
      removeTab(dead);
      const idx = tabs.indexOf(dead);
      if (idx !== -1) tabs.splice(idx, 1);
    }

    // 3. Đảm bảo tổng số tab Qwen không vượt quá maxSurfaces (3)
    const limit = this.maxSurfaces;
    while (tabs.length >= limit) {
      const reclaimable = tabs
        .filter(tab => tab.status === "ready" && tab.interactionMode !== "manual")
        .sort((left, right) => (left.lastHeartbeatAt || 0) - (right.lastHeartbeatAt || 0))[0];
      if (!reclaimable) {
        throw new Error(`Qwen Web already has ${limit} active conversation surfaces`);
      }
      removeTab(reclaimable);
      const idx = tabs.indexOf(reclaimable);
      if (idx !== -1) tabs.splice(idx, 1);
    }
  }
}

module.exports = {
  MAX_QWEN_SURFACES,
  QWEN_HOME_URL,
  QwenConversationStore,
  QwenSurfaceManager,
  qwenConversationUrl,
  normalizeQwenConversationId,
  parseQwenConversationId,
};
