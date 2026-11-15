const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const { resolve } = require("node:path");
const {
  browserViewVisible,
  constrainBrowserBounds,
  navigateBrowser,
  readBrowserNavigationState,
  scaleBrowserBounds,
  shellZoomActionForInput,
} = require("../electron/browser/browser-state.cjs");
const {
  allowedAuthUrl,
  BrowserHost,
  IDLE_BROWSER_URL,
  loadCommittedBrowserSurface,
  M365_PARTITION,
  navigationErrorForLog,
  navigationOriginForLog,
} = require("../electron/browser/browser-host.cjs");

test("Electron and Bun agree on the exact launcher idle surface", () => {
  const clientSource = fs.readFileSync(
    resolve(__dirname, "../../src/launcher-browser-host.ts"),
    "utf8",
  );
  assert.ok(clientSource.includes(
    `export const LAUNCHER_BROWSER_IDLE_URL = ${JSON.stringify(IDLE_BROWSER_URL)};`,
  ));
});

test("descriptor publishes native surface identities without inspecting renderers", () => {
  const dir = fs.mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "browser-targets-"));
  const queried = [];
  const contents = id => ({
    isDestroyed: () => false,
    getOrCreateDevToolsTargetId: () => { queried.push(id); return id; },
    executeJavaScript: () => { throw new Error("Descriptor must not inspect renderer content"); },
  });
  const tab = { surfaceId: "a".repeat(32), view: { webContents: contents("auto-target") } };
  const fixture = {
    surfaceId: "h".repeat(32), view: { webContents: contents("home-target") },
    turnTabs: new Map([["tab-1", tab]]),
    profile: "production", cdpPort: 40000,
    partition: M365_PARTITION, control: {}, helper: {},
    descriptorPath: require("node:path").join(dir, "descriptor.json"),
  };
  try {
    BrowserHost.prototype.writeDescriptor.call(fixture);
    const descriptor = JSON.parse(fs.readFileSync(fixture.descriptorPath, "utf8"));
    assert.equal(descriptor.version, 3);
    assert.deepEqual(descriptor.surfaceTargets, { [fixture.surfaceId]: "home-target", [tab.surfaceId]: "auto-target" });
    assert.deepEqual(queried, ["home-target", "auto-target"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("primary browser bootstrap accepts only the exact committed idle document", async () => {
  const calls = [];
  const contents = new EventEmitter();
  let currentUrl = "about:blank";
  contents.isDestroyed = () => false;
  contents.getURL = () => currentUrl;
  contents.stop = () => calls.push("stop");
  contents.loadURL = async (url) => {
    calls.push(["load", url]);
    currentUrl = url;
  };

  await loadCommittedBrowserSurface(contents, IDLE_BROWSER_URL, 50);

  assert.deepEqual(calls, [["load", IDLE_BROWSER_URL]]);
  assert.equal(contents.listenerCount("did-stop-loading"), 0);
  assert.equal(contents.listenerCount("did-finish-load"), 0);
  assert.equal(contents.listenerCount("did-fail-load"), 0);
  assert.equal(contents.listenerCount("render-process-gone"), 0);
  assert.equal(contents.listenerCount("destroyed"), 0);
});

test("primary browser bootstrap fails closed on navigation, renderer, and timeout boundaries", async () => {
  const keepTestAlive = setTimeout(() => {}, 100);
  try {
    const failureCases = [
      {
        event: ["did-fail-load", {}, -2, "ERR_FAILED", IDLE_BROWSER_URL, true],
        expected: /idle document failed: ERR_FAILED \(-2\)/,
      },
      {
        event: ["render-process-gone", {}, { reason: "crashed", exitCode: -2147483645 }],
        expected: /renderer stopped during idle document bootstrap: crashed/,
      },
    ];
    for (const failure of failureCases) {
      const contents = new EventEmitter();
      contents.isDestroyed = () => false;
      contents.getURL = () => "about:blank";
      contents.stop = () => {};
      contents.loadURL = () => {
        queueMicrotask(() => contents.emit(...failure.event));
        return new Promise(() => {});
      };
      await assert.rejects(
        loadCommittedBrowserSurface(contents, IDLE_BROWSER_URL, 50),
        failure.expected,
      );
    }

    const stalled = new EventEmitter();
    const calls = [];
    stalled.isDestroyed = () => false;
    stalled.getURL = () => "about:blank";
    stalled.stop = () => calls.push("stop");
    stalled.loadURL = () => new Promise(() => {});
    await assert.rejects(
      loadCommittedBrowserSurface(stalled, IDLE_BROWSER_URL, 5),
      /idle document did not commit within 5ms/,
    );
    assert.deepEqual(calls, ["stop"]);
  } finally {
    clearTimeout(keepTestAlive);
  }
});

test("primary browser initialization keeps its view offscreen but visible until ownership is committed", async () => {
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
  const hiddenBounds = { x: 1121, y: 721, width: 1120, height: 720 };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    view: {
      setBounds: bounds => calls.push(["bounds", bounds]),
      setVisible: visible => calls.push(["visible", visible]),
      webContents: contents,
    },
    hiddenTurnBounds: () => hiddenBounds,
    markOwnedSurface: async () => calls.push("owned"),
    syncViewVisibility: () => calls.push("sync"),
    writeDescriptor: () => calls.push("descriptor"),
    logger: { info: (event, detail) => calls.push([event, detail]) },
  });

  await BrowserHost.prototype.initializePrimaryView.call(fixture);

  assert.deepEqual(calls, [
    ["bounds", hiddenBounds],
    ["visible", true],
    ["load", IDLE_BROWSER_URL],
    "owned",
    "sync",
    "descriptor",
    ["browser.initialized", { url: IDLE_BROWSER_URL }],
  ]);
});

test("authentication diagnostics retain only origin and non-sensitive error metadata", () => {
  assert.equal(
    navigationOriginForLog("https://accounts.google.com/o/oauth2/v2/auth?state=secret&login_hint=user@example.com"),
    "https://accounts.google.com",
  );
  assert.equal(navigationOriginForLog("not a URL with user@example.com"), "invalid-url");
  assert.deepEqual(
    navigationErrorForLog(Object.assign(new Error("loading https://chatgpt.com/c/private"), { code: "ERR_ABORTED" })),
    { errorType: "Error", errorCode: "ERR_ABORTED" },
  );
});

function createContents() {
  const calls = [];
  let zoomFactor = 1;
  const history = {
    canGoBack: () => true,
    canGoForward: () => false,
    goBack: () => calls.push("back"),
    goForward: () => calls.push("forward"),
  };
  const webContents = {
    navigationHistory: history,
    getURL: () => "https://m365.cloud.microsoft/chat",
    getTitle: () => "M365 Copilot",
    isDestroyed: () => false,
    isLoading: () => false,
    focus: () => calls.push("focus"),
    getZoomFactor: () => zoomFactor,
    reload: () => calls.push("reload"),
    setZoomFactor: (next) => {
      zoomFactor = next;
      calls.push(["zoom", next]);
    },
  };
  return { calls, webContents };
}

test("browser surface visibility requires both requested and active state", () => {
  assert.equal(browserViewVisible(false, false, false), false);
  assert.equal(browserViewVisible(true, false, true), false);
  assert.equal(browserViewVisible(false, true, true), false);
  assert.equal(browserViewVisible(true, true, false), false);
  assert.equal(browserViewVisible(true, true, true), true);
});

test("descriptor-owned home surface stays attached offscreen while another launcher surface is active", () => {
  const calls = [];
  const hiddenBounds = { x: 1201, y: 801, width: 1200, height: 800 };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    window: {
      isVisible: () => true,
      isMinimized: () => false,
    },
    visible: false,
    surfaceActive: false,
    boundsReady: true,
    bounds: { x: 200, y: 100, width: 900, height: 650 },
    hiddenTurnBounds: () => hiddenBounds,
    view: {
      setBounds: bounds => calls.push(["bounds", bounds]),
      setVisible: visible => calls.push(["visible", visible]),
    },
    authView: null,
    turnTabs: new Map(),
    selectedTurnTab: () => null,
  });

  BrowserHost.prototype.syncViewVisibility.call(fixture);

  assert.deepEqual(calls, [
    ["bounds", hiddenBounds],
    ["visible", true],
  ]);
});

