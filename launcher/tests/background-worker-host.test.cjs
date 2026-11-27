const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BackgroundWorkerHost,
  DEFAULT_WORKER_VIEWPORT,
} = require("../electron/browser/background-worker-host.cjs");
const { BrowserHost } = require("../electron/browser/browser-host.cjs");
const {
  IDLE_BROWSER_URL,
  TurnTabManager,
  WARM_TURN_THROTTLE_GRACE_MS,
} = require("../electron/browser/turn-tab-manager.cjs");

function createFakeWindow(name) {
  const children = new Set();
  const events = [];
  let destroyed = false;
  return {
    name,
    children,
    events,
    isDestroyed: () => destroyed,
    isVisible: () => true,
    isMinimized: () => false,
    getContentSize: () => [1120, 720],
    webContents: {
      isDestroyed: () => destroyed,
    },
    contentView: {
      addChildView(view) {
        children.add(view);
        events.push(["add", name, view.id || "view"]);
      },
      removeChildView(view) {
        children.delete(view);
        events.push(["remove", name, view.id || "view"]);
      },
    },
    destroy() {
      destroyed = true;
      events.push(["destroy", name]);
    },
  };
}

function createFakeView(id) {
  const calls = [];
  let destroyed = false;
  return {
    id,
    calls,
    setBounds(bounds) {
      calls.push(["bounds", bounds]);
    },
    setVisible(visible) {
      calls.push(["visible", visible]);
    },
    webContents: {
      isDestroyed: () => destroyed,
      setBackgroundThrottling(throttled) {
        calls.push(["throttling", throttled]);
      },
      enableDeviceEmulation() {
        calls.push(["enable-emulation"]);
        throw new Error("worker-hosted turn tab must not call enableDeviceEmulation");
      },
      disableDeviceEmulation() {
        calls.push(["disable-emulation"]);
      },
      focus() {
        calls.push(["focus"]);
      },
      removeAllListeners() {},
      close() {
        destroyed = true;
      },
    },
  };
}

test("BackgroundWorkerHost nạp IDLE_BROWSER_URL một lần và quản lý attach/detach/destroy", async () => {
  const workerWin = createFakeWindow("worker");
  const loadedUrls = [];
  const host = new BackgroundWorkerHost({
    createWindow: () => workerWin,
    loadIdleSurface: async (_contents, url) => {
      loadedUrls.push(url);
    },
  });

  await Promise.all([host.ensureReady(), host.ensureReady()]);
  assert.deepEqual(loadedUrls, [IDLE_BROWSER_URL]);
  assert.deepEqual(host.getBounds(), {
    x: 0,
    y: 0,
    width: DEFAULT_WORKER_VIEWPORT.width,
    height: DEFAULT_WORKER_VIEWPORT.height,
  });

  const view = createFakeView("v1");
  host.attachView(view, { visible: true });
  assert.equal(host.hasView(view), true);
  assert.equal(workerWin.children.has(view), true);
  assert.deepEqual(view.calls, [
    ["bounds", { x: 0, y: 0, width: 1280, height: 800 }],
    ["visible", true],
  ]);

  host.detachView(view);
  assert.equal(host.hasView(view), false);
  assert.equal(workerWin.children.has(view), false);

  host.attachView(view, { visible: false });
  host.destroy();
  assert.equal(workerWin.children.size, 0);
  assert.equal(workerWin.isDestroyed(), true);
});

