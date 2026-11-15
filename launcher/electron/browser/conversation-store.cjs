const fs = require("node:fs");
const { writePrivateFileAtomic } = require("../infra/atomic-file.cjs");

const STORE_VERSION = 1;
const DEFAULT_MAX_PERSISTED_BINDINGS = 256;
const CONVERSATION_KEY_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Lưu trữ bền vững ánh xạ conversationKey -> conversationId theo cơ chế LRU,
 * ghi nguyên tử qua writePrivateFileAtomic. Dùng chung cho mọi BrowserProvider.
 */
class ConversationStore {
  constructor({
    filePath = null,
    providerLabel = "Conversation",
    normalizeId,
    maxBindings = DEFAULT_MAX_PERSISTED_BINDINGS,
  }) {
    if (typeof normalizeId !== "function") {
      throw new Error("ConversationStore requires a normalizeId function");
    }
    if (!Number.isInteger(maxBindings) || maxBindings < 1) {
      throw new Error("ConversationStore maxBindings must be a positive integer");
    }
    this.filePath = filePath || null;
    this.providerLabel = providerLabel;
    this.normalizeId = normalizeId;
    this.maxBindings = maxBindings;
    this.bindings = new Map();
    if (this.filePath) this.load();
  }

  load() {
    if (!this.filePath) return;
    try {
      const decoded = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (decoded?.version !== STORE_VERSION || !decoded.bindings || typeof decoded.bindings !== "object") {
        return;
      }
      for (const [conversationKey, binding] of Object.entries(decoded.bindings)) {
        const conversationId = this.normalizeId(binding?.conversationId);
        if (!CONVERSATION_KEY_PATTERN.test(conversationKey) || !conversationId) continue;
        this.bindings.set(conversationKey, {
          conversationId,
          lastUsedAt: Number.isFinite(binding.lastUsedAt) ? binding.lastUsedAt : 0,
        });
      }
      this.evictOverflow();
    } catch {}
  }

  write() {
    if (!this.filePath) return;
    const bindings = Object.fromEntries(
      [...this.bindings.entries()].map(([key, value]) => [key, value]),
    );
    writePrivateFileAtomic(
      this.filePath,
      `${JSON.stringify({ version: STORE_VERSION, bindings }, null, 2)}\n`,
    );
  }

  get(conversationKey) {
    if (typeof conversationKey !== "string") return null;
    const binding = this.bindings.get(conversationKey);
    return binding ? { ...binding } : null;
  }

  bind(conversationKey, conversationId) {
    if (typeof conversationKey !== "string" || !CONVERSATION_KEY_PATTERN.test(conversationKey)) {
      throw new Error(`${this.providerLabel} conversation key is invalid`);
    }
    const normalized = this.normalizeId(conversationId);
    if (!normalized) {
      throw new Error(`${this.providerLabel} conversation id is invalid`);
    }
    this.bindings.set(conversationKey, { conversationId: normalized, lastUsedAt: Date.now() });
    this.evictOverflow();
    this.write();
    return normalized;
  }

  delete(conversationKey) {
    if (!this.bindings.delete(conversationKey)) return false;
    this.write();
    return true;
  }

  get size() {
    return this.bindings.size;
  }

  evictOverflow() {
    while (this.bindings.size > this.maxBindings) {
      const oldest = [...this.bindings.entries()]
        .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
      if (!oldest) break;
      this.bindings.delete(oldest[0]);
    }
  }
}

module.exports = {
  CONVERSATION_KEY_PATTERN,
  ConversationStore,
  DEFAULT_MAX_PERSISTED_BINDINGS,
  STORE_VERSION,
};

