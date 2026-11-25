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
  assert.equal(provider.isAuthOrAppUrl("https://copilot.cloud.microsoft/chat"), true);
  assert.equal(provider.isAuthOrAppUrl("https://login.microsoftonline.com/common"), true);
  assert.equal(provider.isAuthOrAppUrl("https://example.com"), false);

  assert.equal(provider.allowedAuthUrl("https://tenant.m365.cloud.microsoft/oauth"), true);
  assert.equal(provider.allowedAuthUrl("https://copilot.cloud.microsoft/chat"), true);
  assert.equal(provider.allowedAuthUrl("https://accounts.google.com/o/oauth2/v2/auth"), true);
  assert.equal(provider.allowedAuthUrl("http://m365.cloud.microsoft/chat"), false);

  const readyProbe = await provider.probeAuthentication({
    executeJavaScript: async () => Promise.reject(new Error("renderer busy")),
    getURL: () => "https://m365.cloud.microsoft/chat",
  });
  assert.equal(readyProbe.authenticated, true);

  const copilotReadyProbe = await provider.probeAuthentication({
    executeJavaScript: async () => Promise.reject(new Error("renderer busy")),
    getURL: () => "https://copilot.cloud.microsoft/chat",
  });
  assert.equal(copilotReadyProbe.authenticated, true);

  const loginProbe = await provider.probeAuthentication({
    executeJavaScript: async () => Promise.reject(new Error("renderer busy")),
    getURL: () => "https://login.microsoftonline.com/common/login",
  });
  assert.equal(loginProbe.authenticated, false);

  const { allowedM365Navigation } = require("../electron/browser/providers/m365/m365-turn-surface.cjs");
  assert.equal(allowedM365Navigation("https://copilot.cloud.microsoft/chat"), true);
  assert.equal(allowedM365Navigation("https://m365.cloud.microsoft/chat"), true);
  assert.equal(allowedM365Navigation("https://example.com/chat"), false);

  // Silent SSO settle: chờ thoát login.microsoftonline.com về app URL
  let ssoTicks = 0;
  await provider.waitForAuthenticationSettle({
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => {
      ssoTicks += 1;
      return ssoTicks >= 3
        ? "https://copilot.cloud.microsoft/chat"
        : "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
    },
    executeJavaScript: async () => false,
  }, 500);
  assert.ok(ssoTicks >= 3);

  // Sau khi quan sát thấy copilot.cloud.microsoft, provider ưu tiên origin mới để tránh redirect mcmToCcm lặp lại
  assert.equal(provider.preferredOrigin, "https://copilot.cloud.microsoft");
  assert.equal(provider.initialUrl(), "https://copilot.cloud.microsoft/chat");
  const sampleConvId = "01a1ea2f-c3b5-4863-9da2-7974ae30a53b";
  assert.equal(
    provider.conversationUrl(sampleConvId),
    `https://copilot.cloud.microsoft/chat/conversation/${sampleConvId}`,
  );
  // Trang login không được ghi đè preferredOrigin
  provider.noteObservedAppUrl("https://copilot.cloud.microsoft/login");
  assert.equal(provider.preferredOrigin, "https://copilot.cloud.microsoft");
});