test("browser surface reactivation preserves its last measured bounds", () => {
  const visibility = [];
  const fixture = {
    surfaceActive: true,
    boundsReady: true,
    syncViewVisibility() {
      visibility.push({ active: this.surfaceActive, boundsReady: this.boundsReady });
    },
    setState() {},
    snapshot() {
      return { surfaceActive: this.surfaceActive, boundsReady: this.boundsReady };
    },
  };

  BrowserHost.prototype.setSurfaceActive.call(fixture, false);
  BrowserHost.prototype.setSurfaceActive.call(fixture, true);

  assert.deepEqual(visibility, [
    { active: false, boundsReady: true },
    { active: true, boundsReady: true },
  ]);
  assert.equal(fixture.boundsReady, true);
});

test("hidden turn tabs receive an explicit renderer viewport before moving offscreen", () => {
  const events = [];
  const tab = {
    id: "tab-hidden-viewport",
    status: "running",
    rendererReady: true,
    deviceEmulationViewport: null,
    deviceEmulationDirty: true,
    view: {
      setBounds: bounds => events.push(["bounds", bounds]),
      setVisible: visible => events.push(["visible", visible]),
      webContents: {
        enableDeviceEmulation: options => events.push(["emulate", options]),
        disableDeviceEmulation: () => events.push(["disable-emulation"]),
      },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    visible: false,
    surfaceActive: false,
    boundsReady: false,
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    selectedTabId: tab.id,
    turnTabs: new Map([[tab.id, tab]]),
    authView: null,
    window: {
      getContentSize: () => [1120, 720],
      isMinimized: () => false,
      isVisible: () => true,
    },
    view: {
      setBounds: bounds => events.push(["home-bounds", bounds]),
      setVisible: visible => events.push(["home-visible", visible]),
    },
  });

  BrowserHost.prototype.syncViewVisibility.call(fixture);

  assert.deepEqual(events, [
    ["home-bounds", { x: 1121, y: 721, width: 1120, height: 720 }],
    ["home-visible", true],
    ["emulate", {
      screenPosition: "desktop",
      screenSize: { width: 1120, height: 720 },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize: { width: 1120, height: 720 },
      scale: 1,
    }],
    ["bounds", { x: 1121, y: 721, width: 1120, height: 720 }],
    ["visible", true],
  ]);
  assert.deepEqual(tab.deviceEmulationViewport, { width: 1120, height: 720 });
  assert.equal(tab.deviceEmulationDirty, false);
});

test("hidden primary checks retain a renderer viewport across resize and navigation, then restore native bounds", () => {
  const calls = [];
  let size = [1120, 720];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    primaryRendererReady: false, primaryDeviceEmulationDirty: true,
    primaryDeviceEmulationViewport: null,
    bounds: { x: 280, y: 64, width: 840, height: 656 },
    window: { getContentSize: () => size },
    view: {
      setBounds: value => calls.push(["bounds", value]), setVisible: value => calls.push(["visible", value]),
      webContents: {
        enableDeviceEmulation: value => calls.push(["emulate", value.viewSize]),
        disableDeviceEmulation: () => calls.push(["disable"]),
      },
    },
  });
  fixture.presentPrimaryView(false);
  assert.equal(calls.some(([event]) => event === "emulate"), false);
  fixture.primaryRendererReady = true;
  fixture.presentPrimaryView(false);
  assert.deepEqual(calls.slice(-3), [["emulate", { width: 1120, height: 720 }],
    ["bounds", { x: 1121, y: 721, width: 1120, height: 720 }], ["visible", true]]);
  fixture.presentPrimaryView(false);
  assert.equal(calls.filter(([event]) => event === "emulate").length, 1);
  fixture.primaryDeviceEmulationDirty = true;
  fixture.presentPrimaryView(false);
  size = [1280, 800];
  fixture.presentPrimaryView(false);
  assert.deepEqual(fixture.primaryDeviceEmulationViewport, { width: 1280, height: 800 });
  assert.equal(calls.filter(([event]) => event === "emulate").length, 3);
  fixture.presentPrimaryView(true);
  assert.deepEqual(calls.slice(-3), [["bounds", fixture.bounds], ["disable"], ["visible", true]]);
  assert.equal(fixture.primaryDeviceEmulationViewport, null);
});

test("turn tabs use the hidden viewport when the launcher window is hidden", () => {
  const events = [];
  const tab = {
    id: "tab-hidden-window",
    status: "running",
    rendererReady: true,
    deviceEmulationViewport: null,
    deviceEmulationDirty: true,
    view: {
      setBounds: bounds => events.push(["bounds", bounds]),
      setVisible: visible => events.push(["visible", visible]),
      webContents: {
        enableDeviceEmulation: options => events.push(["emulate", options]),
        disableDeviceEmulation: () => events.push(["disable-emulation"]),
      },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    visible: true,
    surfaceActive: true,
    boundsReady: true,
    bounds: { x: 280, y: 64, width: 840, height: 656 },
    selectedTabId: tab.id,
    turnTabs: new Map([[tab.id, tab]]),
    authView: null,
    window: {
      getContentSize: () => [1120, 720],
      isMinimized: () => false,
      isVisible: () => false,
    },
    view: {
      setBounds: bounds => events.push(["home-bounds", bounds]),
      setVisible: visible => events.push(["home-visible", visible]),
    },
  });

  BrowserHost.prototype.syncViewVisibility.call(fixture);

  assert.deepEqual(events, [
    ["home-bounds", { x: 1121, y: 721, width: 1120, height: 720 }],
    ["home-visible", true],
    ["emulate", {
      screenPosition: "desktop",
      screenSize: { width: 1120, height: 720 },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize: { width: 1120, height: 720 },
      scale: 1,
    }],
    ["bounds", { x: 1121, y: 721, width: 1120, height: 720 }],
    ["visible", true],
  ]);
  assert.deepEqual(tab.deviceEmulationViewport, { width: 1120, height: 720 });
});

test("new turn tabs defer device emulation until their renderer finishes loading", () => {
  const events = [];
  const tab = {
    id: "tab-loading-viewport",
    status: "running",
    rendererReady: false,
    deviceEmulationViewport: null,
    deviceEmulationDirty: true,
    view: {
      setBounds: bounds => events.push(["bounds", bounds]),
      setVisible: visible => events.push(["visible", visible]),
      webContents: {
        enableDeviceEmulation: () => assert.fail("emulation started before did-finish-load"),
        disableDeviceEmulation: () => assert.fail("emulation cleared before did-finish-load"),
      },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    window: {
      getContentSize: () => [1120, 720],
      isMinimized: () => false,
      isVisible: () => true,
    },
  });

  BrowserHost.prototype.presentTurnView.call(fixture, tab, false);

  assert.deepEqual(events, [
    ["bounds", { x: 1121, y: 721, width: 1120, height: 720 }],
    ["visible", true],
  ]);
  assert.equal(tab.deviceEmulationViewport, null);
  assert.equal(tab.deviceEmulationDirty, true);
});

test("visible turn tabs establish native bounds before clearing background emulation", () => {
  const events = [];
  const tab = {
    id: "tab-visible-viewport",
    status: "running",
    rendererReady: true,
    deviceEmulationViewport: { width: 1120, height: 720 },
    deviceEmulationDirty: true,
    view: {
      setBounds: bounds => events.push(["bounds", bounds]),
      setVisible: visible => events.push(["visible", visible]),
      webContents: {
        enableDeviceEmulation: options => events.push(["emulate", options]),
        disableDeviceEmulation: () => events.push(["disable-emulation"]),
      },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    visible: true,
    surfaceActive: true,
    boundsReady: true,
    bounds: { x: 280, y: 64, width: 840, height: 656 },
    selectedTabId: tab.id,
    turnTabs: new Map([[tab.id, tab]]),
    authView: null,
    window: {
      getContentSize: () => [1120, 720],
      isMinimized: () => false,
      isVisible: () => true,
    },
    view: {
      setBounds: bounds => events.push(["home-bounds", bounds]),
      setVisible: visible => events.push(["home-visible", visible]),
    },
  });

  BrowserHost.prototype.syncViewVisibility.call(fixture);

  assert.deepEqual(events, [
    ["home-bounds", { x: 1121, y: 721, width: 1120, height: 720 }],
    ["home-visible", true],
    ["bounds", { x: 280, y: 64, width: 840, height: 656 }],
    ["disable-emulation"],
    ["visible", true],
  ]);
  assert.equal(tab.deviceEmulationViewport, null);
  assert.equal(tab.deviceEmulationDirty, false);
});

