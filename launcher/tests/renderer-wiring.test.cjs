const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(launcherRoot, "src", "App.tsx"), "utf8");
const stylesSource = fs.readFileSync(path.join(launcherRoot, "src", "styles.css"), "utf8");
const electronMain = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
const ipcRouterSource = fs.readFileSync(path.join(launcherRoot, "electron", "app", "ipc-router.cjs"), "utf8");
const catalogMonitorSource = fs.readFileSync(path.join(launcherRoot, "electron", "app", "catalog-monitor.cjs"), "utf8");
const browserHostSource = fs.readFileSync(path.join(launcherRoot, "electron", "browser", "browser-host.cjs"), "utf8");
const preloadSource = fs.readFileSync(path.join(launcherRoot, "electron", "preload.cjs"), "utf8");

test("M365 no longer exposes per-request Temporary Chat configuration", () => {
  for (const source of [appSource, electronMain, ipcRouterSource, browserHostSource, preloadSource]) {
    assert.doesNotMatch(source, /m365TemporaryChatPerRequest|setM365TemporaryChatPerRequest|launcher:m365-temporary-chat/);
  }
});

test("M365 multi-surface normal conversations are enabled without launcher configuration", () => {
  for (const source of [appSource, electronMain, ipcRouterSource, preloadSource]) {
    assert.doesNotMatch(source, /m365MultiSurfaceConversations|setM365MultiSurface|launcher:m365-multi-surface/);
  }
  assert.match(browserHostSource, /M365BrowserProvider/);
});

