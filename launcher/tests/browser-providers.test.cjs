const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ConversationStore, STORE_VERSION } = require("../electron/browser/conversation-store.cjs");
const { BaseBrowserProvider } = require("../electron/browser/providers/base-browser-provider.cjs");
const { BrowserProviderRegistry } = require("../electron/browser/providers/browser-provider-registry.cjs");
const {
  M365_CHAT_URL,
  M365_ORIGIN,
  M365_PARTITION,
  M365BrowserProvider,
} = require("../electron/browser/providers/m365/m365-browser-provider.cjs");

function makeDummyProviderClass() {
  return class DummyBrowserProvider extends BaseBrowserProvider {
    constructor(options = {}) {
      super({
        id: options.id || "dummy",
        displayName: options.displayName || "Dummy Provider",
        homeUrl: "https://dummy.example.com/chat",
        origin: "https://dummy.example.com",
        partition: "persist:codex-dummy",
        maxSurfaces: options.maxSurfaces ?? 2,
        maxPersistedBindings: options.maxPersistedBindings ?? 16,
        descriptorPath: options.descriptorPath || null,
      });
    }

    normalizeConversationId(value) {
      return typeof value === "string" && /^chat-[a-z0-9]+$/i.test(value) ? value.toLowerCase() : null;
    }

    conversationUrl(conversationId) {
      return `${this.homeUrl}/${this.normalizeConversationId(conversationId)}`;
    }

    parseConversationId(rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.origin !== this.origin) return null;
        const match = parsed.pathname.match(/^\/chat\/([^/]+)$/);
        return this.normalizeConversationId(match?.[1]);
      } catch {
        return null;
      }
    }

    isAllowedNavigation(rawUrl) {
      return typeof rawUrl === "string" && rawUrl.startsWith(this.origin);
    }

    async probeAuthentication() {
      return { authenticated: true, status: "ready" };
    }

    markTurnSurface() {}
  };
}

