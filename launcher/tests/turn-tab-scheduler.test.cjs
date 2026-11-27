"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { BrowserHost, createDefaultProviderRegistry } = require("../electron/browser/browser-host.cjs");
const { TurnTabManager, IDLE_BROWSER_URL } = require("../electron/browser/turn-tab-manager.cjs");

function createMockWebContents(targetId) {
  let destroyed = false;
  return {
    isDestroyed: () => destroyed,
    getURL: () => IDLE_BROWSER_URL,
    setBackgroundThrottling() {},
    disableDeviceEmulation() {},
    removeAllListeners() {},
    close() {
      destroyed = true;
    },
    getOrCreateDevToolsTargetId: () => targetId,
  };
}

function createReactiveHostStub({ provider = "ai-studio", slotWaitTimeoutMs = 500 } = {}) {
  const logs = [];
  let tabSeq = 0;
  const host = {
    provider,
    providerRegistry: createDefaultProviderRegistry(),
    selectedTabId: "home",
    homeSurfaceOpen: false,
    manualOperation: null,
    loginOperation: null,
    turnTabs: new Map(),
    closedTurnOwners: new Map(),
    userCancelledTurnOwners: new Map(),
    lastClosedAtByProvider: new Map(),
    slotWaitTimeoutMs,
    window: { contentView: { removeChildView() {} } },
    view: { webContents: createMockWebContents("home-target") },
    logger: {
      info: (ev, detail) => logs.push(["info", ev, detail]),
      warn: (ev, detail) => logs.push(["warn", ev, detail]),
      error: (ev, detail) => logs.push(["error", ev, detail]),
    },
    syncPowerSaveBlocker() {},
    syncViewVisibility() {},
    parkIdlePrimaryView() {},
    publishState() {},
    snapshot: () => ({ activeTabId: host.selectedTabId }),
    writeDescriptor() {},
    show() {},
    hide() {},
    async createTurnTab(traceId, helperPid, conversationKey, connectorIdentity, _signal, providerId = provider, _initialUrl = null, profileId = "default") {
      tabSeq += 1;
      const tab = {
        id: `tab-${tabSeq}`,
        surfaceId: `surface_${String(tabSeq).padStart(24, "0")}`,
        traceId,
        helperPid,
        conversationKey,
        connectorIdentity,
        connectorBound: false,
        provider: providerId,
        profileId: profileId || "default",
        status: "running",
        loading: true,
        lastHeartbeatAt: Date.now(),
        view: { webContents: createMockWebContents(`cdp-target-${tabSeq}`) },
      };
      this.turnTabs.set(tab.id, tab);
      return tab;
    },
  };
  const manager = new TurnTabManager(host, {
    standalone: true,
    aiStudioReopenCooldownMs: 200,
    slotWaitTimeoutMs,
  });
  host.turnTabManager = manager;
  return { host, manager, logs };
}

test("TurnTabManager xếp hàng reactive khi 2 request trùng conversationKey (vd TTS speech) và reuse đúng tab", async () => {
  const { host, manager, logs } = createReactiveHostStub({ provider: "ai-studio", slotWaitTimeoutMs: 1_000 });
  const speechKey = "a".repeat(64);

  const lease1 = await manager.beginTurn(
    "trace_tts_1",
    false,
    process.pid,
    speechKey,
    undefined,
    false,
    "ai-studio",
  );
  assert.equal(lease1.reused, false);
  assert.equal(lease1.targetId, "cdp-target-1");
  assert.equal(host.turnTabs.size, 1);

  // Request 2 cùng key tới khi request 1 vẫn đang running -> phải chờ reactive thay vì mở tab trùng
  const lease2Promise = manager.beginTurn(
    "trace_tts_2",
    false,
    process.pid,
    speechKey,
    undefined,
    false,
    "ai-studio",
  );

  // Sau 30ms vẫn chỉ có 1 tab và waiter đang chờ
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(host.turnTabs.size, 1);
  assert.equal(manager.scheduler.pendingKeyCount("ai-studio", "default", speechKey), 1);

  // Request 1 hoàn tất (retain = true) -> đánh thức request 2 tức thì để reuse đúng tab đó
  const releasedAt = Date.now();
  await manager.endTurn("trace_tts_1", process.pid, "completed", false, undefined, true, false);
  const lease2 = await lease2Promise;

  assert.equal(lease2.reused, true);
  assert.equal(lease2.tabId, lease1.tabId);
  assert.equal(lease2.targetId, "cdp-target-1");
  assert.equal(host.turnTabs.size, 1);
  assert.ok(Date.now() - releasedAt < 200);
  assert.equal(logs.some(([, ev]) => ev === "browser.turn_wait_same_key"), true);
});