test("AiStudioBrowserProvider & createDefaultProviderRegistry support multi-provider AI Studio registration", async () => {
  const {
    AI_STUDIO_CHAT_URL,
    AI_STUDIO_ORIGIN,
    AI_STUDIO_PARTITION,
    AiStudioBrowserProvider,
  } = require("../electron/browser/providers/ai-studio/ai-studio-browser-provider.cjs");
  const { createDefaultProviderRegistry } = require("../electron/browser/browser-host.cjs");

  const registry = createDefaultProviderRegistry();
  assert.deepEqual(registry.listIds(), ["m365", "ai-studio", "gemini", "chatgpt"]);

  const provider = new AiStudioBrowserProvider();
  const sampleId = "1f4VKkbKG5PxctRMKVZN4bR3TRBcc1ROb";
  assert.equal(provider.id, "ai-studio");
  assert.equal(provider.homeUrl, AI_STUDIO_CHAT_URL);
  assert.equal(provider.origin, AI_STUDIO_ORIGIN);
  assert.equal(provider.partition, AI_STUDIO_PARTITION);
  assert.equal(provider.normalizeConversationId(sampleId), sampleId);
  assert.equal(provider.normalizeConversationId("new_chat"), null);
  assert.equal(provider.parseConversationId(`https://aistudio.google.com/prompts/${sampleId}`), sampleId);
  assert.equal(provider.conversationUrl(sampleId), `https://aistudio.google.com/prompts/${sampleId}`);
  assert.equal(provider.isAllowedNavigation(`https://aistudio.google.com/prompts/${sampleId}`), true);
  assert.equal(provider.isAllowedNavigation("https://evil.example.com"), false);
  assert.equal(provider.allowedAuthUrl("https://accounts.google.com/signin"), true);

  const authed = await provider.probeAuthentication({
    executeJavaScript: async () => Promise.reject(new Error("renderer busy")),
    getURL: () => AI_STUDIO_CHAT_URL,
  });
  assert.equal(authed.authenticated, true);

  const signedOut = await provider.probeAuthentication({
    executeJavaScript: async () => Promise.reject(new Error("renderer busy")),
    getURL: () => "https://accounts.google.com/ServiceLogin",
  });
  assert.equal(signedOut.authenticated, false);

  let appliedUa = "";
  provider.onPrimarySessionCreated({
    getUserAgent: () => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CodexM365Copilot/6.9.6 Electron/42.11.18 Chrome/148.0.7778.280 Safari/537.36",
    setUserAgent: (ua) => { appliedUa = ua; },
  });
  assert.equal(
    appliedUa,
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.280 Safari/537.36",
  );

  let appliedHyphenUa = "";
  provider.onPrimarySessionCreated({
    getUserAgent: () => "Mozilla/5.0 Chrome/134.0.0.0 Electron/42.11.18 codex-m365-copilot/6.9.6 Safari/537.36",
    setUserAgent: (ua) => { appliedHyphenUa = ua; },
  });
  assert.equal(appliedHyphenUa, "Mozilla/5.0 Chrome/134.0.0.0 Safari/537.36");

  const devRegistry = createDefaultProviderRegistry({ profile: "development" });
  assert.equal(devRegistry.get("m365").partition, "persist:codex-web-gpt-dev-m365");
  assert.equal(devRegistry.get("ai-studio").partition, "persist:codex-web-gpt-dev-ai-studio");
  assert.equal(devRegistry.get("gemini").partition, "persist:codex-web-gpt-dev-gemini");
  assert.equal(devRegistry.get("chatgpt").partition, "persist:codex-web-gpt-dev-chatgpt");
  assert.equal(provider.maxSurfaces, 8);
  assert.equal(provider.supportsExternalChromeLogin(), true);
});

test("GeminiBrowserProvider hỗ trợ partition đa profile, /u/{n}/app/{id} và bỏ qua SignOutOptions khi probe auth", async () => {
  const {
    GEMINI_CHAT_URL,
    GEMINI_ORIGIN,
    GEMINI_PARTITION,
    GeminiBrowserProvider,
  } = require("../electron/browser/providers/gemini/gemini-browser-provider.cjs");
  const provider = new GeminiBrowserProvider();
  const sampleId = "722895cc1dfdbb27";

  assert.equal(provider.id, "gemini");
  assert.equal(provider.homeUrl, GEMINI_CHAT_URL);
  assert.equal(provider.origin, GEMINI_ORIGIN);
  assert.equal(provider.partition, GEMINI_PARTITION);
  assert.equal(provider.partitionForProfile("default"), GEMINI_PARTITION);
  assert.equal(provider.partitionForProfile("p2"), `${GEMINI_PARTITION}-p2`);
  assert.equal(provider.normalizeConversationId(sampleId), sampleId);
  assert.equal(provider.normalizeConversationId("gems"), null);
  assert.equal(provider.parseConversationId(`https://gemini.google.com/app/${sampleId}`), sampleId);
  assert.equal(provider.parseConversationId(`https://gemini.google.com/u/0/app/${sampleId}`), sampleId);
  assert.equal(provider.conversationUrl(sampleId), `https://gemini.google.com/app/${sampleId}`);
  assert.equal(provider.isAllowedNavigation(`https://gemini.google.com/app/${sampleId}`), true);
  assert.equal(provider.isAllowedNavigation("https://evil.example.com"), false);
  assert.equal(provider.allowedAuthUrl("https://accounts.google.com/signin"), true);
  assert.equal(provider.supportsExternalChromeLogin(), true);

  const authed = await provider.probeAuthentication({
    executeJavaScript: async () => ({
      url: GEMINI_CHAT_URL,
      composer: true,
      signInButton: false,
      accountControl: true,
      authenticated: true,
      readyState: "complete",
    }),
    getURL: () => GEMINI_CHAT_URL,
  });
  assert.equal(authed.authenticated, true);
});