test("presentTurnView reparent WebContentsView giữa workerWindow và mainWindow mà không bật deviceEmulation", () => {
  const mainWin = createFakeWindow("main");
  const workerWin = createFakeWindow("worker");
  const workerHost = new BackgroundWorkerHost({
    createWindow: () => workerWin,
    loadIdleSurface: async () => {},
  });

  const view = createFakeView("tab-reparent");
  const tab = {
    id: "tab-reparent",
    provider: "ai-studio",
    status: "running",
    rendererReady: true,
    attachedToMainWindow: false,
    warmGraceActive: false,
    deviceEmulationViewport: null,
    deviceEmulationDirty: true,
    view,
  };

  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    visible: false,
    surfaceActive: true,
    boundsReady: true,
    bounds: { x: 240, y: 80, width: 880, height: 640 },
    selectedTabId: tab.id,
    turnTabs: new Map([[tab.id, tab]]),
    authView: null,
    window: mainWin,
    backgroundWorkerHost: workerHost,
    view: createFakeView("primary"),
  });

  // 1. Khi Hide Browser -> tab nằm trong workerWindow ở kích thước cố định 1280x800
  BrowserHost.prototype.syncViewVisibility.call(fixture);
  assert.equal(workerWin.children.has(view), true);
  assert.equal(mainWin.children.has(view), false);
  assert.equal(tab.attachedToMainWindow, false);
  assert.deepEqual(view.calls.slice(-2), [
    ["bounds", { x: 0, y: 0, width: 1280, height: 800 }],
    ["visible", true],
  ]);

  // 2. Khi user bấm Show Browser -> reparent sang mainWindow đúng bounds UI
  fixture.visible = true;
  BrowserHost.prototype.syncViewVisibility.call(fixture);
  assert.equal(workerWin.children.has(view), false);
  assert.equal(mainWin.children.has(view), true);
  assert.equal(tab.attachedToMainWindow, true);
  assert.deepEqual(view.calls.slice(-2), [
    ["bounds", { x: 240, y: 80, width: 880, height: 640 }],
    ["visible", true],
  ]);

  // 3. Khi user bấm Hide Browser hoặc minimize -> detach trả về workerWindow 1280x800
  fixture.visible = false;
  BrowserHost.prototype.syncViewVisibility.call(fixture);
  assert.equal(workerWin.children.has(view), true);
  assert.equal(mainWin.children.has(view), false);
  assert.equal(tab.attachedToMainWindow, false);
  assert.deepEqual(view.calls.slice(-2), [
    ["bounds", { x: 0, y: 0, width: 1280, height: 800 }],
    ["visible", true],
  ]);

  workerHost.destroy();
});

test("selectTab khi đang Hide Browser giữ ẩn tab trong workerWindow tới khi bấm Show Browser", () => {
  const mainWin = createFakeWindow("main");
  const workerWin = createFakeWindow("worker");
  const workerHost = new BackgroundWorkerHost({
    createWindow: () => workerWin,
    loadIdleSurface: async () => {},
  });

  const view1 = createFakeView("tab-1");
  const view2 = createFakeView("tab-2");
  const tab1 = { id: "tab-1", status: "running", rendererReady: true, attachedToMainWindow: false, view: view1 };
  const tab2 = { id: "tab-2", status: "running", rendererReady: true, attachedToMainWindow: false, view: view2 };

  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    visible: false,
    surfaceActive: true,
    boundsReady: true,
    bounds: { x: 200, y: 60, width: 900, height: 640 },
    selectedTabId: tab1.id,
    turnTabs: new Map([[tab1.id, tab1], [tab2.id, tab2]]),
    authView: null,
    window: mainWin,
    backgroundWorkerHost: workerHost,
    view: createFakeView("primary"),
    state: { visible: false, surfaceActive: true },
    snapshot: () => ({ activeTabId: fixture.selectedTabId, visible: fixture.visible }),
    publishState() {},
    writeDescriptor() {},
    setState(patch) {
      Object.assign(this.state, patch);
    },
  });

  BrowserHost.prototype.selectTab.call(fixture, tab2.id);
  assert.equal(fixture.selectedTabId, tab2.id);
  assert.equal(fixture.visible, false);
  assert.equal(mainWin.children.has(view2), false);
  assert.equal(workerWin.children.has(view2), true);

  // Chỉ sau khi bấm Show Browser mới attach tab2 sang mainWindow
  BrowserHost.prototype.show.call(fixture);
  assert.equal(fixture.visible, true);
  assert.equal(mainWin.children.has(view2), true);
  assert.equal(workerWin.children.has(view2), false);

  workerHost.destroy();
});

