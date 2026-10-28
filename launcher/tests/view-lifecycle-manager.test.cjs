const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { ViewLifecycleManager } = require("../electron/view-lifecycle-manager.cjs");
const { BrowserHost, IDLE_BROWSER_URL } = require("../electron/browser-host.cjs");

function createFakeView(key) {
  let destroyed = false;
  let visible = false;
  let bounds = null;
  let throttling = null;
  const webContents = new EventEmitter();
  webContents.isDestroyed = () => destroyed;
  webContents.setBackgroundThrottling = (value) => { throttling = value; };
  webContents.loadURL = async () => {};
  webContents.close = () => { destroyed = true; };

  return {
    key,
    webContents,
    setBounds: (nextBounds) => { bounds = nextBounds; },
    setVisible: (nextVisible) => { visible = nextVisible; },
    getState: () => ({ destroyed, visible, bounds, throttling }),
  };
}

test("ViewLifecycleManager lazy-loads views and destroys inactive ones cleanly", () => {
  const attached = new Set();
  const created = [];
  const window = {
    contentView: {
      addChildView: (view) => attached.add(view.key),
      removeChildView: (view) => attached.delete(view.key),
    },
  };
  const manager = new ViewLifecycleManager({
    window,
    createView: (key) => createFakeView(key),
    onCreate: (key) => created.push(key),
  });

  assert.equal(manager.has("chatgpt"), false);
  const chatgptView = manager.ensure("chatgpt");
  assert.deepEqual(created, ["chatgpt"]);
  assert.equal(attached.has("chatgpt"), true);
  assert.equal(manager.ensure("chatgpt"), chatgptView);
  assert.deepEqual(created, ["chatgpt"]);

  chatgptView.webContents.on("did-finish-load", () => {});
  assert.equal(chatgptView.webContents.listenerCount("did-finish-load"), 1);

  assert.equal(manager.destroy("chatgpt"), true);
  assert.equal(attached.has("chatgpt"), false);
  assert.equal(chatgptView.webContents.isDestroyed(), true);
  assert.equal(chatgptView.webContents.listenerCount("did-finish-load"), 0);
  assert.equal(manager.has("chatgpt"), false);
});

test("initializePrimaryView loads provider-specific home URL when starting on non-ChatGPT provider", async () => {
  for (const [provider, expectedUrl] of [
    ["m365", "https://m365.cloud.microsoft/chat"],
    ["gemini", "https://gemini.google.com/app"],
    ["qwen", "https://chat.qwen.ai/"],
    ["chatgpt", IDLE_BROWSER_URL],
  ]) {
    const calls = [];
    let currentUrl = "about:blank";
    const contents = new EventEmitter();
    contents.isDestroyed = () => false;
    contents.getURL = () => currentUrl;
    contents.stop = () => calls.push("stop");
    contents.loadURL = async (url) => {
      calls.push(["load", url]);
      currentUrl = url;
    };
    const hiddenBounds = { x: 801, y: 601, width: 800, height: 600 };
    const fixture = Object.assign(Object.create(BrowserHost.prototype), {
      provider,
      view: {
        setBounds: (bounds) => calls.push(["bounds", bounds]),
        setVisible: (visible) => calls.push(["visible", visible]),
        webContents: contents,
      },
      hiddenTurnBounds: () => hiddenBounds,
      markOwnedSurface: async () => calls.push(["owned", provider]),
      syncViewVisibility: () => calls.push("sync"),
      writeDescriptor: () => calls.push("descriptor"),
      logger: {
        info: (event, detail) => calls.push([event, detail]),
        warn: (event, detail) => calls.push([event, detail]),
      },
    });

    await BrowserHost.prototype.initializePrimaryView.call(fixture);

    assert.deepEqual(calls, [
      ["bounds", hiddenBounds],
      ["visible", true],
      ["load", expectedUrl],
      ["owned", provider],
      "sync",
      "descriptor",
      ["browser.initialized", { url: expectedUrl }],
    ]);
  }
});

test("presentTurnView disables device emulation and hides completed ready tabs in background", () => {
  const events = [];
  const tab = {
    id: "tab-ready-bg",
    status: "ready",
    interactionMode: "automatic",
    rendererReady: true,
    deviceEmulationViewport: { width: 1120, height: 720 },
    deviceEmulationDirty: false,
    view: {
      setBounds: (bounds) => events.push(["bounds", bounds]),
      setVisible: (visible) => events.push(["visible", visible]),
      webContents: {
        enableDeviceEmulation: () => assert.fail("ready background tab must not enable device emulation"),
        disableDeviceEmulation: () => events.push(["disable-emulation"]),
      },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    window: {
      getContentSize: () => [1120, 720],
    },
  });

  BrowserHost.prototype.presentTurnView.call(fixture, tab, false);

  assert.deepEqual(events, [
    ["disable-emulation"],
    ["bounds", { x: 1121, y: 721, width: 1120, height: 720 }],
    ["visible", false],
  ]);
  assert.equal(tab.deviceEmulationViewport, null);
  assert.equal(tab.deviceEmulationDirty, true);
});