test("BaseBrowserProvider.prepareAllocation ưu tiên evict tab đã có conversationId trước tab chưa có ID", () => {
  const DummyProvider = makeDummyProviderClass();
  const provider = new DummyProvider({ maxSurfaces: 2 });
  const keyA = "a".repeat(64);
  const keyB = "b".repeat(64);
  const keyC = "c".repeat(64);

  const tabs = new Map([
    ["unsaved-old", { id: "unsaved-old", provider: "dummy", status: "ready", conversationKey: keyA, conversationId: null, lastHeartbeatAt: 10 }],
    ["saved-new", { id: "saved-new", provider: "dummy", status: "ready", conversationKey: keyB, conversationId: "chat-99", lastHeartbeatAt: 500 }],
  ]);
  const removed = [];
  provider.prepareAllocation(tabs, keyC, (tab) => {
    removed.push(tab.id);
    tabs.delete(tab.id);
  });
  assert.deepEqual(removed, ["saved-new"]);
  assert.equal(tabs.has("unsaved-old"), true);
});

test("bindAiStudioTurnContents tự động bind conversationId xuống disk khi did-navigate-in-page đổi sang /prompts/{id}", () => {
  const {
    AiStudioBrowserProvider,
  } = require("../electron/browser/providers/ai-studio/ai-studio-browser-provider.cjs");
  const {
    bindAiStudioTurnContents,
  } = require("../electron/browser/providers/ai-studio/ai-studio-turn-surface.cjs");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-studio-bind-"));
  try {
    const provider = new AiStudioBrowserProvider({
      descriptorPath: path.join(root, "launcher-browser.json"),
    });
    const listeners = new Map();
    let currentUrl = "https://aistudio.google.com/prompts/new_chat?model=gemini-4-hydrogen";
    const fakeContents = {
      setWindowOpenHandler() {},
      on(event, handler) {
        listeners.set(event, handler);
      },
      getURL: () => currentUrl,
      isDestroyed: () => false,
    };
    const conversationKey = "e".repeat(64);
    const tab = {
      id: "tab-1",
      traceId: "trace-1",
      provider: "ai-studio",
      profileId: "default",
      conversationKey,
      conversationId: null,
      connectorBound: false,
      url: currentUrl,
      view: { webContents: fakeContents },
    };
    const host = {
      providerRegistry: new Map([["ai-studio", provider]]),
      window: { isVisible: () => false },
      snapshot: () => ({}),
      publishState() {},
      syncViewVisibility() {},
      syncPowerSaveBlocker() {},
      removeTurnTab() {},
      logger: { info() {}, warn() {}, error() {} },
    };

    bindAiStudioTurnContents(host, tab);

    const lateId = "1ixE9s7OO0kkXxdXYIAxTprFXkvVKN8jI";
    currentUrl = `https://aistudio.google.com/prompts/${lateId}`;
    listeners.get("did-navigate-in-page")({}, currentUrl, true);

    assert.equal(tab.conversationId, lateId);
    assert.equal(tab.connectorBound, true);
    assert.equal(provider.conversationId(conversationKey, "default"), lateId);

    const { resolveTurnTabBootstrapUrl } = require("../electron/browser/turn-tab-manager.cjs");
    // Khi conversationKey đã có ID lưu trên disk nhưng initialUrl chỉ là new_chat -> mở thẳng /prompts/{id}
    const resumed = resolveTurnTabBootstrapUrl(
      provider,
      conversationKey,
      "default",
      "https://aistudio.google.com/prompts/new_chat?model=gemini-4-hydrogen",
    );
    assert.equal(resumed.conversationId, lateId);
    assert.equal(resumed.bootstrapUrl, `https://aistudio.google.com/prompts/${lateId}`);

    // Khi initialUrl chỉ định tường minh một conversationId khác (/v2/responses) -> giữ nguyên initialUrl
    const explicitId = "2abCDefGH1234567890xyzABC";
    const explicit = resolveTurnTabBootstrapUrl(
      provider,
      conversationKey,
      "default",
      `https://aistudio.google.com/prompts/${explicitId}`,
    );
    assert.equal(explicit.bootstrapUrl, `https://aistudio.google.com/prompts/${explicitId}`);

    // Khi conversationKey chưa có ID trên disk -> giữ nguyên new_chat?model=...
    const freshKey = "f".repeat(64);
    const fresh = resolveTurnTabBootstrapUrl(
      provider,
      freshKey,
      "default",
      "https://aistudio.google.com/prompts/new_chat?model=gemini-4-hydrogen",
    );
    assert.equal(fresh.conversationId, null);
    assert.equal(fresh.bootstrapUrl, "https://aistudio.google.com/prompts/new_chat?model=gemini-4-hydrogen");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ChatGptBrowserProvider supports external Chrome login, multi-profile partitions, auth cookies, and turn surface binding", async () => {
  const {
    CHATGPT_CHAT_URL,
    CHATGPT_ORIGIN,
    CHATGPT_PARTITION,
    ChatGptBrowserProvider,
    hasChatGptAuthSessionCookies,
  } = require("../electron/browser/providers/chatgpt/chatgpt-browser-provider.cjs");
  const {
    bindChatGptTurnContents,
  } = require("../electron/browser/providers/chatgpt/chatgpt-turn-surface.cjs");

  const provider = new ChatGptBrowserProvider();
  const sampleId = "6afae1f3-e4f0-83ec-8aca-7c8649cfde1c";
  assert.equal(provider.id, "chatgpt");
  assert.equal(provider.homeUrl, CHATGPT_CHAT_URL);
  assert.equal(provider.origin, CHATGPT_ORIGIN);
  assert.equal(provider.partition, CHATGPT_PARTITION);
  assert.equal(provider.isProfileSupported(), true);
  assert.equal(provider.supportsExternalChromeLogin(), true);
  assert.equal(provider.partitionForProfile("default"), CHATGPT_PARTITION);
  assert.equal(provider.partitionForProfile("p2"), `${CHATGPT_PARTITION}-p2`);

  assert.equal(provider.normalizeConversationId(sampleId), sampleId);
  assert.equal(provider.normalizeConversationId("new"), null);
  assert.equal(provider.parseConversationId(`https://chatgpt.com/c/${sampleId}`), sampleId);
  assert.equal(provider.conversationUrl(sampleId), `https://chatgpt.com/c/${sampleId}`);
  assert.equal(provider.isAllowedNavigation(`https://chatgpt.com/c/${sampleId}`), true);
  assert.equal(provider.isAllowedNavigation("https://evil.example.com"), false);
  assert.equal(provider.allowedAuthUrl("https://auth.openai.com/authorize"), true);
  assert.equal(provider.allowedAuthUrl("https://accounts.google.com/o/oauth2"), true);

  assert.equal(hasChatGptAuthSessionCookies([{ name: "oai-did", value: "abc" }]), false);
  assert.equal(hasChatGptAuthSessionCookies([{ name: "__Secure-next-auth.session-token", value: "tok" }]), true);
  assert.equal(hasChatGptAuthSessionCookies([{ name: "__Secure-next-auth.session-token.0", value: "chunk0" }]), true);
  assert.equal(provider.hasExternalAuthSessionCookies([{ name: "__Secure-next-auth.session-token.1", value: "chunk1" }]), true);

  const liveCookiesResult = await provider.hasAuthCookies({
    cookies: {
      get: async () => [
        {
          name: "__Secure-next-auth.session-token.0",
          value: "live",
          domain: "chatgpt.com",
        },
      ],
    },
  });
  assert.equal(liveCookiesResult, true);

  const authed = await provider.probeAuthentication({
    executeJavaScript: async () => ({
      url: CHATGPT_CHAT_URL,
      composer: true,
      profileMenu: true,
      loginControl: false,
      authenticated: true,
      readyState: "complete",
    }),
    getURL: () => CHATGPT_CHAT_URL,
  });
  assert.equal(authed.authenticated, true);

  const signedOut = await provider.probeAuthentication({
    executeJavaScript: async () => Promise.reject(new Error("renderer busy")),
    getURL: () => "https://auth.openai.com/u/login",
  });
  assert.equal(signedOut.authenticated, false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-bind-"));
  try {
    const storeProvider = new ChatGptBrowserProvider({
      descriptorPath: path.join(root, "launcher-browser.json"),
    });
    const listeners = new Map();
    let currentUrl = CHATGPT_CHAT_URL;
    const fakeContents = {
      setWindowOpenHandler() {},
      on(event, handler) {
        listeners.set(event, handler);
      },
      getURL: () => currentUrl,
      isDestroyed: () => false,
    };
    const conversationKey = "c".repeat(64);
    const tab = {
      id: "tab-chatgpt-1",
      traceId: "trace-chatgpt-1",
      provider: "chatgpt",
      profileId: "default",
      conversationKey,
      conversationId: null,
      connectorBound: false,
      url: currentUrl,
      view: { webContents: fakeContents },
    };
    const host = {
      providerRegistry: new Map([["chatgpt", storeProvider]]),
      window: { isVisible: () => false },
      snapshot: () => ({}),
      publishState() {},
      syncViewVisibility() {},
      syncPowerSaveBlocker() {},
      removeTurnTab() {},
      logger: { info() {}, warn() {}, error() {} },
    };

    bindChatGptTurnContents(host, tab);

    currentUrl = `https://chatgpt.com/c/${sampleId}`;
    listeners.get("did-navigate-in-page")({}, currentUrl, true);

    assert.equal(tab.conversationId, sampleId);
    assert.equal(tab.connectorBound, true);
    assert.equal(storeProvider.conversationId(conversationKey, "default"), sampleId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