test("manual browser operations wait for the first measured surface", async () => {
  let readinessReads = 0;
  const fixture = {
    surfaceActive: true,
    get boundsReady() {
      readinessReads += 1;
      return readinessReads >= 3;
    },
  };

  await BrowserHost.prototype.waitForSurfaceReady.call(fixture, 1_000, 1);

  assert.equal(readinessReads, 3);
});

test("manual browser operations fail closed without measured surface bounds", async () => {
  await assert.rejects(
    BrowserHost.prototype.waitForSurfaceReady.call(
      { surfaceActive: true, boundsReady: false },
      2,
      1,
    ),
    /did not receive measured bounds/,
  );
});

test("browser bounds are clipped to the launcher content area", () => {
  assert.deepEqual(
    constrainBrowserBounds({ x: 260, y: 78, width: 1000, height: 900 }, { width: 1200, height: 800 }),
    { x: 260, y: 78, width: 940, height: 722 },
  );
  assert.deepEqual(
    constrainBrowserBounds({ x: -20, y: -10, width: 0, height: 0 }, { width: 1200, height: 800 }),
    { x: 0, y: 0, width: 1, height: 1 },
  );
});

test("zoomed renderer bounds are converted back to native window coordinates", () => {
  assert.deepEqual(
    scaleBrowserBounds({ x: 200, y: 60, width: 800, height: 500 }, 1.25),
    { x: 250, y: 75, width: 1000, height: 625 },
  );
  assert.throws(
    () => scaleBrowserBounds({ x: 1, y: 1, width: 1, height: 1 }, 0),
    /zoom factor must be positive/,
  );
});

test("shell zoom shortcuts recognize native CommandOrControl keys only", () => {
  const keyDown = { type: "keyDown", key: "=", meta: true, control: false, alt: false };

  assert.equal(shellZoomActionForInput(keyDown, "darwin"), "in");
  assert.equal(shellZoomActionForInput({ ...keyDown, key: "-" }, "darwin"), "out");
  assert.equal(shellZoomActionForInput({ ...keyDown, key: "0" }, "darwin"), "reset");
  assert.equal(
    shellZoomActionForInput({ ...keyDown, meta: false, control: true }, "win32"),
    "in",
  );
  assert.equal(shellZoomActionForInput({ ...keyDown, meta: false }, "darwin"), null);
  assert.equal(shellZoomActionForInput({ ...keyDown, key: "r" }, "darwin"), null);
  assert.equal(shellZoomActionForInput({ ...keyDown, type: "keyUp" }, "darwin"), null);
  assert.equal(shellZoomActionForInput({ ...keyDown, alt: true }, "darwin"), null);
});

test("authentication windows stay inside the launcher-owned browser partition", () => {
  assert.equal(allowedAuthUrl("https://accounts.google.com/o/oauth2/v2/auth"), true);
  assert.equal(allowedAuthUrl("https://m365.cloud.microsoft/chat"), true);
  assert.equal(allowedAuthUrl("https://login.microsoftonline.com/common/oauth2/authorize"), true);
  assert.equal(allowedAuthUrl("https://platform.openai.com/settings/organization/tunnels"), false);
  assert.equal(allowedAuthUrl("https://example.com/login"), false);
  const source = fs.readFileSync(require.resolve("../electron/browser/browser-host.cjs"), "utf8");
  assert.match(source, /createWindow:\s*\(options\)\s*=>\s*this\.createAuthView\(options,\s*url\)/);
  assert.match(source, /webContents:\s*options\.webContents/);
  assert.doesNotMatch(source, /loginWithSystemBrowser|captureSystemBrowserLogin|system_login_started/);
});

test("in-page account navigation schedules authentication refresh only for the main frame", async () => {
  const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} });
  let checks = 0;
  const fixture = { view: { webContents: contents }, setState() {},
    refreshAuthenticationFromSession: async () => { checks += 1; },
  };
  BrowserHost.prototype.bindWebContents.call(fixture);
  contents.emit("did-navigate-in-page", {}, "https://m365.cloud.microsoft/chat", false);
  assert.equal(checks, 0);
  contents.emit("did-navigate-in-page", {}, "https://m365.cloud.microsoft/chat", true);
  assert.equal(checks, 1);
});

test("launcher quit remains gated through an active embedded-browser operation", () => {
  const source = fs.readFileSync(require.resolve("../electron/main.cjs"), "utf8");
  assert.match(
    source,
    /runtimeHost\?\.currentOperation\(\) \|\| browserHost\?\.currentOperation\(\)/,
  );
});

test("logout clears only the owned M365 Copilot session and returns to the sign-in surface", async () => {
  const calls = [];
  let currentUrl = "https://m365.cloud.microsoft/chat";
  const authView = { webContents: { isDestroyed: () => false } };
  const fixture = {
    authView,
    authenticatedByProvider: { m365: true },
    state: { authenticated: true, status: "ready" },
    view: {
      webContents: {
        getURL: () => currentUrl,
        loadURL: async (url) => {
          calls.push(["loadURL", url]);
          currentUrl = url;
        },
        session: {
          clearStorageData: async () => calls.push(["clearStorageData"]),
        },
      },
    },
    closeAuthView(view, closeContents, refreshMain) {
      calls.push(["closeAuthView", view, closeContents, refreshMain]);
      this.authView = null;
    },
    setState(patch) {
      this.state = { ...this.state, ...patch };
      calls.push(["setState", patch]);
    },
    probeAuthentication: async function () {
      this.state = { ...this.state, authenticated: false, status: "signed-out" };
      calls.push(["probeAuthentication"]);
      return this.snapshot();
    },
    activateHomeSurface() { calls.push(["activateHomeSurface"]); },
    show() { calls.push(["show"]); },
    snapshot() { return { ...this.state, url: currentUrl }; },
    logger: { info(event) { calls.push(["log", event]); } },
    withManualOperation: async (name, action) => {
      calls.push(["manualOperation", name]);
      return await action();
    },
  };

  const result = await BrowserHost.prototype.logout.call(fixture);

  assert.equal(result.authenticated, false);
  assert.equal(result.status, "signed-out");
  assert.equal(fixture.authenticatedByProvider.m365, false);
  assert.deepEqual(calls[0], ["manualOperation", "M365 Copilot logout"]);
  assert.deepEqual(calls[1], ["closeAuthView", authView, true, false]);
  assert.deepEqual(calls[2], ["clearStorageData"]);
  assert.deepEqual(calls[4], ["loadURL", "https://m365.cloud.microsoft/chat"]);
  assert.ok(calls.some(([name]) => name === "activateHomeSurface"));
  assert.ok(calls.some(([name]) => name === "show"));
});

test("launcher shutdown persists M365 Copilot DOM storage and cookies before browser destruction", async () => {
  const calls = [];
  const fixture = {
    view: {
      webContents: {
        isDestroyed: () => false,
        session: {
          flushStorageData: () => calls.push("storage"),
          cookies: { flushStore: async () => calls.push("cookies") },
        },
      },
    },
  };

  await BrowserHost.prototype.persistSession.call(fixture);

  assert.deepEqual(calls, ["storage", "cookies"]);
});

test("browser chrome navigation delegates to WebContents navigation history", () => {
  const { calls, webContents } = createContents();
  navigateBrowser(webContents, "back");
  navigateBrowser(webContents, "forward");
  navigateBrowser(webContents, "reload");

  assert.deepEqual(calls, ["back", "reload"]);
  assert.throws(() => navigateBrowser(webContents, "unknown"), /Unknown browser navigation action/);
});

