const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { processRunning } = require("./process-tree.cjs");

const QWEN_HOME_URL = "https://chat.qwen.ai/";
const QWEN_ORIGIN = "https://chat.qwen.ai";
const QWEN_CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QWEN_SURFACES = 3;
// Worker chỉ gửi heartbeat trong lúc chờ phản hồi; các bước chọn model/gõ prompt
// có thể kéo dài, nên ngưỡng stale phải đủ rộng (Launcher reaper dùng 60s/120s).
const STALE_TURN_HEARTBEAT_MS = 90_000;
// Phải nhỏ hơn LAUNCHER_TURN_START_TIMEOUT_MS (30s) phía runtime.
const ACTIVE_TURN_WAIT_MS = 20_000;
const ACTIVE_TURN_POLL_MS = 250;
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
  constructor({
    descriptorPath,
    maxSurfaces = MAX_QWEN_SURFACES,
    staleTurnHeartbeatMs = STALE_TURN_HEARTBEAT_MS,
    activeTurnWaitMs = ACTIVE_TURN_WAIT_MS,
    activeTurnPollMs = ACTIVE_TURN_POLL_MS,
  } = {}) {
    this.maxSurfaces = maxSurfaces;
    this.staleTurnHeartbeatMs = staleTurnHeartbeatMs;
    this.activeTurnWaitMs = activeTurnWaitMs;
    this.activeTurnPollMs = activeTurnPollMs;
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

  /**
   * Tab đang thực sự chạy một lượt khác: status running, helper còn sống
   * và heartbeat chưa quá hạn. Tab running nhưng heartbeat quá hạn là orphan
   * (bun server phục vụ nhiều lượt tuần tự nên process.pid luôn sống).
   */
  isLiveRunningTab(tab, now = Date.now()) {
    return tab?.status === "running"
      && Boolean(tab.helperPid)
      && processRunning(tab.helperPid)
      && now - (tab.lastHeartbeatAt ?? 0) < this.staleTurnHeartbeatMs;
  }

  activeTurnFor(turnTabs, conversationKey, traceId) {
    if (!conversationKey) return null;
    return this.qwenTabs(turnTabs).find(tab => (
      tab.conversationKey === conversationKey
      && tab.traceId !== traceId
      && this.isLiveRunningTab(tab)
    )) || null;
  }

  /**
   * Khi Codex gửi lại request (vd. sau khi stream bị ngắt) trong lúc lượt cũ
   * của cùng conversation còn đang dọn dẹp, chờ có giới hạn để lượt cũ gửi
   * phase=end rồi tái sử dụng tab đó, thay vì từ chối ngay hoặc mở tab trùng.
   */
  async waitForActiveTurn(turnTabs, conversationKey, traceId, signal) {
    const deadline = Date.now() + this.activeTurnWaitMs;
    while (this.activeTurnFor(turnTabs, conversationKey, traceId)) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, this.activeTurnPollMs));
    }
    return true;
  }

  prepareAllocation(turnTabs, conversationKey, removeTab) {
    const tabs = this.qwenTabs(turnTabs);

    // 1. Dọn dẹp tab trùng lặp của cùng conversationKey:
    // prepareAllocation chỉ được gọi khi beginTurn KHÔNG tái sử dụng được tab cũ.
    // Nếu tab cũ đang running VÀ helper process vẫn sống VÀ heartbeat gần đây
    //   -> xung đột lượt chạy đồng thời, từ chối.
    // Nếu tab cũ running nhưng heartbeat đã quá hạn (stale) -> tab orphaned
    //   (do endTurn thất bại âm thầm mà bun server vẫn sống) -> đóng ngay.
    // Nếu tab cũ là ready, error, aborted hoặc orphan running -> đóng ngay.
    if (conversationKey) {
      const existingSameKey = tabs.filter(tab => tab.conversationKey === conversationKey);
      for (const tab of existingSameKey) {
        if (this.isLiveRunningTab(tab)) {
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
  STALE_TURN_HEARTBEAT_MS,
  ACTIVE_TURN_WAIT_MS,
  QWEN_HOME_URL,
  QwenConversationStore,
  QwenSurfaceManager,
  qwenConversationUrl,
  normalizeQwenConversationId,
  parseQwenConversationId,
};