test("TurnTabManager xếp hàng reactive khi chạm trần maxSurfaces (M365 = 3) và hỗ trợ AbortSignal", async () => {
  const { host, manager, logs } = createReactiveHostStub({ provider: "m365", slotWaitTimeoutMs: 1_000 });

  for (let i = 1; i <= 3; i += 1) {
    await manager.beginTurn(`trace_m365_${i}`, false, process.pid, String(i).repeat(64), "m365", false, "m365");
  }
  assert.equal(host.turnTabs.size, 3);

  // Request 4 chờ slot reactive
  const wait4Promise = manager.beginTurn("trace_m365_4", false, process.pid, "4".repeat(64), "m365", false, "m365");

  // Request 5 bị abort ngay khi đang chờ slot
  const abort5 = new AbortController();
  const wait5Promise = manager.beginTurn(
    "trace_m365_5",
    false,
    process.pid,
    "5".repeat(64),
    "m365",
    false,
    "m365",
    abort5.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(manager.scheduler.pendingSlotCount("m365"), 2);

  abort5.abort(new DOMException("caller disconnected", "AbortError"));
  await assert.rejects(wait5Promise, /caller disconnected/i);
  assert.equal(manager.scheduler.pendingSlotCount("m365"), 1);

  // Giải phóng tab 1 -> request 4 lập tức được cấp slot
  await manager.endTurn("trace_m365_1", process.pid, "completed", false, undefined, false, false);
  const lease4 = await wait4Promise;
  assert.equal(lease4.reused, false);
  assert.equal(host.turnTabs.size, 3);
  assert.equal(logs.some(([, ev]) => ev === "browser.turn_wait_slot"), true);
});

test("Đóng tab AI Studio ở trạng thái ready (evict/reconcile) KHÔNG kích hoạt cooldown 3s", () => {
  const { host, manager } = createReactiveHostStub({ provider: "ai-studio" });
  const readyTab = {
    id: "ai-ready-1",
    traceId: "trace-ready-1",
    provider: "ai-studio",
    status: "ready",
    view: { webContents: createMockWebContents("ready-target") },
  };
  host.turnTabs.set(readyTab.id, readyTab);

  manager.removeTurnTab(readyTab, false);
  assert.equal(manager.lastClosedAtByProvider.get("ai-studio"), undefined);

  const failedTab = {
    id: "ai-failed-1",
    traceId: "trace-failed-1",
    provider: "ai-studio",
    status: "error",
    view: { webContents: createMockWebContents("failed-target") },
  };
  host.turnTabs.set(failedTab.id, failedTab);

  manager.removeTurnTab(failedTab, false);
  assert.ok(manager.lastClosedAtByProvider.get("ai-studio") > 0);
});

test("beginTurn nền (reveal=false) không cướp selectedTabId của tab khác đang running", async () => {
  const { host, manager } = createReactiveHostStub({ provider: "gemini", slotWaitTimeoutMs: 500 });

  const first = await manager.beginTurn("trace_g1", false, process.pid, "a".repeat(64), "gemini", false, "gemini");
  assert.equal(host.selectedTabId, first.tabId);

  // Tab thứ 2 chạy nền khi tab 1 đang running -> giữ nguyên selectedTabId ở tab 1
  const second = await manager.beginTurn("trace_g2", false, process.pid, "b".repeat(64), "gemini", false, "gemini");
  assert.equal(host.selectedTabId, first.tabId);

  // Khi tab 3 có reveal=true -> được phép chuyển selectedTabId
  const third = await manager.beginTurn("trace_g3", true, process.pid, "c".repeat(64), "gemini", false, "gemini");
  assert.equal(host.selectedTabId, third.tabId);
  assert.notEqual(second.tabId, third.tabId);
});

test("_assertProfileMutationAllowed chỉ chặn theo đúng provider đang có turn running", () => {
  const providerRegistry = createDefaultProviderRegistry();
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    provider: "ai-studio",
    providerRegistry,
    manualOperation: null,
    loginOperation: null,
    externalChromeLogin: null,
    turnTabs: new Map([
      ["ai-1", { id: "ai-1", traceId: "trace-ai", provider: "ai-studio", status: "running" }],
    ]),
  });

  // AI Studio đang chạy -> bị chặn đổi profile AI Studio
  assert.throws(
    () => host._assertProfileMutationAllowed("ai-studio"),
    /Google AI Studio while a Codex turn is running/,
  );

  // Nhưng Gemini không có turn running -> vẫn cho phép đổi profile Gemini
  const geminiProvider = host._assertProfileMutationAllowed("gemini");
  assert.equal(geminiProvider.id, "gemini");
});