test("browser zoom in, out, and reset are symmetric across owned views", () => {
  const home = createContents();
  const turn = createContents();
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    state: { zoomFactor: 1 },
    view: { webContents: home.webContents },
    turnTabs: new Map([["turn", { view: { webContents: turn.webContents } }]]),
    snapshot() { return { zoomFactor: this.state.zoomFactor }; },
    setState(patch) { this.state = { ...this.state, ...patch }; },
    publishState() {},
  });

  assert.equal(BrowserHost.prototype.zoom.call(fixture, "in").zoomFactor, 1.1);
  assert.equal(BrowserHost.prototype.zoom.call(fixture, "out").zoomFactor, 1);
  BrowserHost.prototype.zoom.call(fixture, "in");
  assert.equal(BrowserHost.prototype.zoom.call(fixture, "reset").zoomFactor, 1);
  assert.deepEqual(home.calls.filter((call) => Array.isArray(call) && call[0] === "zoom"), [
    ["zoom", 1.1],
    ["zoom", 1],
    ["zoom", 1.1],
    ["zoom", 1],
  ]);
  assert.deepEqual(turn.calls.filter((call) => Array.isArray(call) && call[0] === "zoom"), [
    ["zoom", 1.1],
    ["zoom", 1],
    ["zoom", 1.1],
    ["zoom", 1],
  ]);
  assert.throws(() => BrowserHost.prototype.zoom.call(fixture, "fit"), /Unknown browser zoom action/);
});

test("Command zoom changes only the launcher shell while browser zoom stays independent", () => {
  const focusedBrowserContents = new EventEmitter();
  focusedBrowserContents.isDestroyed = () => false;
  let shellZoomLevel = 0;
  const shellContents = {
    getZoomLevel: () => shellZoomLevel,
    isDestroyed: () => false,
    setZoomLevel: (next) => { shellZoomLevel = next; },
  };
  const originalBounds = { x: 280, y: 76, width: 840, height: 644 };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    state: { zoomFactor: 1 },
    bounds: originalBounds,
    window: { webContents: shellContents },
    shellZoomShortcutBindings: new Map(),
    logger: { error() {} },
  });
  let prevented = 0;

  BrowserHost.prototype.bindShellZoomShortcuts.call(fixture, focusedBrowserContents);
  focusedBrowserContents.emit(
    "before-input-event",
    { preventDefault: () => { prevented += 1; } },
    {
      type: "keyDown",
      key: "=",
      meta: process.platform === "darwin",
      control: process.platform !== "darwin",
      alt: false,
    },
  );

  assert.equal(prevented, 1);
  assert.equal(shellZoomLevel, 0.5);
  assert.equal(fixture.state.zoomFactor, 1);
  assert.deepEqual(fixture.bounds, originalBounds);
});

test("browser chrome state is read from the owned WebContents", () => {
  const { webContents } = createContents();
  const state = readBrowserNavigationState(webContents, {
    title: "Fallback",
    url: "about:blank",
    loading: true,
    canGoBack: false,
    canGoForward: true,
  });
  assert.deepEqual(state, {
    title: "M365 Copilot",
    url: "https://m365.cloud.microsoft/chat",
    loading: false,
    canGoBack: true,
    canGoForward: false,
  });
  assert.equal(readBrowserNavigationState(webContents, {
    title: "Task tab",
    url: "about:blank",
    loading: true,
    canGoBack: false,
    canGoForward: true,
  }, { readPageTitle: false }).title, "Task tab");
});

test("a live helper retains exclusive ownership of its running turn", async () => {
  const tab = {
    id: "tab-live-owner",
    traceId: "trace_live_owner",
    helperPid: process.pid,
    status: "running",
    interactionMode: "automatic",
  };
  await assert.rejects(
    BrowserHost.prototype.beginTurn.call({
      manualOperation: null,
      turnTabs: new Map([[tab.id, tab]]),
      userCancelledTurnOwners: new Map(),
    }, tab.traceId, false, process.pid + 1),
    /owned by another helper process/,
  );
});

test("a replacement helper takes over only after the previous owner exited", async () => {
  const deadPid = 2_147_483_647;
  const tab = {
    id: "tab-dead-owner",
    surfaceId: "surface-dead-owner",
    traceId: "trace_dead_owner",
    helperPid: deadPid,
    status: "running",
    interactionMode: "automatic",
    loading: true,
    message: "ChatGPT is working",
    view: {
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling() {},
      },
    },
  };
  const warnings = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    turnTabs: new Map([[tab.id, tab]]),
    userCancelledTurnOwners: new Map(),
    selectedTabId: "home",
    syncViewVisibility() {},
    snapshot: () => ({ tabs: [] }),
    publishState() {},
    writeDescriptor() {},
    logger: { info() {}, warn: (event, detail) => warnings.push([event, detail]) },
  });

  const lease = await BrowserHost.prototype.beginTurn.call(fixture, tab.traceId, false, process.pid);

  assert.deepEqual(lease, {
    surfaceId: tab.surfaceId,
    tabId: tab.id,
    reused: false,
    connectorBound: false,
  });
  assert.equal(tab.helperPid, process.pid);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], "browser.stale_turn_owner_replaced");
  assert.equal(warnings[0][1].previousHelperPid, deadPid);
});

test("a live turn heartbeat refreshes its lease and rejects another helper", () => {
  const tab = {
    id: "tab-heartbeat",
    traceId: "trace_heartbeat",
    helperPid: 444,
    status: "running",
    lastHeartbeatAt: 1,
    deviceEmulationDirty: false,
  };
  let visibilitySyncs = 0;
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    syncViewVisibility: () => { visibilitySyncs += 1; },
    snapshot: () => ({ activeTabId: tab.id }),
  });

  const before = Date.now();
  const snapshot = BrowserHost.prototype.heartbeatTurn.call(fixture, tab.traceId, tab.helperPid, true);

  assert.deepEqual(snapshot, { activeTabId: tab.id });
  assert.ok(tab.lastHeartbeatAt >= before);
  assert.equal(tab.deviceEmulationDirty, true);
  assert.equal(visibilitySyncs, 1);
  assert.throws(
    () => BrowserHost.prototype.heartbeatTurn.call(fixture, tab.traceId, 445),
    /ownership mismatch: expected 444, received 445/,
  );
  assert.throws(
    () => BrowserHost.prototype.heartbeatTurn.call(fixture, tab.traceId, tab.helperPid, "yes"),
    /refreshViewport is invalid/,
  );
});

test("a viewport-refresh heartbeat reapplies hidden emulation before CDP reconnect", () => {
  const events = [];
  const tab = {
    id: "tab-refresh-viewport",
    traceId: "trace_refresh_viewport",
    helperPid: 446,
    status: "running",
    lastHeartbeatAt: 1,
    rendererReady: true,
    deviceEmulationViewport: { width: 1120, height: 720 },
    deviceEmulationDirty: false,
    view: {
      setBounds: bounds => events.push(["bounds", bounds]),
      setVisible: visible => events.push(["visible", visible]),
      webContents: {
        enableDeviceEmulation: options => events.push(["emulate", options]),
        disableDeviceEmulation: () => events.push(["disable-emulation"]),
      },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    visible: false,
    surfaceActive: true,
    boundsReady: true,
    bounds: { x: 280, y: 64, width: 840, height: 656 },
    selectedTabId: tab.id,
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    authView: null,
    window: {
      getContentSize: () => [1120, 720],
      isMinimized: () => false,
      isVisible: () => false,
    },
    view: {
      setBounds: bounds => events.push(["home-bounds", bounds]),
      setVisible: visible => events.push(["home-visible", visible]),
    },
    snapshot: () => ({ activeTabId: tab.id }),
  });

  BrowserHost.prototype.heartbeatTurn.call(fixture, tab.traceId, tab.helperPid, true);

  assert.equal(events.filter(([kind]) => kind === "emulate").length, 1);
  assert.deepEqual(tab.deviceEmulationViewport, { width: 1120, height: 720 });
  assert.equal(tab.deviceEmulationDirty, false);
});