test("endTurn evicts older ready automatic tabs and syncs visibility when retaining a completed turn", async () => {
  const removed = [];
  let visibilitySynced = 0;
  const oldReadyTab = {
    id: "tab-old-ready",
    traceId: "trace_old",
    status: "ready",
    interactionMode: "automatic",
    conversationKey: "a".repeat(64),
  };
  const manualReadyTab = {
    id: "tab-manual-ready",
    traceId: "trace_manual",
    status: "ready",
    interactionMode: "manual",
    conversationKey: "b".repeat(64),
  };
  const completingTab = {
    id: "tab-completing",
    traceId: "trace_completing",
    helperPid: 888,
    status: "running",
    interactionMode: "automatic",
    conversationKey: "c".repeat(64),
    connectorIdentity: "chatgpt-web",
    view: {
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling: () => {},
        getURL: () => "https://chatgpt.com/c/6704b2a8-5e88-800c-b26a-9bb7d24669f1",
      },
    },
  };

  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([
      [oldReadyTab.id, oldReadyTab],
      [manualReadyTab.id, manualReadyTab],
      [completingTab.id, completingTab],
    ]),
    closedTurnOwners: new Map(),
    userCancelledTurnOwners: new Map(),
    selectedTabId: completingTab.id,
    removeTurnTab(candidate, abortRunning) {
      removed.push([candidate.id, abortRunning]);
      this.turnTabs.delete(candidate.id);
    },
    syncViewVisibility() {
      visibilitySynced += 1;
    },
    writeDescriptor() {},
    publishState() {},
    snapshot: () => ({ tabs: [] }),
    hide() {
      assert.fail("hide must not be called when hideAfterTurn is false");
    },
    logger: { info() {} },
  });

  await BrowserHost.prototype.endTurn.call(
    fixture,
    completingTab.traceId,
    completingTab.helperPid,
    "completed",
    false,
    undefined,
    true,
    true,
  );

  assert.deepEqual(removed, [["tab-old-ready", false]]);
  assert.equal(fixture.turnTabs.has("tab-old-ready"), false);
  assert.equal(fixture.turnTabs.has("tab-manual-ready"), true);
  assert.equal(fixture.turnTabs.has("tab-completing"), true);
  assert.equal(completingTab.status, "ready");
  assert.equal(visibilitySynced, 1);
});

test("releaseInactivePrimaryViews destroys inactive primary views while preserving turnTabs in unified Browser workspace", () => {
  const destroyedProviders = [];
  const removedTabs = [];
  const m365ReadyTab = {
    id: "m365-ready",
    provider: "m365",
    status: "ready",
    interactionMode: "automatic",
  };
  const m365RunningTab = {
    id: "m365-running",
    provider: "m365",
    status: "running",
    interactionMode: "automatic",
  };
  const chatgptReadyTab = {
    id: "chatgpt-ready",
    provider: "chatgpt",
    status: "ready",
    interactionMode: "automatic",
  };

  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    chatGptView: { webContents: { isDestroyed: () => false, off() {} } },
    m365View: { webContents: { isDestroyed: () => false, off() {} } },
    geminiView: null,
    qwenView: null,
    shellZoomShortcutBindings: new Map(),
    primaryViewManager: {
      destroy: (providerName) => destroyedProviders.push(providerName),
    },
    turnTabs: new Map([
      [m365ReadyTab.id, m365ReadyTab],
      [m365RunningTab.id, m365RunningTab],
      [chatgptReadyTab.id, chatgptReadyTab],
    ]),
    removeTurnTab(tab, abortRunning) {
      removedTabs.push([tab.id, abortRunning]);
      this.turnTabs.delete(tab.id);
    },
  });

  BrowserHost.prototype.releaseInactivePrimaryViews.call(fixture, "chatgpt");

  assert.deepEqual(destroyedProviders, ["m365", "gemini", "qwen"]);
  assert.equal(fixture.m365View, null);
  assert.notEqual(fixture.chatGptView, null);
  assert.deepEqual(removedTabs, []);
  assert.equal(fixture.turnTabs.has("m365-ready"), true);
  assert.equal(fixture.turnTabs.has("m365-running"), true);
  assert.equal(fixture.turnTabs.has("chatgpt-ready"), true);
});

