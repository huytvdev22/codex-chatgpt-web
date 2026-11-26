const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createLimitsStore } = require("../electron/infra/limits-store.cjs");
const { BrowserControlServer } = require("../electron/browser/control-server.cjs");
const { TurnTabManager } = require("../electron/browser/turn-tab-manager.cjs");

test("launcher limits store resolves offline snapshot from provider-limits.json and proxies online refresh", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-limits-launcher-"));
  const file = path.join(root, "provider-limits.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      updatedAt: "2026-11-26T08:00:00.000Z",
      entries: {
        "chatgpt::work": {
          providerId: "chatgpt",
          profileId: "work",
          profileName: "Work",
          status: "warning",
          planName: "ChatGPT Pro",
          sourceUrl: "https://chatgpt.com/settings/usage?tab=overview",
          sourceKind: "network-json",
          scopeNote: "Codex & Work",
          providerUpdatedText: null,
          buckets: [{ id: "primary_window", label: "5-hour limit", percentUsed: 84, severity: "warning" }],
          rawSummary: "5-hour limit: 16% left",
          checkedAt: "2026-11-26T08:00:00.000Z",
          lastError: null,
        },
      },
    }),
  );

  try {
    const offlineStore = createLimitsStore(
      file,
      () => null,
      () => [
        {
          id: "chatgpt",
          activeProfileId: "default",
          profiles: [
            { id: "default", name: "Default", authenticated: true },
            { id: "work", name: "Work", authenticated: true },
          ],
        },
        { id: "m365", authenticated: true },
      ],
    );

    const offline = await offlineStore.getSnapshot();
    const work = offline.entries.find((e) => e.providerId === "chatgpt" && e.profileId === "work");
    const m365 = offline.entries.find((e) => e.providerId === "m365-copilot");
    assert.equal(work.status, "warning");
    assert.equal(work.isActive, false);
    assert.equal(m365.support, "unsupported");

    await assert.rejects(() => offlineStore.refreshLimits(), /runtime is offline/i);

    const seen = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          status: "ok",
          snapshot: { version: 1, updatedAt: "2026-11-26T09:00:00.000Z", configPath: file, warningThresholdPercent: 80, entries: [] },
          results: [{ providerId: "chatgpt", profileId: "work", profileName: "Work", status: "ok" }],
        }));
      });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      const onlineStore = createLimitsStore(
        file,
        () => ({ host: "127.0.0.1", port, controlToken: "tok" }),
        () => [],
      );
      const outcome = await onlineStore.refreshLimits({ providerId: "chatgpt", profileId: "work" });
      assert.equal(outcome.results[0].status, "ok");
      assert.equal(seen[0].url, "/admin/limits/refresh");
      assert.deepEqual(seen[0].body, { providerId: "chatgpt", profileId: "work" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("control-server and TurnTabManager accept optional profileId without mutating activeProfileId", async () => {
  const providerObj = {
    id: "chatgpt",
    displayName: "ChatGPT",
    isProfileSupported: () => true,
    getActiveProfileId: () => "default",
    getProfiles: () => [
      { id: "default", name: "Default", authenticated: true },
      { id: "work", name: "Work", authenticated: true },
    ],
    isAllowedNavigation: () => true,
  };

  const manager = new TurnTabManager({ turnTabs: new Map() }, { standalone: true });
  assert.equal(manager.resolveTargetProfileId(providerObj, null), "default");
  assert.equal(manager.resolveTargetProfileId(providerObj, "work"), "work");
  assert.throws(() => manager.resolveTargetProfileId(providerObj, "missing"), /Unknown profile/);
  assert.equal(providerObj.getActiveProfileId(), "default");

  const beginCalls = [];
  const host = {
    provider: "chatgpt",
    providerRegistry: {
      has: (id) => id === "chatgpt",
      get: () => providerObj,
      defaultId: () => "chatgpt",
    },
    _resolveProvider: () => providerObj,
    beginTurn: async (...args) => {
      beginCalls.push(args);
      return {
        surfaceId: "s".repeat(32),
        tabId: "tab-work",
        reused: false,
        connectorBound: false,
      };
    },
  };

  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getPreferences: () => ({ showBrowserDuringTurns: false }),
    getBrowserHost: () => host,
    providerRegistry: host.providerRegistry,
  }).start();
  const { endpoint, token } = server.descriptor();
  try {
    const badRes = await fetch(`${endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        traceId: "trace_123456",
        helperPid: process.pid,
        provider: "chatgpt",
        profileId: "unknown-prof",
      }),
    });
    assert.equal(badRes.status, 400);

    const okRes = await fetch(`${endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        traceId: "trace_123456",
        helperPid: process.pid,
        provider: "chatgpt",
        initialUrl: "https://chatgpt.com/settings/usage?tab=overview",
        profileId: "work",
      }),
    });
    assert.equal(okRes.status, 200);
    assert.equal(beginCalls[0][9], "work");
  } finally {
    await server.close();
  }
});

test("limits UI, preload, and IPC wiring are connected", () => {
  const launcherRoot = path.resolve(__dirname, "..");
  const usageSource = fs.readFileSync(path.join(launcherRoot, "src", "components", "UsageSurface.tsx"), "utf8");
  const appSource = fs.readFileSync(path.join(launcherRoot, "src", "App.tsx"), "utf8");
  const preloadSource = fs.readFileSync(path.join(launcherRoot, "electron", "preload.cjs"), "utf8");
  const ipcSource = fs.readFileSync(path.join(launcherRoot, "electron", "app", "ipc-router.cjs"), "utf8");

  assert.match(preloadSource, /getLimits:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("launcher:limits-get"\)/);
  assert.match(preloadSource, /refreshLimits:\s*\(providerId,\s*profileId\)\s*=>\s*ipcRenderer\.invoke\("launcher:limits-refresh"/);
  assert.match(ipcSource, /handle\("launcher:limits-get",/);
  assert.match(ipcSource, /handle\("launcher:limits-refresh",/);
  assert.match(usageSource, /<progress[\s\S]*?className=\{`usage-limit-progress/);
  assert.match(appSource, /provider-limit-dot/);
  assert.match(appSource, /profile-limit-pill/);
});