test("an expired browser surface cancels its runtime before releasing the tab", async () => {
  const closed = [];
  const warnings = [];
  const cancellations = [];
  let acknowledge;
  const cancelled = new Promise(resolve => { acknowledge = resolve; });
  const tab = {
    id: "tab-orphan",
    traceId: "trace_orphan",
    helperPid: 555,
    status: "running",
    loading: true,
    bootstrapReady: false,
    bootstrapDeadlineAt: 100,
    lastHeartbeatAt: 100,
    view: {
      webContents: {
        isDestroyed: () => false,
        close: () => closed.push("contents"),
      },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]),
    cancelTurn: (traceId, reason) => { cancellations.push({ traceId, reason }); return cancelled; },
    closedTurnOwners: new Map(),
    selectedTabId: tab.id,
    window: { contentView: { removeChildView: () => closed.push("view") } },
    syncViewVisibility() {},
    snapshot: () => ({ tabs: [] }),
    publishState() {},
    writeDescriptor() {},
    logger: { warn: (event, detail) => warnings.push([event, detail]) },
  });

  const cleanup = BrowserHost.prototype.reapExpiredTurnTabs.call(fixture, 101);
  BrowserHost.prototype.reapExpiredTurnTabs.call(fixture, 102);
  await Promise.resolve();
  assert.deepEqual(cancellations, [{ traceId: tab.traceId, reason: "browser_surface_bootstrap_timeout" }]);
  assert.equal(fixture.turnTabs.has(tab.id), true);
  assert.deepEqual(closed, []);
  acknowledge();
  await cleanup;

  assert.equal(fixture.turnTabs.size, 0);
  assert.equal(fixture.selectedTabId, "home");
  assert.equal(fixture.closedTurnOwners.get(tab.traceId), tab.helperPid);
  assert.deepEqual(closed, ["view", "contents"]);
  assert.deepEqual(warnings, ["browser.orphan_turn_expired", "browser.orphan_turn_reaped"].map(event => [event, {
    tabId: tab.id,
    traceId: tab.traceId,
    helperPid: tab.helperPid,
    evidence: "browser_surface_bootstrap_timeout",
  }]));
});

test("expiry cancellation preserves a changed owner and keeps failed cleanup visible", async () => {
  for (const outcome of ["reused", "failed"]) {
    const removed = [], warnings = [];
    const tab = { id: "expiry-race", traceId: "trace_expiry", helperPid: 123,
      status: "running", bootstrapReady: true, lastHeartbeatAt: 0 };
    const fixture = Object.assign(Object.create(BrowserHost.prototype), {
      turnTabs: new Map([[tab.id, tab]]),
      cancelTurn: async () => {
        if (outcome === "failed") throw new Error("control unavailable");
        tab.traceId = "trace_replacement";
      },
      removeTurnTab: () => removed.push(tab.id),
      logger: { warn: event => warnings.push(event) },
    });
    await fixture.reapExpiredTurnTabs(120_000);
    assert.deepEqual(removed, []);
    assert.equal(fixture.turnTabs.get(tab.id), tab);
    assert.equal(tab.expiryCancellation, undefined);
    assert.equal(warnings.includes("browser.orphan_turn_cancel_failed"), outcome === "failed");
    assert.equal(warnings.includes("browser.orphan_turn_reaped"), outcome !== "failed");
  }
});

test("removing the final turn tab keeps the descriptor-owned idle host attached offscreen", () => {
  const calls = [];
  const hiddenBounds = { x: 1201, y: 801, width: 1200, height: 800 };
  const tab = {
    id: "tab-gray-host",
    traceId: "trace_gray_host",
    helperPid: 666,
    status: "aborted",
    view: {
      webContents: {
        isDestroyed: () => false,
        close: () => calls.push("contents-close"),
      },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    selectedTabId: tab.id,
    visible: true,
    surfaceActive: true,
    boundsReady: true,
    bounds: { x: 200, y: 100, width: 900, height: 650 },
    window: {
      contentView: { removeChildView: () => calls.push("view-remove") },
      isVisible: () => true,
      isMinimized: () => false,
    },
    view: {
      setBounds: bounds => calls.push(["home-bounds", bounds]),
      setVisible: visible => calls.push(["home-visible", visible]),
      webContents: { getURL: () => IDLE_BROWSER_URL },
    },
    hiddenTurnBounds: () => hiddenBounds,
    authView: null,
    syncPowerSaveBlocker() {},
    setState() {},
    snapshot: () => ({ tabs: [] }),
    publishState() {},
    writeDescriptor() {},
  });

  BrowserHost.prototype.removeTurnTab.call(fixture, tab, false);

  assert.equal(fixture.selectedTabId, "home");
  assert.equal(fixture.visible, false);
  assert.deepEqual(calls, [
    "view-remove",
    "contents-close",
    ["home-bounds", hiddenBounds],
    ["home-visible", true],
    ["home-bounds", hiddenBounds],
    ["home-visible", true],
  ]);
});

test("launcher session refresh navigates idle surface to M365 Copilot and probes authentication", async () => {
  const calls = [];
  const fixture = {
    primaryViewManager: {},
    parkIdlePrimaryView: () => calls.push(["park"]),
    syncViewVisibility: () => calls.push(["sync"]),
    probeAuthentication: async () => {
      calls.push(["probe"]);
      return { authenticated: true };
    },
    view: {
      webContents: {
        getURL: () => IDLE_BROWSER_URL,
        loadURL: async (url) => calls.push(["load", url]),
      },
    },
  };

  const state = await BrowserHost.prototype.refreshAuthentication.call(fixture);

  assert.deepEqual(state, { authenticated: true });
  assert.deepEqual(calls, [
    ["load", "https://m365.cloud.microsoft/chat"],
    ["probe"],
    ["park"],
    ["sync"],
  ]);
});

test("concurrent authentication probes share the same probe operation and allow the next probe", async () => {
  let probes = 0;
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    authenticationRevision: 0,
    authenticationProbe: null,
    turnTabs: new Map(),
    state: { authenticated: false },
    view: { webContents: {
      isDestroyed: () => false,
      getURL: () => "https://m365.cloud.microsoft/chat",
      executeJavaScript: async () => {
        probes += 1;
        await ready;
        return { authenticated: true, composer: true, url: "https://m365.cloud.microsoft/chat", readyState: "complete" };
      },
    } },
    setState(patch) { this.state = { ...this.state, ...patch }; },
    snapshot() { return this.state; },
    logger: { info() {} },
  });

  const first = fixture.probeAuthentication();
  const second = fixture.probeAuthentication();
  release();
  await Promise.all([first, second]);
  assert.equal(probes, 1);
  await fixture.probeAuthentication();
  assert.equal(probes, 2);
});

test("manual browser operations disable background throttling until completion", async () => {
  const throttling = [];
  const surfaces = [];
  const fixture = {
    ready: async () => surfaces.push("ready"),
    activeTraceId: null,
    manualOperation: null,
    activateHomeSurface: () => surfaces.push("home"),
    setState() {},
    view: {
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling: (enabled) => throttling.push(enabled),
      },
    },
  };

  const result = await BrowserHost.prototype.withManualOperation.call(fixture, "hidden check", async () => "ok");

  assert.equal(result, "ok");
  assert.deepEqual(surfaces, ["ready", "home"]);
  assert.deepEqual(throttling, [false, true]);
  assert.equal(fixture.manualOperation, null);
});

test("manual operations show the home surface without discarding retained task tabs", () => {
  const events = [];
  const taskTab = { id: "tab-ready", status: "ready" };
  const fixture = {
    selectedTabId: taskTab.id,
    turnTabs: new Map([[taskTab.id, taskTab]]),
    visible: true,
    surfaceActive: true,
    activeView: () => ({ webContents: { focus: () => events.push("focus") } }),
    syncViewVisibility: () => events.push("visibility"),
    snapshot: () => ({ activeTabId: "home" }),
    publishState: () => events.push("publish"),
    writeDescriptor: () => events.push("descriptor"),
  };

  BrowserHost.prototype.activateHomeSurface.call(fixture);

  assert.equal(fixture.selectedTabId, "home");
  assert.equal(fixture.turnTabs.size, 1);
  assert.deepEqual(events, ["visibility", "focus", "publish", "descriptor"]);
});

test("selected home surface remains represented while task tabs are retained", () => {
  const { webContents } = createContents();
  const taskTab = { id: "tab-ready", traceId: "trace_ready" };
  const fixture = {
    selectedTabId: "home",
    turnTabs: new Map([[taskTab.id, taskTab]]),
    state: {
      title: "ChatGPT",
      status: "signed-out",
      loading: false,
      visible: true,
      surfaceActive: true,
    },
    visible: true,
    surfaceActive: true,
    activeView: () => ({ webContents }),
    selectedTurnTab: () => null,
    tabSnapshot: (tab) => ({ id: tab.id, traceId: tab.traceId, active: false }),
  };

  const snapshot = BrowserHost.prototype.snapshot.call(fixture);

  assert.equal(snapshot.activeTabId, "home");
  assert.deepEqual(snapshot.tabs.map((tab) => tab.id), ["home", "tab-ready"]);
  assert.equal(snapshot.tabs[0].active, true);
});