test("GeminiSurfaceManager and bindGeminiTurnContents unify Gemini turn lifecycle with ChatGPT/M365/Qwen", () => {
  const { GeminiSurfaceManager, parseGeminiConversationId } = require("../electron/gemini-surface-manager.cjs");
  const { bindGeminiTurnContents } = require("../electron/gemini-turn-surface.cjs");

  assert.equal(
    parseGeminiConversationId("https://gemini.google.com/app/9f8e7d6c5b4a3210"),
    "9f8e7d6c5b4a3210",
  );
  const manager = new GeminiSurfaceManager({ registryPath: null });
  const key = "g".repeat(64);
  assert.equal(manager.initialUrl(key), "https://gemini.google.com/app");
  manager.bind(key, "9f8e7d6c5b4a3210");
  assert.equal(manager.initialUrl(key), "https://gemini.google.com/app/9f8e7d6c5b4a3210");

  const contents = new EventEmitter();
  contents.setWindowOpenHandler = () => {};
  contents.getURL = () => "https://gemini.google.com/app/9f8e7d6c5b4a3210";
  contents.getTitle = () => "Google Gemini";
  contents.isDestroyed = () => false;
  contents.executeJavaScript = async () => true;

  const tab = {
    id: "gemini-tab-1",
    surfaceId: "surface_gemini_1",
    traceId: "trace_gemini_1",
    provider: "gemini",
    initializingSurface: false,
    bootstrapReady: false,
    rendererReady: false,
    view: { webContents: contents },
  };
  const host = {
    turnTabs: new Map([[tab.id, tab]]),
    syncTurnDeviceEmulation: () => {},
    publishState: () => {},
    snapshot: () => ({}),
  };

  bindGeminiTurnContents(host, tab);
  contents.emit("did-finish-load");

  assert.equal(tab.bootstrapReady, true);
  assert.equal(tab.rendererReady, true);
  assert.equal(tab.url, "https://gemini.google.com/app/9f8e7d6c5b4a3210");
});

test("parkIdlePrimaryView unloads unused Home tab and snapshot hides Home tab while a turn tab is active", () => {
  const { M365SurfaceManager } = require("../electron/m365-surface-manager.cjs");
  const os = require("node:os");
  const path = require("node:path");
  const fs = require("node:fs");

  let homeUrl = "https://m365.cloud.microsoft/chat";
  let homeThrottling = false;
  const activeTurnTab = {
    id: "m365-tab-1",
    traceId: "trace_m365_1",
    label: "M365 1",
    pageTitle: "M365 Copilot",
    status: "running",
    url: "https://m365.cloud.microsoft/chat",
    loading: false,
    message: "M365 Copilot is working",
    interactionMode: "automatic",
    view: {
      webContents: {
        isDestroyed: () => false,
        isLoading: () => false,
        navigationHistory: {
          canGoBack: () => false,
          canGoForward: () => false,
        },
        getURL: () => "https://m365.cloud.microsoft/chat",
        getTitle: () => "M365 Copilot",
      },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    provider: "m365",
    selectedTabId: activeTurnTab.id,
    turnTabs: new Map([[activeTurnTab.id, activeTurnTab]]),
    manualOperation: null,
    loginOperation: null,
    authView: null,
    reauthenticationRequired: false,
    visible: true,
    surfaceActive: true,
    state: {
      title: "M365 Copilot",
      status: "running",
      loading: false,
      visible: true,
      surfaceActive: true,
    },
    view: {
      webContents: {
        isDestroyed: () => false,
        getURL: () => homeUrl,
        getTitle: () => "M365 Copilot",
        isLoading: () => false,
        navigationHistory: {
          canGoBack: () => false,
          canGoForward: () => false,
        },
        setBackgroundThrottling: (val) => { homeThrottling = val; },
        loadURL: async (url) => { homeUrl = url; },
      },
    },
  });

  fixture.parkIdlePrimaryView();
  assert.equal(homeThrottling, true);
  assert.equal(homeUrl, IDLE_BROWSER_URL);

  const snap = fixture.snapshot();
  assert.deepEqual(snap.tabs.map((t) => t.id), ["m365-tab-1"]);

  // Khi vào màn hình Browser lúc chưa có turnTab nào và chưa bấm Sign in / Run verify,
  // snapshot().tabs phải rỗng (không tự động mở trang chủ ChatGPT / M365)
  fixture.turnTabs.clear();
  fixture.primaryViewManager = {};
  fixture.homeSurfaceOpen = false;
  const idleSnap = fixture.snapshot();
  assert.deepEqual(idleSnap.tabs, []);
  assert.equal(idleSnap.visible, false);

  // Và khi bắt đầu một phiên M365 mới, tab ready cũ (M365 1) được đóng ngay lập tức
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "m365-evict-ready-"));
  try {
    const manager = new M365SurfaceManager({
      descriptorPath: path.join(tmpDir, "launcher-browser.json"),
    });
    const tabs = new Map([
      ["m365-1", { id: "m365-1", provider: "m365", status: "ready", interactionMode: "automatic", conversationKey: "1".repeat(64) }],
    ]);
    const removed = [];
    manager.prepareAllocation(tabs, "2".repeat(64), (tab) => {
      removed.push(tab.id);
      tabs.delete(tab.id);
    });
    assert.deepEqual(removed, ["m365-1"]);
    assert.equal(tabs.size, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