test("ConversationStore validates arguments, ignores corrupt persisted entries, and evicts oldest LRU bindings", () => {
  assert.throws(() => new ConversationStore({}), /normalizeId/);
  assert.throws(() => new ConversationStore({ normalizeId: (v) => v, maxBindings: 0 }), /positive integer/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "conv-store-"));
  const filePath = path.join(root, "bindings.json");
  const key1 = "1".repeat(64);
  const key2 = "2".repeat(64);
  const key3 = "3".repeat(64);
  try {
    fs.writeFileSync(filePath, JSON.stringify({
      version: STORE_VERSION,
      bindings: {
        "invalid-key": { conversationId: "chat-a", lastUsedAt: 10 },
        [key1]: { conversationId: "CHAT-FIRST", lastUsedAt: 100 },
        [key2]: { conversationId: "invalid id", lastUsedAt: 200 },
      },
    }));

    const store = new ConversationStore({
      filePath,
      providerLabel: "Dummy",
      normalizeId: (value) => (typeof value === "string" && /^chat-[a-z]+$/i.test(value) ? value.toLowerCase() : null),
      maxBindings: 2,
    });
    assert.equal(store.size, 1);
    assert.equal(store.get(key1).conversationId, "chat-first");

    assert.throws(() => store.bind("bad", "chat-a"), /Dummy conversation key is invalid/);
    assert.throws(() => store.bind(key2, "bad id"), /Dummy conversation id is invalid/);

    store.bind(key2, "CHAT-SECOND");
    store.bindings.get(key1).lastUsedAt = 10;
    store.bindings.get(key2).lastUsedAt = 20;
    store.bind(key3, "CHAT-THIRD");

    assert.equal(store.size, 2);
    assert.equal(store.get(key1), null);
    assert.equal(store.get(key2).conversationId, "chat-second");
    assert.equal(store.get(key3).conversationId, "chat-third");
    assert.equal(store.delete(key1), false);
    assert.equal(store.delete(key2), true);
    assert.equal(store.size, 1);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(filePath).mode & 0o077, 0);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("BaseBrowserProvider enforces abstract contract and provides shared template lifecycle helpers", async () => {
  assert.throws(() => new BaseBrowserProvider({
    id: "raw",
    displayName: "Raw",
    homeUrl: "https://example.com",
    origin: "https://example.com",
    partition: "persist:raw",
  }), /abstract/);

  class IncompleteProvider extends BaseBrowserProvider {}
  assert.throws(() => new IncompleteProvider({}), /non-empty id/);
  const incomplete = new IncompleteProvider({
    id: "incomplete",
    displayName: "Incomplete",
    homeUrl: "https://incomplete.example.com",
    origin: "https://incomplete.example.com",
    partition: "persist:incomplete",
  });
  assert.throws(() => incomplete.normalizeConversationId("x"), /"normalizeConversationId" must be implemented by IncompleteProvider/);
  assert.throws(() => incomplete.conversationUrl("x"), /"conversationUrl" must be implemented by IncompleteProvider/);
  assert.throws(() => incomplete.parseConversationId("x"), /"parseConversationId" must be implemented by IncompleteProvider/);
  assert.throws(() => incomplete.isAllowedNavigation("x"), /"isAllowedNavigation" must be implemented by IncompleteProvider/);
  await assert.rejects(() => incomplete.probeAuthentication({}), /"probeAuthentication" must be implemented by IncompleteProvider/);
  assert.throws(() => incomplete.markTurnSurface({}, {}), /"markTurnSurface" must be implemented by IncompleteProvider/);
  await assert.rejects(() => incomplete.runSmokeTest({}), /Smoke test is not supported/);

  const DummyProvider = makeDummyProviderClass();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dummy-provider-"));
  try {
    const provider = new DummyProvider({
      descriptorPath: path.join(root, "launcher-browser.json"),
      maxSurfaces: 2,
    });
    const keyA = "a".repeat(64);
    const keyB = "b".repeat(64);
    const keyC = "c".repeat(64);

    assert.equal(provider.initialUrl(keyA), "https://dummy.example.com/chat");
    provider.bind(keyA, "CHAT-42");
    assert.equal(provider.initialUrl(keyA), "https://dummy.example.com/chat/chat-42");
    assert.equal(provider.isAcceptableControlConversationId("CHAT-42"), true);
    assert.equal(provider.isAcceptableControlConversationId("invalid id"), false);
    assert.equal(provider.allowedAuthUrl("https://sub.dummy.example.com/auth"), true);
    assert.equal(provider.allowedAuthUrl("https://evil.example.com/auth"), false);

    const tabs = new Map([
      ["t1", { id: "t1", provider: "dummy", status: "ready", conversationKey: keyA, lastHeartbeatAt: 10 }],
      ["t2", { id: "t2", provider: "dummy", status: "ready", conversationKey: keyB, lastHeartbeatAt: 20 }],
    ]);
    const removed = [];
    provider.prepareAllocation(tabs, keyC, (tab) => {
      removed.push(tab.id);
      tabs.delete(tab.id);
    });
    assert.deepEqual(removed, ["t1"]);
    assert.equal(tabs.has("t1"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("BrowserProviderRegistry manages registration, defaults, and unknown-provider guards", () => {
  const registry = new BrowserProviderRegistry();
  assert.throws(() => registry.defaultProvider(), /No browser providers/);
  assert.throws(() => registry.register({ id: "fake" }), /BaseBrowserProvider/);

  const DummyProvider = makeDummyProviderClass();
  const m365 = new M365BrowserProvider();
  const dummy = new DummyProvider({ id: "claude", displayName: "Claude Web" });

  registry.register(m365).register(dummy);
  assert.throws(() => registry.register(new DummyProvider({ id: "claude" })), /already registered/);
  assert.equal(registry.defaultId(), "m365");
  assert.equal(registry.defaultProvider(), m365);
  assert.equal(registry.has("m365"), true);
  assert.equal(registry.has("claude"), true);
  assert.equal(registry.has("unknown"), false);
  assert.deepEqual(registry.listIds(), ["m365", "claude"]);
  assert.deepEqual(registry.list(), [m365, dummy]);
  assert.equal(registry.get("claude"), dummy);
  assert.throws(() => registry.get("missing"), /Unknown browser provider: missing/);
});

test("M365BrowserProvider encapsulates Microsoft 365 URL, cookie, and fallback probe rules", async () => {
  const provider = new M365BrowserProvider();
  assert.equal(provider.id, "m365");
  assert.equal(provider.homeUrl, M365_CHAT_URL);
  assert.equal(provider.origin, M365_ORIGIN);
  assert.equal(provider.partition, M365_PARTITION);

  assert.equal(provider.isAuthCookieDomain(".cloud.microsoft"), true);
  assert.equal(provider.isAuthCookieDomain("login.microsoftonline.com"), true);
  assert.equal(provider.isAuthCookieDomain("example.com"), false);
  assert.equal(provider.isAuthCookieDomain(null), false);

  assert.equal(provider.isAuthOrAppUrl("https://m365.cloud.microsoft/chat"), true);
  assert.equal(provider.isAuthOrAppUrl("https://login.microsoftonline.com/common"), true);
  assert.equal(provider.isAuthOrAppUrl("https://example.com"), false);

  assert.equal(provider.allowedAuthUrl("https://tenant.m365.cloud.microsoft/oauth"), true);
  assert.equal(provider.allowedAuthUrl("https://accounts.google.com/o/oauth2/v2/auth"), true);
  assert.equal(provider.allowedAuthUrl("http://m365.cloud.microsoft/chat"), false);

  const readyProbe = await provider.probeAuthentication({
    executeJavaScript: async () => Promise.reject(new Error("renderer busy")),
    getURL: () => "https://m365.cloud.microsoft/chat",
  });
  assert.equal(readyProbe.authenticated, true);

  const loginProbe = await provider.probeAuthentication({
    executeJavaScript: async () => Promise.reject(new Error("renderer busy")),
    getURL: () => "https://login.microsoftonline.com/common/login",
  });
  assert.equal(loginProbe.authenticated, false);
});