test("selecting a task tab shows and focuses its owned Playwright surface", () => {
  const visibility = [];
  const focused = [];
  const makeView = (id) => ({
    setBounds() {},
    setVisible: (visible) => visibility.push([id, visible]),
    webContents: {
      disableDeviceEmulation() {},
      enableDeviceEmulation() {},
      focus: () => focused.push(id),
    },
  });
  const first = { id: "tab-first", status: "running", view: makeView("first") };
  const second = { id: "tab-second", status: "running", view: makeView("second") };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    view: makeView("home"),
    turnTabs: new Map([[first.id, first], [second.id, second]]),
    selectedTabId: first.id,
    visible: true,
    surfaceActive: true,
    boundsReady: true,
    bounds: { x: 260, y: 78, width: 800, height: 600 },
    authView: null,
    window: {
      getContentSize: () => [1120, 720],
      isMinimized: () => false,
      isVisible: () => true,
    },
    snapshot: () => ({ activeTabId: fixture.selectedTabId }),
    publishState() {},
    writeDescriptor() {},
  });

  const state = BrowserHost.prototype.selectTab.call(fixture, second.id);

  assert.equal(fixture.selectedTabId, second.id);
  assert.deepEqual(visibility, [
    ["home", true],
    ["first", true],
    ["second", true],
  ]);
  assert.deepEqual(focused, ["second"]);
  assert.equal(state.activeTabId, second.id);
});

test("a stale helper cannot end a replacement turn with the same trace id", async () => {
  const turnTabs = new Map([["tab-1", {
    id: "tab-1",
    traceId: "trace_same_retry",
    helperPid: 222,
  }]]);
  await assert.rejects(
    BrowserHost.prototype.endTurn.call(
      { turnTabs, closedTurnOwners: new Map() },
      "trace_same_retry",
      111,
      "failed",
      false,
      "stale helper exited",
    ),
    /Browser helper ownership mismatch: expected 222, received 111/,
  );
});

test("closing a running browser tab reports terminal user cancellation to its helper", async () => {
  const closed = [];
  const tab = {
    id: "tab-running",
    traceId: "trace_running",
    helperPid: 333,
    status: "running",
    view: {
      webContents: { isDestroyed: () => false, close: () => closed.push("contents") },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    userCancelledTurnOwners: new Map(),
    selectedTabId: tab.id,
    window: { contentView: { removeChildView: () => closed.push("view") } },
    syncViewVisibility() {},
    snapshot: () => ({ tabs: [] }),
    publishState() {},
    writeDescriptor() {},
    cancelTurn: async (traceId) => closed.push(`cancel:${traceId}`),
    logger: { info() {} },
  });

  await BrowserHost.prototype.closeTab.call(fixture, tab.id);

  assert.deepEqual(closed, ["cancel:trace_running", "view", "contents"]);
  assert.equal(fixture.closedTurnOwners.get("trace_running"), 333);
  assert.equal(fixture.userCancelledTurnOwners.get("trace_running"), 333);
  assert.equal(fixture.selectedTabId, "home");
  await assert.rejects(
    BrowserHost.prototype.beginTurn.call(fixture, tab.traceId, false, 444),
    error => error?.code === "turn_cancelled",
  );

  assert.deepEqual(
    await BrowserHost.prototype.endTurn.call(
      fixture,
      tab.traceId,
      tab.helperPid,
      "failed",
      false,
      "page closed",
    ),
    { cancelledByUser: true },
  );
  assert.equal(fixture.closedTurnOwners.has("trace_running"), false);
  assert.equal(fixture.userCancelledTurnOwners.get("trace_running"), 333);
});

test("a failed runtime cancellation keeps the running DOM attached", async () => {
  const closed = [];
  const tab = {
    id: "tab-cancel-failed",
    traceId: "trace_cancel_failed",
    helperPid: 334,
    status: "running",
    view: {
      webContents: { isDestroyed: () => false, close: () => closed.push("contents") },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    userCancelledTurnOwners: new Map(),
    selectedTabId: tab.id,
    window: { contentView: { removeChildView: () => closed.push("view") } },
    syncViewVisibility() {},
    snapshot: () => ({ tabs: [] }),
    publishState() {},
    writeDescriptor() {},
    cancelTurn: async () => { throw new Error("runtime cancellation unavailable"); },
    logger: { info() {} },
  });

  await assert.rejects(
    BrowserHost.prototype.closeTab.call(fixture, tab.id),
    /runtime cancellation unavailable/,
  );

  assert.equal(fixture.turnTabs.get(tab.id), tab);
  assert.equal(tab.status, "running");
  assert.deepEqual(closed, []);
});

test("a later provider round reuses only its exact connector-bound conversation", async () => {
  const throttling = [];
  const conversationKey = "a".repeat(64);
  const tab = {
    id: "tab-reused",
    surfaceId: "surface-reused",
    traceId: "trace_previous",
    conversationKey,
    connectorIdentity: "Codex Native2",
    connectorBound: true,
    interactionMode: "automatic",
    helperPid: 111,
    status: "ready",
    loading: false,
    message: "Task completed",
    bootstrapReady: true,
    view: {
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling: (enabled) => throttling.push(enabled),
      },
    },
  };
  const events = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    turnTabs: new Map([[tab.id, tab]]),
    userCancelledTurnOwners: new Map(),
    selectedTabId: "home",
    syncViewVisibility: () => events.push("visible"),
    snapshot: () => ({ tabs: [] }),
    publishState: () => events.push("published"),
    writeDescriptor: () => events.push("descriptor"),
    logger: { info: (event) => events.push(event) },
  });

  const lease = await BrowserHost.prototype.beginTurn.call(
    fixture,
    "trace_next",
    false,
    222,
    conversationKey,
    "Codex Native2",
  );

  assert.deepEqual(lease, {
    surfaceId: "surface-reused",
    tabId: "tab-reused",
    reused: true,
    connectorBound: true,
  });
  assert.equal(tab.traceId, "trace_next");
  assert.equal(tab.helperPid, 222);
  assert.equal(tab.status, "running");
  assert.equal(tab.loading, true);
  assert.equal(tab.message, "M365 Copilot is working");
  assert.equal(tab.bootstrapReady, true);
  assert.equal(fixture.selectedTabId, tab.id);
  assert.deepEqual(throttling, [false]);
  assert.deepEqual(events, ["visible", "published", "descriptor"]);
});

test("a retained conversation is not reused for a different connector identity", async () => {
  const conversationKey = "b".repeat(64);
  const retained = {
    id: "retained",
    traceId: "trace_old",
    status: "ready",
    conversationKey,
    connectorIdentity: "Codex Native2",
    connectorBound: true,
    interactionMode: "automatic",
  };
  const created = { id: "fresh", surfaceId: "surface-fresh" };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    turnTabs: new Map([[retained.id, retained]]),
    userCancelledTurnOwners: new Map(),
    createTurnTab: (...args) => {
      assert.deepEqual(args, ["trace_next", 222, conversationKey, "Other Connector", undefined, "m365"]);
      return created;
    },
    writeDescriptor() {},
    syncViewVisibility() {},
    publishState() {},
    snapshot: () => ({ tabs: [] }),
    logger: { info() {} },
  });

  const lease = await BrowserHost.prototype.beginTurn.call(
    fixture,
    "trace_next",
    false,
    222,
    conversationKey,
    "Other Connector",
  );

  assert.deepEqual(lease, {
    surfaceId: "surface-fresh",
    tabId: "fresh",
    reused: false,
    connectorBound: false,
  });
  assert.equal(retained.status, "ready");
});