test("Warm Grace Period giữ backgroundThrottling=false sau endTurn rồi tự hạ sau grace period và hủy khi reuse", async () => {
  assert.equal(WARM_TURN_THROTTLE_GRACE_MS, 90_000);
  const workerWin = createFakeWindow("worker");
  const workerHost = new BackgroundWorkerHost({
    createWindow: () => workerWin,
    loadIdleSurface: async () => {},
  });

  const view = createFakeView("warm-tab");
  const tab = {
    id: "warm-tab",
    surfaceId: "surf-warm",
    provider: "ai-studio",
    profileId: "default",
    traceId: "trace-1",
    helperPid: process.pid,
    conversationKey: "conv-warm-1",
    connectorIdentity: "codex-cli",
    connectorBound: true,
    conversationId: "prompt-123",
    status: "running",
    rendererReady: true,
    attachedToMainWindow: false,
    warmGraceActive: false,
    warmThrottleTimer: null,
    view,
  };

  let syncCount = 0;
  const host = {
    provider: "ai-studio",
    visible: false,
    surfaceActive: true,
    boundsReady: true,
    selectedTabId: tab.id,
    homeSurfaceOpen: false,
    warmThrottleGraceMs: 40,
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    userCancelledTurnOwners: new Map(),
    backgroundWorkerHost: workerHost,
    window: createFakeWindow("main"),
    logger: { info() {}, warn() {}, error() {} },
    providerRegistry: {
      has: () => true,
      get: () => ({
        id: "ai-studio",
        displayName: "Google AI Studio",
        maxSurfaces: 5,
        isProfileSupported: () => true,
        getActiveProfileId: () => "default",
        getProfiles: () => [{ id: "default" }],
        normalizeConversationId: (id) => id,
        bind: (_key, id) => id,
      }),
    },
    snapshot: () => ({}),
    publishState() {},
    writeDescriptor() {},
    parkIdlePrimaryView() {},
    syncViewVisibility() {
      syncCount += 1;
      manager.presentTurnView(tab, false);
    },
    presentTurnView(targetTab, visible) {
      manager.presentTurnView(targetTab, visible);
    },
  };
  const manager = new TurnTabManager(host, { standalone: true, warmThrottleGraceMs: 40 });

  await manager.endTurn("trace-1", process.pid, "completed", false, "done", true, true, "prompt-123");

  // Ngay sau endTurn: vẫn đang warm (throttling=false, visible=true trong workerWindow)
  assert.equal(tab.status, "ready");
  assert.equal(tab.warmGraceActive, true);
  assert.ok(tab.warmThrottleTimer);
  assert.deepEqual(
    view.calls.filter(([kind]) => kind === "throttling").at(-1),
    ["throttling", false],
  );
  assert.deepEqual(
    view.calls.filter(([kind]) => kind === "visible").at(-1),
    ["visible", true],
  );

  // Sau khi hết 40ms grace -> tự hạ về backgroundThrottling=true và visible=false
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(tab.warmGraceActive, false);
  assert.equal(tab.warmThrottleTimer, null);
  assert.deepEqual(
    view.calls.filter(([kind]) => kind === "throttling").at(-1),
    ["throttling", true],
  );
  assert.deepEqual(
    view.calls.filter(([kind]) => kind === "visible").at(-1),
    ["visible", false],
  );
  assert.ok(syncCount >= 2);

  // Reuse lại rồi kết thúc và reuse trước hạn -> timer phải bị hủy, không bị throttle nhầm
  await manager.beginTurn("trace-2", false, process.pid, "conv-warm-1", "codex-cli", false, "ai-studio");
  await manager.endTurn("trace-2", process.pid, "completed", false, "done", true, true, "prompt-123");
  assert.equal(tab.warmGraceActive, true);
  await manager.beginTurn("trace-3", false, process.pid, "conv-warm-1", "codex-cli", false, "ai-studio");
  assert.equal(tab.warmGraceActive, false);
  assert.equal(tab.warmThrottleTimer, null);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.deepEqual(
    view.calls.filter(([kind]) => kind === "throttling").at(-1),
    ["throttling", false],
  );

  manager.destroy();
  workerHost.destroy();
});

test("beginTurn nền (reveal=false) không bao giờ cướp selectedTabId của tab đang ready mà user đang chọn", async () => {
  const host = {
    provider: "ai-studio",
    visible: true,
    surfaceActive: true,
    boundsReady: true,
    selectedTabId: "tab-existing",
    homeSurfaceOpen: false,
    turnTabs: new Map([
      ["tab-existing", { id: "tab-existing", status: "ready", provider: "ai-studio" }],
    ]),
  };
  const manager = new TurnTabManager(host, { standalone: true });

  assert.equal(manager._shouldSelectTabOnBegin({ id: "tab-new" }, false), false);
  assert.equal(manager._shouldSelectTabOnBegin({ id: "tab-new" }, true), true);

  // Khi đang mở Home surface (login) -> turn nền cũng không được cướp tab
  host.selectedTabId = "home";
  host.homeSurfaceOpen = true;
  assert.equal(manager._shouldSelectTabOnBegin({ id: "tab-new" }, false), false);

  // Chỉ khi đang ẩn và chưa chọn turn tab nào -> gán ngầm để bấm Show Browser thấy ngay
  host.homeSurfaceOpen = false;
  host.visible = false;
  assert.equal(manager._shouldSelectTabOnBegin({ id: "tab-new" }, false), true);
});
