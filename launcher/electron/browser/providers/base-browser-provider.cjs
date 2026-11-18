const path = require("node:path");
const { ConversationStore } = require("../conversation-store.cjs");

/**
 * Lớp cơ sở trừu tượng (Abstract Class - Template Method pattern) cho mọi
 * Browser Provider (hiện tại: M365 Copilot; sau này: ChatGPT Web, Claude, ...).
 *
 * Lớp này sở hữu các cấu hình chuẩn, quản lý ConversationStore, giới hạn số
 * lượng surface và điều phối các hook vòng đời cho BrowserHost.
 */
class BaseBrowserProvider {
  constructor({
    id,
    displayName,
    homeUrl,
    origin,
    partition,
    maxSurfaces = 3,
    maxPersistedBindings = 256,
    smokeTitle = null,
    descriptorPath = null,
  } = {}) {
    if (new.target === BaseBrowserProvider) {
      throw new Error("BaseBrowserProvider is abstract and cannot be instantiated directly");
    }
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("Browser provider requires a non-empty id");
    }
    if (typeof displayName !== "string" || !displayName.trim()) {
      throw new Error(`Browser provider "${id}" requires a displayName`);
    }
    if (typeof homeUrl !== "string" || !homeUrl.trim()) {
      throw new Error(`Browser provider "${id}" requires a homeUrl`);
    }
    if (typeof origin !== "string" || !origin.trim()) {
      throw new Error(`Browser provider "${id}" requires an origin`);
    }
    if (typeof partition !== "string" || !partition.trim()) {
      throw new Error(`Browser provider "${id}" requires a partition`);
    }
    this.id = id;
    this.displayName = displayName;
    this.homeUrl = homeUrl;
    this.origin = origin;
    this.partition = partition;
    this.maxSurfaces = maxSurfaces;
    this.maxPersistedBindings = maxPersistedBindings;
    this.smokeTitle = smokeTitle || displayName;
    this.store = null;
    if (descriptorPath) {
      this.initStore(descriptorPath);
    }
  }

  storePathForDescriptor(descriptorPath) {
    return path.join(path.dirname(descriptorPath), `${this.id}-conversations.json`);
  }

  initStore(descriptorPath = null) {
    const filePath = descriptorPath ? this.storePathForDescriptor(descriptorPath) : null;
    this.store = new ConversationStore({
      filePath,
      providerLabel: this.displayName,
      normalizeId: value => this.normalizeConversationId(value),
      maxBindings: this.maxPersistedBindings,
    });
    return this.store;
  }

  ensureStore() {
    if (!this.store) {
      this.initStore(null);
    }
    return this.store;
  }

  conversationId(conversationKey) {
    return conversationKey ? this.ensureStore().get(conversationKey)?.conversationId || null : null;
  }

  initialUrl(conversationKey) {
    const conversationId = this.conversationId(conversationKey);
    return conversationId ? this.conversationUrl(conversationId) : this.homeUrl;
  }

  bind(conversationKey, conversationId) {
    return this.ensureStore().bind(conversationKey, conversationId);
  }

  prepareAllocation(turnTabs, conversationKey, removeTab) {
    const tabs = [...turnTabs.values()].filter(tab => (tab.provider || this.id) === this.id);
    if (tabs.some(tab => tab.conversationKey === conversationKey)) return;

    const limit = this.maxSurfaces;
    while (tabs.length >= limit) {
      const reclaimable = tabs
        .filter(tab => tab.status === "ready")
        .sort((left, right) => (left.lastHeartbeatAt || 0) - (right.lastHeartbeatAt || 0))[0];
      if (!reclaimable) {
        throw new Error(`${this.displayName} already has ${limit} active conversation surfaces`);
      }
      removeTab(reclaimable);
      tabs.splice(tabs.indexOf(reclaimable), 1);
    }
  }

  markOwnedSurface(contents, options) {
    return this.markTurnSurface(contents, options);
  }

  bindTurnContents(contents, handlers) {
    return this.onBindTurnContents(contents, handlers);
  }

  // --- Abstract methods: subclass MUST override ---

  normalizeConversationId(_value) {
    throw new Error(`Method "normalizeConversationId" must be implemented by ${this.constructor.name}`);
  }

  conversationUrl(_conversationId) {
    throw new Error(`Method "conversationUrl" must be implemented by ${this.constructor.name}`);
  }

  parseConversationId(_rawUrl) {
    throw new Error(`Method "parseConversationId" must be implemented by ${this.constructor.name}`);
  }

  isAllowedNavigation(_rawUrl) {
    throw new Error(`Method "isAllowedNavigation" must be implemented by ${this.constructor.name}`);
  }

  async probeAuthentication(_contents) {
    throw new Error(`Method "probeAuthentication" must be implemented by ${this.constructor.name}`);
  }

  markTurnSurface(_contents, _options) {
    throw new Error(`Method "markTurnSurface" must be implemented by ${this.constructor.name}`);
  }

  // --- Optional lifecycle hooks: subclass MAY override ---

  getFallbackTitle() {
    return this.displayName;
  }

  isAuthCookieDomain(_domain) {
    return false;
  }

  isAuthOrAppUrl(value) {
    return typeof value === "string" && value.includes(this.origin);
  }

  allowedAuthUrl(rawUrl) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return false;
    }
    if (parsed.protocol !== "https:") return false;
    try {
      const originHost = new URL(this.origin).hostname;
      return parsed.hostname === originHost || parsed.hostname.endsWith(`.${originHost}`);
    } catch {
      return false;
    }
  }

  isAcceptableControlConversationId(conversationId) {
    return Boolean(this.normalizeConversationId(conversationId));
  }

  onPrimarySessionCreated(_browserSession, _host) {}

  onPrimaryContentsBound(_contents, _host) {}

  onBindTurnContents(_contents, _handlers) {}

  async waitForAuthenticationSettle(_contents, _timeoutMs) {}

  async runSmokeTest(_context) {
    throw new Error(`Smoke test is not supported for browser provider "${this.id}"`);
  }
}

/**
 * Chuẩn hóa User-Agent của Electron thành Chrome thuần để tránh bị dịch vụ web chặn.
 */
function sanitizeChromeUserAgent(userAgent) {
  if (typeof userAgent !== "string") return "";
  return userAgent
    .replace(/(\(KHTML,\s*like Gecko\))\s+(?:[^\s]+\s+)*?(Chrome\/[^\s]+)/i, "$1 $2")
    .replace(/\s*Electron\/[^\s]+/gi, "")
    .replace(/\s*Codex[^\s]*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

module.exports = { BaseBrowserProvider, sanitizeChromeUserAgent };