test("a connector conversation is not reused until its connector was bound", async () => {
  const conversationKey = "c".repeat(64);
  const retained = {
    id: "retained",
    traceId: "trace_old",
    status: "ready",
    conversationKey,
    connectorIdentity: "Codex Native2",
    connectorBound: false,
    interactionMode: "automatic",
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    turnTabs: new Map([[retained.id, retained]]),
    userCancelledTurnOwners: new Map(),
    createTurnTab: () => ({ id: "fresh", surfaceId: "surface-fresh" }),
    writeDescriptor() {},
    syncViewVisibility() {},
    publishState() {},
    snapshot: () => ({ tabs: [] }),
    logger: { info() {} },
  });

  assert.deepEqual(
    await BrowserHost.prototype.beginTurn.call(
      fixture,
      "trace_next",
      false,
      222,
      conversationKey,
      "Codex Native2",
    ),
    {
      surfaceId: "surface-fresh",
      tabId: "fresh",
      reused: false,
      connectorBound: false,
    },
  );
});

test("a required retained conversation fails before creating a browser tab", async () => {
  let created = false;
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    turnTabs: new Map(),
    userCancelledTurnOwners: new Map(),
    createTurnTab: () => {
      created = true;
      throw new Error("must not allocate a replacement tab");
    },
  });

  await assert.rejects(
    BrowserHost.prototype.beginTurn.call(
      fixture,
      "trace_next",
      false,
      222,
      "d".repeat(64),
      undefined,
      true,
    ),
    (error) => error?.code === "retained_conversation_unavailable"
      && /retained M365 Copilot conversation is no longer available/.test(error.message),
  );
  assert.equal(created, false);
});

test("five browser tabs are a hard account-safety limit", async () => {
  const turnTabs = new Map(Array.from({ length: 5 }, (_unused, index) => [
    `tab-${index + 1}`,
    { ordinal: index + 1 },
  ]));

  await assert.rejects(
    BrowserHost.prototype.createTurnTab.call({ turnTabs }, "trace_six", 444),
    /already has 5 browser tabs.*avoid excessive parallel traffic/,
  );
});

test("a full browser host evicts only its oldest ready tab", () => {
  const oldest = { id: "oldest", ordinal: 1, status: "ready", lastHeartbeatAt: 10 };
  const newer = { id: "newer", ordinal: 2, status: "ready", lastHeartbeatAt: 20 };
  const running = [3, 4, 5].map((ordinal) => ({
    id: `running-${ordinal}`,
    ordinal,
    status: "running",
    lastHeartbeatAt: 1,
  }));
  const removed = [];
  const fixture = {
    turnTabs: new Map([oldest, newer, ...running].map(tab => [tab.id, tab])),
    removeTurnTab(tab, abortRunning) {
      removed.push([tab.id, abortRunning]);
      this.turnTabs.delete(tab.id);
    },
    window: {
      contentView: { addChildView() {} },
    },
  };

  assert.equal(BrowserHost.prototype.evictOldestRetainedTurnTab.call(fixture), true);
  assert.deepEqual(removed, [["oldest", false]]);
  assert.equal(fixture.turnTabs.has("running-3"), true);
});

test("ending one browser turn does not stop another running tab", async () => {
  let closedViews = 0;
  let removedViews = 0;
  const ended = {
    id: "tab-ended",
    traceId: "trace_ended",
    helperPid: 555,
    status: "running",
    loading: true,
    view: { webContents: { isDestroyed: () => false, setBackgroundThrottling() {}, close: () => { closedViews += 1; } } },
  };
  const active = {
    id: "tab-active",
    traceId: "trace_active",
    helperPid: 666,
    status: "running",
    loading: true,
    view: { webContents: { isDestroyed: () => false, setBackgroundThrottling() {} } },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[ended.id, ended], [active.id, active]]),
    closedTurnOwners: new Map(),
    userCancelledTurnOwners: new Map(),
    selectedTabId: ended.id,
    window: { contentView: { removeChildView: (view) => {
      assert.equal(view, ended.view);
      removedViews += 1;
    } } },
    syncViewVisibility() {},
    writeDescriptor() {},
    publishState() {},
    snapshot: () => ({ tabs: [] }),
    hide: () => assert.fail("a second running tab must keep the browser host active"),
    logger: { info() {} },
  });

  await BrowserHost.prototype.endTurn.call(
    fixture,
    ended.traceId,
    ended.helperPid,
    "completed",
    true,
  );

  assert.equal(ended.status, "ready");
  assert.equal(fixture.turnTabs.has(ended.id), false);
  assert.equal(fixture.turnTabs.has(active.id), true);
  assert.equal(fixture.selectedTabId, active.id);
  assert.equal(closedViews, 1);
  assert.equal(removedViews, 1);
  assert.equal(active.status, "running");
  assert.equal(fixture.activeTraceId, active.traceId);
});

test("a completed keyed turn is retained for thirty minutes and preserves its acknowledgement", async () => {
  const throttling = [];
  const tab = {
    id: "tab-retained",
    surfaceId: "surface-retained",
    traceId: "trace_retained",
    conversationKey: "e".repeat(64),
    connectorIdentity: "Codex Native2",
    connectorBound: false,
    helperPid: 777,
    status: "running",
    loading: true,
    view: { webContents: {
      isDestroyed: () => false,
      setBackgroundThrottling: (enabled) => throttling.push(enabled),
    } },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    userCancelledTurnOwners: new Map(),
    selectedTabId: tab.id,
    syncViewVisibility() {},
    writeDescriptor() {},
    publishState() {},
    snapshot: () => ({ tabs: [] }),
    providerRegistry: {
      has: (id) => id === "m365",
      get: () => ({
        id: "m365",
        displayName: "M365 Copilot",
        normalizeConversationId: (id) => id,
        bind: (_key, id) => id,
      }),
    },
    hide() {},
    logger: { info() {} },
  });

  const result = await BrowserHost.prototype.endTurn.call(
    fixture,
    tab.traceId,
    tab.helperPid,
    "completed",
    true,
    undefined,
    true,
    true,
    "6704b2a8-5e88-400c-b26a-9bb7d24669f1",
  );

  assert.deepEqual(result, { cancelledByUser: false });
  assert.equal(fixture.turnTabs.get(tab.id), tab);
  assert.equal(tab.status, "ready");
  assert.equal(tab.connectorBound, true);
  assert.equal(Number.isFinite(tab.lastHeartbeatAt), true);
  assert.deepEqual(throttling, [true]);

  const retainedAt = tab.lastHeartbeatAt;
  BrowserHost.prototype.reapExpiredTurnTabs.call(fixture, retainedAt + (30 * 60 * 1000) - 1);
  assert.equal(fixture.turnTabs.has(tab.id), true);
});

test("a retained browser tab expires at thirty minutes", () => {
  const removed = [];
  const tab = {
    id: "tab-expired",
    traceId: "trace_expired",
    status: "ready",
    lastHeartbeatAt: 100,
  };
  const fixture = {
    turnTabs: new Map([[tab.id, tab]]),
    logger: { info() {} },
    removeTurnTab(candidate, abortRunning) {
      removed.push([candidate.id, abortRunning]);
      this.turnTabs.delete(candidate.id);
    },
  };

  BrowserHost.prototype.reapExpiredTurnTabs.call(fixture, 100 + (30 * 60 * 1000));

  assert.deepEqual(removed, [[tab.id, false]]);
  assert.equal(fixture.turnTabs.size, 0);
});

test("a completed connector turn without binding is released instead of retained", async () => {
  let closed = false;
  const tab = {
    id: "tab-unbound",
    traceId: "trace_unbound",
    conversationKey: "f".repeat(64),
    connectorIdentity: "Codex Native2",
    helperPid: 777,
    status: "running",
    loading: true,
    view: { webContents: {
      isDestroyed: () => false,
      setBackgroundThrottling() {},
      close: () => { closed = true; },
    } },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    userCancelledTurnOwners: new Map(),
    selectedTabId: tab.id,
    window: { contentView: { removeChildView() {} } },
    syncViewVisibility() {},
    writeDescriptor() {},
    publishState() {},
    snapshot: () => ({ tabs: [] }),
    hide() {},
    logger: { info() {} },
  });

  assert.deepEqual(await BrowserHost.prototype.endTurn.call(
    fixture,
    tab.traceId,
    tab.helperPid,
    "completed",
    true,
    undefined,
    true,
    false,
  ), { cancelledByUser: false });

  assert.equal(fixture.turnTabs.size, 0);
  assert.equal(closed, true);
});

