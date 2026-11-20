const path = require("node:path");
const { ConversationStore } = require("../conversation-store.cjs");

const DEFAULT_PROFILE_ID = "default";
const PROFILE_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/;

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
    supportsProfiles = false,
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
    this.basePartition = partition;
    this.partition = partition;
    this.maxSurfaces = maxSurfaces;
    this.maxPersistedBindings = maxPersistedBindings;
    this.smokeTitle = smokeTitle || displayName;
    this.descriptorPath = descriptorPath || null;
    this.supportsProfiles = supportsProfiles === true;
    this.activeProfileId = DEFAULT_PROFILE_ID;
    this.profiles = [{ id: DEFAULT_PROFILE_ID, name: "Default", authenticated: false }];
    this.store = null;
    this.profileStores = new Map();
    if (descriptorPath) {
      this.initStore(descriptorPath);
    }
  }

  isProfileSupported() {
    return this.supportsProfiles === true;
  }

  getActiveProfileId() {
    return this.supportsProfiles ? this.activeProfileId : DEFAULT_PROFILE_ID;
  }

  getProfiles() {
    return this.profiles.map(item => ({ ...item }));
  }

  partitionForProfile(_profileId = this.activeProfileId) {
    return this.basePartition;
  }

  storePathForDescriptor(descriptorPath) {
    return path.join(path.dirname(descriptorPath), `${this.id}-conversations.json`);
  }

  storePathForProfile(descriptorPath, profileId = DEFAULT_PROFILE_ID) {
    if (!descriptorPath) return null;
    const normalized = typeof profileId === "string" && PROFILE_ID_REGEX.test(profileId)
      ? profileId
      : DEFAULT_PROFILE_ID;
    if (normalized === DEFAULT_PROFILE_ID) {
      return this.storePathForDescriptor(descriptorPath);
    }
    return path.join(path.dirname(descriptorPath), `${this.id}-profile-${normalized}-conversations.json`);
  }

  initStore(descriptorPath = null) {
    this.descriptorPath = descriptorPath || this.descriptorPath;
    const filePath = this.descriptorPath ? this.storePathForDescriptor(this.descriptorPath) : null;
    this.store = new ConversationStore({
      filePath,
      providerLabel: this.displayName,
      normalizeId: value => this.normalizeConversationId(value),
      maxBindings: this.maxPersistedBindings,
    });
    this.profileStores.set(DEFAULT_PROFILE_ID, this.store);
    return this.store;
  }

  ensureStore(profileId = this.activeProfileId) {
    const normalized = this.supportsProfiles && typeof profileId === "string" && PROFILE_ID_REGEX.test(profileId)
      ? profileId
      : DEFAULT_PROFILE_ID;
    if (normalized === DEFAULT_PROFILE_ID) {
      if (!this.store) {
        this.initStore(this.descriptorPath);
      }
      return this.store;
    }
    if (!this.profileStores.has(normalized)) {
      const filePath = this.descriptorPath ? this.storePathForProfile(this.descriptorPath, normalized) : null;
      this.profileStores.set(normalized, new ConversationStore({
        filePath,
        providerLabel: `${this.displayName} (${normalized})`,
        normalizeId: value => this.normalizeConversationId(value),
        maxBindings: this.maxPersistedBindings,
      }));
    }
    return this.profileStores.get(normalized);
  }

  configureProfiles(group) {
    if (!this.supportsProfiles || !group || typeof group !== "object") return;
    const seen = new Set();
    const list = [];
    for (const item of Array.isArray(group.profiles) ? group.profiles : []) {
      const id = typeof item?.id === "string" ? item.id.trim().toLowerCase() : "";
      if (!id || !PROFILE_ID_REGEX.test(id) || seen.has(id)) continue;
      seen.add(id);
      const rawName = typeof item?.name === "string" ? item.name.trim() : "";
      list.push({
        id,
        name: rawName ? rawName.slice(0, 40) : (id === DEFAULT_PROFILE_ID ? "Default" : id),
        authenticated: item?.authenticated === true,
      });
    }
    if (!seen.has(DEFAULT_PROFILE_ID)) {
      list.unshift({ id: DEFAULT_PROFILE_ID, name: "Default", authenticated: false });
    }
    this.profiles = list;
    const requested = typeof group.activeProfileId === "string"
      ? group.activeProfileId.trim().toLowerCase()
      : DEFAULT_PROFILE_ID;
    this.setActiveProfile(this.profiles.some(p => p.id === requested) ? requested : DEFAULT_PROFILE_ID);
  }

  setActiveProfile(profileId) {
    if (!this.supportsProfiles) {
      this.activeProfileId = DEFAULT_PROFILE_ID;
      this.partition = this.basePartition;
      return this.activeProfileId;
    }
    const normalized = typeof profileId === "string" ? profileId.trim().toLowerCase() : "";
    if (!this.profiles.some(entry => entry.id === normalized)) {
      throw new Error(`Unknown profile "${profileId}" for ${this.displayName}`);
    }
    this.activeProfileId = normalized;
    this.partition = this.partitionForProfile(normalized);
    return this.activeProfileId;
  }

  createProfile(name = "") {
    if (!this.supportsProfiles) {
      throw new Error(`${this.displayName} does not support multiple profiles`);
    }
    let idx = Math.max(2, this.profiles.length + 1);
    while (this.profiles.some(entry => entry.id === `p${idx}`)) {
      idx += 1;
    }
    const id = `p${idx}`;
    const trimmedName = typeof name === "string" ? name.trim().slice(0, 40) : "";
    const profile = {
      id,
      name: trimmedName || `Account ${idx}`,
      authenticated: false,
    };
    this.profiles.push(profile);
    return { ...profile };
  }

  renameProfile(profileId, name) {
    if (!this.supportsProfiles) {
      throw new Error(`${this.displayName} does not support multiple profiles`);
    }
    const normalizedId = typeof profileId === "string" ? profileId.trim().toLowerCase() : "";
    const target = this.profiles.find(entry => entry.id === normalizedId);
    if (!target) throw new Error(`Unknown profile "${profileId}" for ${this.displayName}`);
    const trimmed = typeof name === "string" ? name.trim().slice(0, 40) : "";
    if (!trimmed) throw new Error("Profile name cannot be empty");
    target.name = trimmed;
    return { ...target };
  }

  deleteProfile(profileId) {
    if (!this.supportsProfiles) {
      throw new Error(`${this.displayName} does not support multiple profiles`);
    }
    const normalizedId = typeof profileId === "string" ? profileId.trim().toLowerCase() : "";
    if (normalizedId === DEFAULT_PROFILE_ID) {
      throw new Error("Default profile cannot be deleted");
    }
    const index = this.profiles.findIndex(entry => entry.id === normalizedId);
    if (index < 0) {
      throw new Error(`Unknown profile "${profileId}" for ${this.displayName}`);
    }
    const [removed] = this.profiles.splice(index, 1);
    const removedStorePath = this.storePathForProfile(this.descriptorPath, normalizedId);
    const removedPartition = this.partitionForProfile(normalizedId);
    this.profileStores.delete(normalizedId);
    if (this.activeProfileId === normalizedId) {
      this.setActiveProfile(DEFAULT_PROFILE_ID);
    }
    return { removed, storePath: removedStorePath, partition: removedPartition };
  }

  updateProfileAuthentication(profileId, authenticated) {
    if (!this.supportsProfiles) return;
    const normalizedId = typeof profileId === "string" ? profileId.trim().toLowerCase() : DEFAULT_PROFILE_ID;
    const target = this.profiles.find(entry => entry.id === normalizedId);
    if (target) {
      target.authenticated = authenticated === true;
    }
  }

  conversationId(conversationKey, profileId = this.activeProfileId) {
    return conversationKey ? this.ensureStore(profileId).get(conversationKey)?.conversationId || null : null;
  }

  initialUrl(conversationKey, profileId = this.activeProfileId) {
    const conversationId = this.conversationId(conversationKey, profileId);
    return conversationId ? this.conversationUrl(conversationId) : this.homeUrl;
  }

  bind(conversationKey, conversationId, profileId = this.activeProfileId) {
    return this.ensureStore(profileId).bind(conversationKey, conversationId);
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

  async hasAuthCookies(_browserSession) {
    return null;
  }

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