test("embedded ChatGPT is measured only after its animated surface mounts", () => {
  assert.match(appSource, /const \[browserSlot, setBrowserSlot\] = useState<HTMLDivElement \| null>\(null\)/);
  assert.match(appSource, /setBrowserSurfaceActive\(browserSurfaceActive\)\.then\(\(\) => \{/);
  assert.match(appSource, /observer\.observe\(browserSlot\)/);
  assert.match(appSource, /ref=\{browserSlotRef\}/);
});

test("native clicks reach browser tabs instead of the window drag region", () => {
  assert.match(appSource, /draggable=\{surface !== "browser"\}/);
  assert.match(appSource, /className=\{`app-titlebar\$\{draggable \? " draggable" : ""\}`\}/);
  assert.match(stylesSource, /\.browser-tab\s*\{[^}]*-webkit-app-region:\s*no-drag;/s);
  assert.match(appSource, /className="browser-tab-drag draggable"/);
});

test("renderer zoom scales the shell without moving or zooming the native ChatGPT surface", () => {
  assert.match(
    ipcRouterSource,
    /getBrowserHost\(\)\?\.setBounds\(validateBounds\(bounds\), event\.sender\.getZoomFactor\(\)\)/,
  );
  assert.match(browserHostSource, /this\.bindShellZoomShortcuts\(this\.window\.webContents\)/);
  assert.match(browserHostSource, /contents\.setZoomLevel\(next\)/);
  assert.match(appSource, /api!\.zoomBrowser\(action\)/);
});

test("closing the launcher follows the persisted background-runtime preference", () => {
  assert.match(
    electronMain,
    /if \(stateStore\.read\(\)\.keepRunningOnClose && trayController\?\.isAvailable\(\)\) window\.hide\(\);\s*else void requestQuit\(\);/,
  );
  assert.match(appSource, /setPreference\("keepRunningOnClose", checked\)/);
});

test("a foreground launch request survives hidden startup until the launcher window is ready", () => {
  const showMainWindow = electronMain.slice(
    electronMain.indexOf("function showMainWindow()"),
    electronMain.indexOf("async function openWebUrl"),
  );
  assert.match(
    showMainWindow,
    /mainWindowShowRequested = true;[\s\S]*?!mainWindowReadyToShow[\s\S]*?mainWindowShowRequested = false;/,
  );

  const readyHandler = electronMain.slice(
    electronMain.indexOf('window.once("ready-to-show"'),
    electronMain.indexOf("trackWindowState(window", electronMain.indexOf('window.once("ready-to-show"')),
  );
  assert.match(
    readyHandler,
    /mainWindowReadyToShow = true;[\s\S]*?if \(mainWindowShowRequested\) showMainWindow\(\);/,
  );

  const secondInstance = electronMain.indexOf('app.on("second-instance", () => showMainWindow())');
  const runtimeMaterialization = electronMain.indexOf("await waitForPackagedRuntimeSource", secondInstance);
  assert.ok(secondInstance >= 0, "the second-instance foreground request must be registered");
  assert.ok(
    runtimeMaterialization > secondInstance,
    "the foreground request must be registered before packaged-runtime startup can block window creation",
  );
});

test("normal shutdown persists the ChatGPT session before closing browser views", () => {
  assert.match(
    electronMain,
    /runtimeSupervisor\?\.shutdown\(\{ cancelActiveTurns: true, force: true \}\)/,
  );
  const persist = electronMain.indexOf("await browserHost?.persistSession()");
  const destroy = electronMain.indexOf("browserHost?.destroy()", persist);
  assert.ok(persist >= 0, "shutdown must persist the ChatGPT session");
  assert.ok(destroy > persist, "browser views must close only after session persistence completes");
});

test("setup installs models without requiring prior browser authentication or smoke verification", async () => {
  const vm = require("node:vm");
  const source = ipcRouterSource.slice(
    ipcRouterSource.indexOf('handle("launcher:setup-core",'),
    ipcRouterSource.indexOf('handle("launcher:connector-name",'),
  );
  for (const dev of [false, true]) {
    let setup;
    let installs = 0;
    let probes = 0;
    let idleReturns = 0;
    let monitorStarts = 0;
    const state = { coreSetupComplete: false };
    const run = async () => { installs++; return { mode: "browser-only", stdout: "ok" }; };
    vm.runInNewContext(source, {
      handle: (_name, handler) => { setup = handler; },
      isDevProfile: dev,
      stateStore: {
        read: () => state,
        update: (patch) => Object.assign(state, patch),
      },
      getBrowserHost: () => ({
        probeAuthentication: async () => {
          probes++;
          return { authenticated: false, status: "signed-out", message: "Sign in" };
        },
        returnToIdle: async () => { idleReturns++; },
        provider: "m365",
      }),
      getRuntimeHost: () => ({
        setupCore: run,
        setupDevCore: run,
        runtimeConfigSnapshot: () => ({ config: {} }),
      }),
      send() { },
      startCatalogVerificationMonitor() { monitorStarts++; },
      logger: { warn() { } },
    });
    const result = await setup();
    assert.equal(result.ok, true);
    assert.equal(result.restartRequired, !dev);
    assert.equal(installs, 1);
    assert.equal(probes, 0);
    assert.equal(idleReturns, 1);
    assert.equal(monitorStarts, dev ? 0 : 1);
    assert.equal(state.coreSetupComplete, true);
  }
});

test("startup failure stays visible on another launch and Retry exits the failed instance", async () => {
  const vm = require("node:vm");
  const source = electronMain.slice(electronMain.indexOf("function showMainWindow()"), electronMain.indexOf("async function openWebUrl"))
    + electronMain.slice(electronMain.indexOf("void start().catch("));
  const events = [];
  let visible = false;
  let answer;
  const dialogOpened = new Promise(resolve => {
    answer = { opened: resolve };
  });
  const window = {
    isDestroyed: () => false, isMinimized: () => false,
    show: () => { visible = true; }, focus() { },
  };
  const sandbox = {
    mainWindow: window, mainWindowReadyToShow: false, mainWindowShowRequested: false,
    startupFailed: false, quitting: false,
    browserHost: { destroy: () => events.push("destroy") },
    browserControl: { close: async () => events.push("control closed") },
    start: async () => { throw new Error("Browser idle document did not commit within 10000ms"); },
    app: {
      getPath: () => "/unused", whenReady: async () => { },
      relaunch: options => events.push(["relaunch", options.args]), exit: code => events.push(["exit", code])
    },
    fs: { appendFileSync() { } }, path,
    createStateStore: () => ({ read: () => ({ language: "ko" }) }),
    nativeCopyFor: language => {
      assert.equal(language, "ko");
      return { startupTitle: "시작 오류", startupDetail: "다시 시작", startupCleanupFailed: "정리 실패", retry: "다시 시도", quit: "종료" };
    },
    launchEnvironment: { CODEX_CHATGPT_WEB_HOME: undefined, CODEX_HOME: "original-codex-home" },
    process: { argv: ["launcher", "--hidden"], env: { CODEX_CHATGPT_WEB_HOME: "dev-home", CODEX_HOME: "dev-codex-home" } },
    dialog: {
      showErrorBox: () => { answer.opened(); },
      showMessageBox: (owner, options) => {
        assert.equal(options.title, "시작 오류");
        assert.deepEqual(Array.from(options.buttons), ["다시 시도", "종료"]);
        events.push(["dialog", owner === window, options.message]);
        answer.opened();
        return new Promise(resolve => { answer.resolve = resolve; });
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  await dialogOpened;
  assert.equal(visible, true, "the failed startup must expose its error owner without renderer readiness");
  assert.deepEqual(events.slice(0, 2), ["destroy", "control closed"]);
  visible = false;
  sandbox.showMainWindow();
  assert.equal(visible, true, "a second launch must restore the existing startup error window");
  assert.equal(events.some(event => Array.isArray(event) && event[0] === "exit"), false);
  answer.resolve({ response: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.at(-2)[0], "relaunch");
  assert.deepEqual(Array.from(events.at(-2)[1]), []);
  assert.deepEqual(events.at(-1), ["exit", 1]);
  assert.deepEqual(sandbox.process.env, { CODEX_HOME: "original-codex-home" });
});

test("packaged runtime is verified before launcher browser surfaces can bind ports", () => {
  const start = electronMain.indexOf("async function start()");
  const runtimeValidation = electronMain.indexOf("installedRuntimeRoot = runtimeRootProvider();", start);
  const cdpPortAllocation = electronMain.indexOf("cdpPort = await findFreePort();", start);
  const windowCreation = electronMain.indexOf("mainWindow = createWindow({", start);
  const controlServerStart = electronMain.indexOf("browserControl = await new BrowserControlServer({", start);
  const browserReady = electronMain.indexOf("await browserHost.ready();", start);

  assert.ok(runtimeValidation > start, "startup must eagerly verify the packaged runtime");
  assert.ok(cdpPortAllocation < runtimeValidation, "CDP port switch must be configured before app.whenReady()");
  assert.ok(windowCreation < runtimeValidation, "launcher window must open immediately before packaged runtime verification");
  for (const [surface, position] of [
    ["browser control server", controlServerStart],
    ["embedded browser", browserReady],
  ]) {
    assert.ok(position > runtimeValidation, `${surface} must start only after runtime verification`);
  }
});

test("startup loading popup tracks launcher-startup phases and hides native browser surface while active", () => {
  assert.match(electronMain, /name:\s*"launcher-startup"[\s\S]*?message:\s*"Preparing local runtime"/);
  assert.match(electronMain, /name:\s*"launcher-startup"[\s\S]*?message:\s*"Initializing embedded browser"/);
  assert.match(electronMain, /name:\s*"launcher-startup"[\s\S]*?message:\s*"Starting local bridge service"/);
  assert.match(appSource, /const startupLoadingOpen = operation\?\.status === "running"/);
  assert.match(appSource, /<StartupLoadingModal/);
  assert.match(stylesSource, /\.startup-loading-backdrop\s*\{[^}]*position:\s*fixed;/s);
});

test("DEV launcher exposes its profile and supervises only its Full-mode MCP runtime", () => {
  assert.match(electronMain, /profile:\s*LAUNCHER_PROFILE\.kind/);
  assert.match(electronMain, /if \(IS_DEV_PROFILE\) \{[\s\S]*?config\?\.mode === "full"[\s\S]*?runtimeSupervisor\.startIfConfigured\(\)[\s\S]*?\} else void \(async \(\) => \{/);
  assert.match(electronMain, /await runtimeSupervisor\?\.shutdown\(\{ cancelActiveTurns: true, force: true \}\)/);
  assert.match(electronMain, /packaged:\s*app\.isPackaged && !IS_DEV_PROFILE/);
  assert.match(electronMain, /IS_DEV_PROFILE && !stateStore\.read\(\)\.onboardingComplete/);
  assert.match(electronMain, /onboardingComplete:\s*true,[\s\S]*?autoStart:\s*false/);
  assert.match(appSource, /snapshot\.profile === "development"/);
  assert.match(appSource, /data-profile=\{snapshot\.profile\}/);
  assert.match(ipcRouterSource, /getRuntimeHost\(\)\.setBiggerContext\(enabled === true\)/);
  assert.doesNotMatch(ipcRouterSource, /isDevProfile && key === "experimentalBiggerContext"/);
});

test("browser toolbar opens detached DevTools for the active embedded surface", () => {
  assert.match(
    appSource,
    /api!\.openBrowserDevTools\(\)[\s\S]*?label=\{copy\.openBrowserDevTools\}/,
  );
  assert.match(
    preloadSource,
    /openBrowserDevTools:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("launcher:browser-devtools"\)/,
  );
  assert.match(
    ipcRouterSource,
    /handle\("launcher:browser-devtools",\s*\(\)\s*=>\s*\{[\s\S]*?getBrowserHost\(\);[\s\S]*?return browserHost \? browserHost\.openDevTools\(\) : false;/,
  );
  assert.match(
    browserHostSource,
    /openDevTools\(\)\s*\{[\s\S]*?this\.activeView\(\)\?\.webContents[\s\S]*?contents\.openDevTools\(\{\s*mode:\s*"detach",\s*activate:\s*true\s*\}\)/,
  );
});

test("Bigger Context startup popup and Settings switch are both removed from renderer", () => {
  assert.doesNotMatch(appSource, /BiggerContextRecommendation/);
  assert.doesNotMatch(appSource, /biggerContextRecommendationOpen/);
  assert.doesNotMatch(stylesSource, /\.bigger-context-recommendation/);
  assert.doesNotMatch(appSource, /biggerContext|setBiggerContext/);
});

test("failed doctor reports retain every failed check", () => {
  assert.match(
    appSource,
    /report\.ok\s*\?\s*report\.checks\.slice\(-6\)\s*:\s*report\.checks\.filter\(\(check\) => check\.status !== "ok"\)/,
  );
  assert.match(appSource, /visibleChecks\.map\(\(check\) =>/);
});

test("saved ChatGPT authentication is refreshed before setup is presented", () => {
  assert.match(electronMain, /browserHost\.refreshAuthentication\(\)/);
  const productionStartup = electronMain.indexOf("} else void (async () => {");
  const refreshBarrier = electronMain.indexOf("await startupAuthenticationRefresh", productionStartup);
  const upgrade = electronMain.indexOf("runtimeHost.upgradeManagedRuntime()", productionStartup);
  const runtimeStart = electronMain.indexOf("runtimeSupervisor.startIfConfigured()", upgrade);
  const routeConnect = electronMain.indexOf("runtimeHost.connectBridgeRoute()", runtimeStart);
  assert.ok(refreshBarrier > productionStartup, "production startup must wait for saved-session refresh");
  assert.ok(upgrade > refreshBarrier, "runtime upgrade must not inspect the browser before refresh settles");
  assert.ok(runtimeStart > upgrade, "configured runtime must start after any upgrade");
  assert.ok(routeConnect > runtimeStart, "Codex route must connect only after the runtime is healthy");
  assert.match(appSource, /browser\?\.status === "loading"[\s\S]*?\? copy\.checkingSignIn/);
});

test("completed model setup remains a repeatable capability probe without auth gating", () => {
  assert.match(appSource, /<SetupRow[\s\S]*?onAction=\{install\}[\s\S]*?repeatable/);
  assert.match(appSource, /complete && !repeatable/);
  const setupCoreBlock = ipcRouterSource.slice(
    ipcRouterSource.indexOf('handle("launcher:setup-core",'),
    ipcRouterSource.indexOf('handle("launcher:connector-name",'),
  );
  assert.doesNotMatch(setupCoreBlock, /probeAuthentication|!browser\.authenticated|!setupState\.coreSetupComplete/);
});

test("catalog verification reports a failed request instead of requesting another restart, then recovers", async () => {
  const vm = require("node:vm");
  const source = catalogMonitorSource.slice(
    catalogMonitorSource.indexOf("class CatalogMonitor"),
    catalogMonitorSource.indexOf("module.exports"),
  );
  const state = { coreSetupComplete: true, codexCatalogVerified: false, codexRestartRequired: true, language: "en" };
  const operations = [];
  const events = [];
  let tick;
  let payload = { pid: 10, successful_model_catalog_requests: 0, model_catalog_requests: 0, last_model_catalog_result: null };
  vm.runInNewContext(`${source}
    new CatalogMonitor({
      logger,
      stateStore,
      getRuntimeSupervisor: () => runtimeSupervisor,
      getRuntimeHost: () => null,
      getLastOperation: () => lastOperation,
      publishOperation,
      send,
    }).start();`, {
    lastOperation: null,
    runtimeSupervisor: { readConfig: () => ({}), proxyHealthPayload: async () => payload },
    stateStore: { read: () => state, update: patch => Object.assign(state, patch) },
    setInterval: callback => { tick = callback; return { unref() { } }; },
    clearInterval() { },
    logger: { info: (...args) => events.push(args), warn: (...args) => events.push(args), debug() { } },
    send() { }, publishOperation: op => operations.push(op),
    nativeCopyFor: () => ({ catalogFailure: "Catalog failed (HTTP {status}; {reason})." }),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(operations.length, 0);
  assert.equal(state.codexRestartRequired, true);
  payload = {
    ...payload, model_catalog_requests: 1, last_model_catalog_result: {
      request: 1, at: "2026-09-16T10:00:00Z", status: 502, failure: { stage: "transport", code: "UnsupportedProxyProtocol" },
    }
  };
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.codexCatalogVerified, false);
  assert.equal(state.codexRestartRequired, false);
  assert.equal(operations[0]?.status, "failed");
  assert.match(operations[0].message, /502.*UnsupportedProxyProtocol/);
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(operations.length, 1, "polling must not repeat the same failure");
  payload = { ...payload, successful_model_catalog_requests: 1, last_successful_model_catalog_request_at: "2026-09-16T10:01:00Z" };
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.codexCatalogVerified, true);
  assert.equal(state.codexRestartRequired, false);
  assert.ok(events.some(([event]) => event === "codex.model_catalog_verified"));
});

test("fresh-conversation IPC commits only after setup succeeds and refuses active browser work", async () => {
  const vm = require("node:vm");
  for (const savedChats of [false, true]) {
    const property = savedChats ? "useSavedChats" : "experimentalFreshConversationPerTurn";
    const method = savedChats ? "setUseSavedChats" : "setFreshConversationPerTurn";
    const channel = savedChats ? "launcher:use-saved-chats" : "launcher:fresh-conversation-per-turn";
    const nextChannel = savedChats ? "launcher:set-preference" : "launcher:use-saved-chats";
    const source = ipcRouterSource.slice(
      ipcRouterSource.indexOf(`handle("${channel}",`),
      ipcRouterSource.indexOf(`handle("${nextChannel}",`),
    );
    const state = { experimentalFreshConversationPerTurn: false, useSavedChats: false };
    const config = { experimentalFreshConversationPerTurn: false, useSavedChats: false };
    const events = [];
    let handler, finishSetup, setupFailure, calls = 0;
    const browserHost = { activeTraceId: "running-turn", currentOperation: () => null, turnTabs: new Map() };
    const runtimeHost = {
      currentOperation: () => null, runtimeConfigSnapshot: () => ({ config }), [method]: async enabled => {
        calls++;
        if (setupFailure) throw setupFailure;
        await new Promise(resolve => { finishSetup = resolve; });
        config[property] = enabled;
        return { enabled };
      }
    };
    const syncSource = ipcRouterSource.slice(
      ipcRouterSource.indexOf("function syncFreshConversationPreference("),
      ipcRouterSource.indexOf("class IpcRouter"),
    );
    const sandboxStateStore = { read: () => ({ ...state }), update: patch => Object.assign(state, patch) };
    const sandboxSend = (eventChannel, value) => events.push({ channel: eventChannel, value: { ...value } });
    const sandbox = {
      handle: (_channel, callback) => { handler = callback; },
      getBrowserHost: () => browserHost,
      getRuntimeHost: () => runtimeHost,
      releaseRetainedConversation: require("../electron/browser/retained-turn-release.cjs").releaseRetainedConversation,
      stateStore: sandboxStateStore,
      send: sandboxSend,
    };
    sandbox.syncPrefs = (cfg) => sandbox.syncFreshConversationPreference(sandboxStateStore, cfg, {
      runtimeHost,
      browserHost,
      send: sandboxSend,
    });
    vm.runInNewContext(syncSource + source, sandbox);
    await assert.rejects(() => handler(null, true), /Finish or cancel active ChatGPT turns/);
    browserHost.activeTraceId = null;
    browserHost.currentOperation = () => "browser-smoke";
    await assert.rejects(() => handler(null, true), /Finish or cancel active ChatGPT turns/);
    assert.equal(calls, 0);
    browserHost.currentOperation = () => null;
    let api;
    vm.runInNewContext(preloadSource, {
      require: () => ({
        contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
        ipcRenderer: {
          invoke: (actualChannel, enabled) => {
            assert.equal(actualChannel, channel);
            return handler(null, enabled);
          }
        },
      })
    });
    const changing = api[method](true);
    assert.equal(state[property], false);
    assert.equal(events.length, 0);
    finishSetup();
    assert.equal((await changing)[property], true);
    assert.equal(events.length, 1);
    assert.equal(events[0].channel, "launcher:state-changed");
    setupFailure = new Error("synthetic setup rollback");
    await assert.rejects(() => api[method](false), /synthetic setup rollback/);
    assert.equal(state[property], true);
    assert.equal(events.length, 1);
  }
});

test("fresh-conversation snapshot uses runtime configuration", async () => {
  const vm = require("node:vm");
  const handlers = new Map();
  const state = { experimentalFreshConversationPerTurn: false };
  let config = { experimentalFreshConversationPerTurn: true };
  const runtimeHost = {
    currentOperation: () => null,
    runtimeConfigSnapshot: () => ({ config }), browserConnectorName: () => "Codex Native2",
    setupConnectorName: () => "Codex Native2", mcpCredentialsConfigured: () => true,
  };
  const browserHost = { activeTraceId: null, turnTabs: new Map(), currentOperation: () => null, snapshot: () => ({}) };
  const stateStore = { read: () => ({ ...state }), update: patch => Object.assign(state, patch) };
  const sandbox = {
    handle: (name, handler) => handlers.set(name, handler),
    getRuntimeHost: () => runtimeHost,
    getBrowserHost: () => browserHost,
    getUpdateController: () => null,
    getLastOperation: () => null,
    releaseRetainedConversation: require("../electron/browser/retained-turn-release.cjs").releaseRetainedConversation,
    stateStore,
    isDevProfile: false, send() { }, startCatalogVerificationMonitor() { },
    launcherProfile: { kind: "production", codexHome: "/fixture/codex" }, coreHome: "/fixture/core",
    launcherUserData: "/fixture/launcher", logger: { recent: () => [] },
    githubUrl: "", xUrl: "",
    process: { platform: "darwin" }, app: { isPackaged: false, getVersion: () => "test" },
    isSmokePassedThisSession: () => false, smokePassedForCurrentVersion: () => false,
  };
  sandbox.syncPrefs = (cfg) => sandbox.syncFreshConversationPreference(stateStore, cfg, {
    runtimeHost,
    browserHost,
    send: sandbox.send,
  });
  vm.runInNewContext(
    ipcRouterSource.slice(ipcRouterSource.indexOf("function syncFreshConversationPreference("), ipcRouterSource.indexOf("class IpcRouter")) +
    ipcRouterSource.slice(ipcRouterSource.indexOf('handle("launcher:snapshot",'), ipcRouterSource.indexOf('handle("launcher:set-language",')),
    sandbox,
  );
  const snapshot = handlers.get("launcher:snapshot");
  assert.equal((await snapshot()).state.experimentalFreshConversationPerTurn, true);
  assert.equal(state.experimentalFreshConversationPerTurn, true, "snapshot synchronizes a CLI configuration change");
  config = {};
  assert.equal((await snapshot()).state.experimentalFreshConversationPerTurn, false);
});

test("fresh-conversation setting row is removed from SettingsSurface", () => {
  const settings = appSource.slice(appSource.indexOf("function SettingsSurface("), appSource.indexOf("function ContentSurface("));
  assert.doesNotMatch(settings, /freshConversation|setFreshConversationPerTurn|experimentalFreshConversationPerTurn/);
});

test("plugin rename rejects active browser work and emits updated connector name", async () => {
  const vm = require("node:vm");
  const handlers = new Map();
  const state = {};
  const events = [];
  let fail = true, calls = 0;
  const browserHost = { activeTraceId: "busy", currentOperation: () => null };
  vm.runInNewContext(ipcRouterSource.slice(ipcRouterSource.indexOf('handle("launcher:connector-name",'),
    ipcRouterSource.indexOf('handle("launcher:autostart",')), {
    handle: (name, handler) => handlers.set(name, handler),
    getBrowserHost: () => browserHost,
    getRuntimeHost: () => ({
      setConnectorNameSuffix: async () => { calls++; if (fail) throw new Error("setup failed"); return { changed: true }; },
      browserConnectorName: () => "Codex Work",
      setupConnectorName: () => "Codex Work",
      runtimeConfigSnapshot: () => ({ config: { appName: "Codex Work" } }),
    }),
    stateStore: { read: () => state, update: patch => Object.assign(state, patch) },
    send: (channel, body) => events.push({ channel, body }),
  });
  const rename = handlers.get("launcher:connector-name");
  await assert.rejects(rename(null, "Work"), /Finish active Web turns/);
  assert.equal(calls, 0);
  browserHost.activeTraceId = null;
  await assert.rejects(rename(null, "Work"), /setup failed/);
  assert.equal(events.length, 0);
  fail = false;
  await rename(null, "Work");
  assert.equal(events[0].channel, "launcher:connector-name-changed");
  assert.equal(events[0].body, "Codex Work");
  assert.equal(events[1].channel, "launcher:state-changed");
});

test("Settings surface removes the plugin name editor while keeping other settings rows", () => {
  const ts = require("typescript");
  const vm = require("node:vm");
  const transpile = (source, fileName) => ts.transpileModule(source, {
    fileName, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React, jsxFactory: "element", jsxFragmentFactory: "Fragment"
    },
  }).outputText;
  const translated = { exports: {} };
  vm.runInNewContext(transpile(fs.readFileSync(path.join(launcherRoot, "src", "i18n.ts"), "utf8"), "i18n.ts"), translated);
  const copy = translated.exports.copyFor("en");
  const hooks = [];
  let cursor = 0;
  const sandbox = {
    element: (type, props, ...children) => ({ type, props: props ?? {}, children }), Fragment: "Fragment",
    useState: initial => {
      const index = cursor++; if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index], value => { hooks[index] = value; }];
    },
    messageOf: String, platformLabel: String, api: {},
  };
  for (const name of ["ContentSurface", "SectionHeading", "SettingRow", "PrimaryButton", "SecondaryButton", "Switch", "LanguageMenu", "NoticeRow", "Icon", "DoctorSummary", "BrandMark"]) sandbox[name] = name;
  const settings = appSource.slice(appSource.indexOf("function SettingsSurface("), appSource.indexOf("function ContentSurface("));
  vm.runInNewContext(transpile(settings, "settings.tsx") + "\nrender = SettingsSurface;", sandbox);
  const visit = tree => Array.isArray(tree) ? tree.flatMap(visit) : tree && typeof tree === "object"
    ? [tree, ...visit(tree.children ?? [])] : [];
  cursor = 0;
  const nodes = visit(sandbox.render({
    copy, devProfile: false, language: "en",
    snapshot: { connectorName: "Codex Native2", state: { coreSetupComplete: true } },
    setError: error => { if (error) throw new Error(error); }, updateState() { },
  }));
  assert.doesNotMatch(appSource, /plugin-name-setting|plugin-name-input|changePluginName/);
  assert.doesNotMatch(stylesSource, /\.plugin-name-setting|\.plugin-name-input|\.plugin-name-actions/);
  assert.equal(nodes.some(node => node.props.className === "plugin-name-input"), false);
  assert.ok(nodes.some(node => node.type === "SettingRow" && node.props.label === copy.launchAtLogin && !node.props.flushAfter));
});

test("setup shows uninstall action after core setup and calls uninstallIntegration", () => {
  const setupSlice = appSource.slice(appSource.indexOf("function SetupSurface("), appSource.indexOf("function SettingsSurface("));
  assert.match(setupSlice, /api!\.uninstallIntegration\(\)/);
  assert.match(setupSlice, /label=\{copy\.uninstallIntegration\}/);
  assert.match(setupSlice, /\{copy\.uninstall\}/);
});

test("multi-provider IPC channels and dynamic provider rendering stay wired cleanly", async () => {
  const vm = require("node:vm");
  const handlers = new Map();
  let state = { selectedProvider: "m365", smokePassedByProvider: {} };
  const events = [];
  const providers = [
    { id: "m365", displayName: "M365 Copilot", homeUrl: "https://m365.cloud.microsoft/chat", partition: "persist:m365", active: true, authenticated: true },
    { id: "gemini", displayName: "Gemini Web", homeUrl: "https://gemini.google.com/app", partition: "persist:gemini", active: false, authenticated: false },
  ];
  const browserHost = {
    provider: "m365",
    listProviders: () => providers,
    switchProvider: async (id) => ({ provider: id, authenticated: id === "m365", providers }),
    smokeTest: async (id) => ({ ok: true, provider: id || "m365", effort: "high", response: "OK" }),
  };

  assert.match(preloadSource, /listProviders:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("launcher:list-providers"\)/);
  assert.match(preloadSource, /switchProvider:\s*\(providerId\)\s*=>\s*ipcRenderer\.invoke\("launcher:switch-provider",\s*providerId\)/);

  vm.runInNewContext(
    ipcRouterSource.slice(
      ipcRouterSource.indexOf('handle("launcher:list-providers",'),
      ipcRouterSource.indexOf('handle("launcher:doctor",'),
    ),
    {
      handle: (name, handler) => handlers.set(name, handler),
      getBrowserHost: () => browserHost,
      awaitRuntimeStartup: async () => { },
      stateStore: {
        read: () => state,
        update: (patch) => {
          state = { ...state, ...patch };
          return state;
        },
      },
      app: { getVersion: () => "1.2.3" },
      send: (channel, body) => events.push({ channel, body }),
      markSmokePassedThisSession() { },
    },
  );

  assert.equal((await handlers.get("launcher:list-providers")()).length, 2);
  await handlers.get("launcher:switch-provider")(null, "gemini");
  assert.equal(state.selectedProvider, "gemini");
  await handlers.get("launcher:browser-smoke")(null, "gemini");
  assert.deepEqual({ ...state.smokePassedByProvider.gemini }, { passed: true, version: "1.2.3" });
  assert.equal("m365SmokePassed" in state, false);
  assert.ok(events.some((event) => event.channel === "launcher:state-changed"));

  const setupSlice = appSource.slice(appSource.indexOf("function SetupSurface("), appSource.indexOf("function SettingsSurface("));
  assert.match(setupSlice, /resolveProviders\(browser,\s*snapshot\)/);
  assert.doesNotMatch(setupSlice, /m365SmokePassed|m365Authenticated/);

  const browserSlice = appSource.slice(appSource.indexOf("function BrowserSurface("), appSource.indexOf("function SetupSurface("));
  assert.match(browserSlice, /className="provider-switcher"/);
  assert.match(browserSlice, /api!\.switchProvider\(providerId\)/);
  assert.match(browserSlice, /switchProvider\(item\.id\)/);
});

test("settings opens Swagger UI for production runtime when server is healthy", async () => {
  const vm = require("node:vm");
  const settingsSlice = appSource.slice(
    appSource.indexOf("function SettingsSurface("),
    appSource.indexOf("function ContentSurface("),
  );
  assert.match(settingsSlice, /!devProfile \? <button[\s\S]*?!snapshot\.state\.coreSetupComplete[\s\S]*?openSwagger\(\)/);
  assert.match(preloadSource, /openSwagger:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("launcher:open-swagger"\)/);
  assert.match(ipcRouterSource, /"launcher:open-swagger"/);

  const slice = ipcRouterSource.slice(
    ipcRouterSource.indexOf('handle("launcher:open-swagger",'),
    ipcRouterSource.indexOf('handle("launcher:cancel-turns",'),
  );

  const register = ({ isDevProfile = false, runtimeSnapshot, fetchImpl, openWebUrl }) => {
    let openSwaggerHandler;
    vm.runInNewContext(slice, {
      handle: (_name, handler) => { openSwaggerHandler = handler; },
      isDevProfile,
      getRuntimeHost: () => ({ runtimeConfigSnapshot: () => runtimeSnapshot }),
      fetch: fetchImpl,
      openWebUrl,
      AbortController,
      setTimeout,
      clearTimeout,
    });
    return openSwaggerHandler;
  };

  await assert.rejects(
    register({
      isDevProfile: true,
      runtimeSnapshot: { configured: true, config: { host: "127.0.0.1", port: 17841 } },
      fetchImpl: async () => ({ ok: true }),
      openWebUrl: async () => {},
    }),
    /DEV profile/,
  );

  await assert.rejects(
    register({
      runtimeSnapshot: { configured: false },
      fetchImpl: async () => ({ ok: true }),
      openWebUrl: async () => {},
    }),
    /Set up the launcher/,
  );

  await assert.rejects(
    register({
      runtimeSnapshot: { configured: true, config: { host: "127.0.0.1", port: 17841 } },
      fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); },
      openWebUrl: async () => {},
    }),
    /not reachable on http:\/\/127\.0\.0\.1:17841/,
  );

  const opened = [];
  const fetched = [];
  const result = await register({
    runtimeSnapshot: { configured: true, config: { host: "127.0.0.1", port: 17899 } },
    fetchImpl: async (url) => {
      fetched.push(url);
      return { ok: true };
    },
    openWebUrl: async (url) => { opened.push(url); },
  })();
  assert.deepEqual(fetched, ["http://127.0.0.1:17899/healthz"]);
  assert.deepEqual(opened, ["http://127.0.0.1:17899/swagger"]);
  assert.deepEqual({ ...result }, { url: "http://127.0.0.1:17899/swagger" });
});

test("personalization tab is wired across sidebar, preload, and IPC router", () => {
  assert.match(appSource, /PersonalizationSurface/);
  assert.match(appSource, /navigateSurface\("personalization"\)/);
  assert.match(appSource, /surface === "personalization"/);
  assert.match(preloadSource, /getPersonalization:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("launcher:personalization-get"\)/);
  assert.match(preloadSource, /savePersonalization:\s*\(settings\)\s*=>\s*ipcRenderer\.invoke\("launcher:personalization-save", settings\)/);
  assert.match(ipcRouterSource, /handle\("launcher:personalization-get",/);
  assert.match(ipcRouterSource, /handle\("launcher:personalization-save",/);
});

test("multi-profile state sanitization and renderer/preload/IPC wiring work end-to-end", () => {
  const { sanitizeProviderProfiles } = require("../electron/infra/state-store.cjs");
  const normalized = sanitizeProviderProfiles({
    "ai-studio": {
      activeProfileId: "missing-id",
      profiles: [
        { id: "p2", name: "  Work Gmail  ", authenticated: true },
        { id: "INVALID_ID!", name: "Bad" },
        { id: "p2", name: "Duplicate" },
      ],
    },
  });

  assert.equal(normalized["ai-studio"].activeProfileId, "default");
  assert.deepEqual(normalized["ai-studio"].profiles, [
    { id: "default", name: "Default", authenticated: false },
    { id: "p2", name: "Work Gmail", authenticated: true },
  ]);

  assert.match(preloadSource, /switchProviderProfile:\s*\(providerId,\s*profileId\)\s*=>/);
  assert.match(preloadSource, /createProviderProfile:\s*\(providerId,\s*name\)\s*=>/);
  assert.match(preloadSource, /renameProviderProfile:\s*\(providerId,\s*profileId,\s*name\)\s*=>/);
  assert.match(preloadSource, /deleteProviderProfile:\s*\(providerId,\s*profileId\)\s*=>/);
  assert.match(ipcRouterSource, /handle\("launcher:switch-provider-profile",/);
  assert.match(ipcRouterSource, /handle\("launcher:create-provider-profile",/);
  assert.match(ipcRouterSource, /handle\("launcher:rename-provider-profile",/);
  assert.match(ipcRouterSource, /handle\("launcher:delete-provider-profile",/);
  assert.match(appSource, /className="profile-switcher"/);
  assert.match(appSource, /className="profile-manager"/);
  assert.match(appSource, /api!\.switchProviderProfile\(/);
});