test("failed and aborted browser turns release their tab slots", async () => {
  for (const status of ["failed", "aborted"]) {
    let closed = false;
    const tab = {
      id: `tab-${status}`,
      traceId: `trace_${status}`,
      helperPid: 777,
      status: "running",
      loading: true,
      view: { webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling() {},
        close: () => { closed = true; },
      } },
    };
    const fixture = Object.assign(Object.create(BrowserHost.prototype), {
      turnTabs: new Map([[tab.id, tab]]),
      closedTurnOwners: new Map(),
      userCancelledTurnOwners: new Map(),
      selectedTabId: tab.id,
      window: { contentView: { removeChildView() {} } },
      syncViewVisibility() {},
      writeDescriptor() {},
      publishState() {},
      snapshot: () => ({ tabs: [] }),
      hide() {},
      logger: { info() {} },
    });

    await BrowserHost.prototype.endTurn.call(
      fixture,
      tab.traceId,
      tab.helperPid,
      status,
      true,
      `turn ${status}`,
    );

    assert.equal(fixture.turnTabs.size, 0);
    assert.equal(fixture.selectedTabId, "home");
    assert.equal(tab.status, status === "aborted" ? "aborted" : "error");
    assert.equal(closed, true);
  }
});

test("off-on-off fresh conversation changes retire completed history before it can be reused", async () => {
  const vm = require("node:vm");
  const { releaseRetainedConversation } = require("../electron/browser/retained-turn-release.cjs");
  const ipcRouterSource = fs.readFileSync(resolve(__dirname, "../electron/app/ipc-router.cjs"), "utf8");
  for (const savedChats of [false, true]) {
    const property = savedChats ? "useSavedChats" : "experimentalFreshConversationPerTurn";
    const method = savedChats ? "setUseSavedChats" : "setFreshConversationPerTurn";
    const channel = savedChats ? "launcher:use-saved-chats" : "launcher:fresh-conversation-per-turn";
    const nextChannel = savedChats ? "launcher:set-preference" : "launcher:use-saved-chats";
    const key = "a".repeat(64);
    const stale = { id: "old-chat", traceId: "old-turn", status: "ready", interactionMode: "automatic",
      conversationKey: key, connectorIdentity: "Codex Native2", connectorBound: true };
    const state = { experimentalFreshConversationPerTurn: false, useSavedChats: false };
    const config = { experimentalFreshConversationPerTurn: false, useSavedChats: false };
    let handler, failSetup = true, commit;
    const removed = [];
    const fixture = Object.assign(Object.create(BrowserHost.prototype), {
      manualOperation: null, turnTabs: new Map([[stale.id, stale]]),
      userCancelledTurnOwners: new Map(), selectedTabId: "home", logger: { info() {} },
      syncViewVisibility() {}, snapshot: () => ({}), publishState() {}, writeDescriptor() {},
      removeTurnTab(tab, abortRunning) {
        assert.equal(abortRunning, false);
        assert.equal(tab.status, "ready");
        removed.push(tab.id);
        this.turnTabs.delete(tab.id);
      },
      createTurnTab: async () => ({ id: "new-chat", surfaceId: "new-surface" }),
    });
    const sandboxRuntimeHost = {
      currentOperation: () => null,
      runtimeConfigSnapshot: () => ({ config }),
      [method]: async enabled => {
        if (failSetup) throw new Error("setup rejected");
        await new Promise(resolve => { commit = resolve; });
        config[property] = enabled;
        return { enabled };
      },
    };
    const sandboxStateStore = { read: () => ({ ...state }), update: patch => Object.assign(state, patch) };
    const sandbox = {
      handle: (_channel, callback) => { handler = callback; },
      releaseRetainedConversation,
      getBrowserHost: () => fixture,
      getRuntimeHost: () => sandboxRuntimeHost,
      stateStore: sandboxStateStore,
      send() {},
    };
    sandbox.syncPrefs = (cfg) => sandbox.syncFreshConversationPreference(sandboxStateStore, cfg, {
      runtimeHost: sandboxRuntimeHost,
      browserHost: fixture,
      send: sandbox.send,
    });
    vm.runInNewContext(
      ipcRouterSource.slice(
        ipcRouterSource.indexOf("function syncFreshConversationPreference("),
        ipcRouterSource.indexOf("class IpcRouter"),
      ) + ipcRouterSource.slice(
        ipcRouterSource.indexOf(`handle("${channel}",`),
        ipcRouterSource.indexOf(`handle("${nextChannel}",`),
      ),
      sandbox,
    );
    await assert.rejects(() => handler(null, true), /setup rejected/);
    assert.equal(fixture.turnTabs.get(stale.id), stale, "failed setup preserves prior history");
    failSetup = false;
    const enabling = handler(null, true);
    assert.equal(fixture.turnTabs.has(stale.id), true, "pending setup must not release history");
    // A concurrent running lease must not be cancelled, even if it shares the released key.
    const running = { id: "concurrent", traceId: "concurrent-turn", status: "running", interactionMode: "automatic", conversationKey: key };
    fixture.turnTabs.set(running.id, running);
    commit();
    await enabling;
    assert.deepEqual(removed, [stale.id]);
    assert.equal(fixture.turnTabs.get(running.id), running);
    fixture.turnTabs.delete(running.id);
    const disabling = handler(null, false);
    commit();
    await disabling;
    const lease = await fixture.beginTurn("new-turn", false, 123, key, "Codex Native2");
    assert.equal(lease.reused, false);
    assert.equal(lease.tabId, "new-chat");
    assert.equal(state[property], false);
  }
});

test("evictOldestReclaimableTurnTab reclaims error, aborted, and orphan tabs before ready tabs", () => {
  const readyTab = { id: "ready-tab", ordinal: 1, status: "ready", lastHeartbeatAt: 10 };
  const errorTab = { id: "error-tab", ordinal: 2, status: "error", lastHeartbeatAt: 20 };
  const removed = [];
  const fixture = {
    turnTabs: new Map([[readyTab.id, readyTab], [errorTab.id, errorTab]]),
    removeTurnTab(tab, abortRunning) {
      removed.push([tab.id, abortRunning]);
      this.turnTabs.delete(tab.id);
    },
  };

  assert.equal(BrowserHost.prototype.evictOldestReclaimableTurnTab.call(fixture), true);
  assert.deepEqual(removed, [["error-tab", false]]);
  assert.equal(fixture.turnTabs.has("ready-tab"), true);
});

test("beginTurn reconciles multiple retained tabs by keeping the newest and closing extras", async () => {
  const key = "k".repeat(64);
  const older = {
    id: "older-retained",
    surfaceId: "s1",
    status: "ready",
    interactionMode: "automatic",
    conversationKey: key,
    connectorIdentity: "m365-copilot",
    connectorBound: true,
    provider: "m365",
    lastHeartbeatAt: 100,
    view: { webContents: { isDestroyed: () => false, setBackgroundThrottling() {} } },
  };
  const newer = {
    id: "newer-retained",
    surfaceId: "s2",
    status: "ready",
    interactionMode: "automatic",
    conversationKey: key,
    connectorIdentity: "m365-copilot",
    connectorBound: true,
    provider: "m365",
    lastHeartbeatAt: 200,
    view: { webContents: { isDestroyed: () => false, setBackgroundThrottling() {} } },
  };
  const removed = [];
  const fixture = {
    turnTabs: new Map([[older.id, older], [newer.id, newer]]),
    userCancelledTurnOwners: new Set(),
    logger: { warn() {} },
    removeTurnTab(tab, abortRunning) {
      removed.push(tab.id);
      this.turnTabs.delete(tab.id);
    },
    syncViewVisibility() {},
    writeDescriptor() {},
  };

  const lease = await BrowserHost.prototype.beginTurn.call(
    fixture,
    "trace-reconcile",
    false,
    process.pid,
    key,
    "m365-copilot",
    false,
    "m365",
  );

  assert.equal(lease.tabId, "newer-retained");
  assert.equal(lease.surfaceId, "s2");
  assert.equal(lease.reused, true);
  assert.deepEqual(removed, ["older-retained"]);
  assert.equal(fixture.turnTabs.has("newer-retained"), true);
  assert.equal(fixture.turnTabs.has("older-retained"), false);
});
