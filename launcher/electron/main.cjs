const { configureWindowsTrust } = require("./infra/windows-trust.cjs");
configureWindowsTrust();
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  dialog,
  nativeTheme,
  screen,
  shell,
} = require("electron");
const {
  BrowserHost,
  createDefaultProviderRegistry,
  navigationErrorForLog,
} = require("./browser/browser-host.cjs");
const { sanitizeChromeUserAgent } = require("./browser/providers/base-browser-provider.cjs");
const { BrowserControlServer } = require("./browser/control-server.cjs");
const { getAutostart, setAutostart } = require("./app/autostart.cjs");
const { CatalogMonitor } = require("./app/catalog-monitor.cjs");
const { IpcRouter, syncFreshConversationPreference, windowStateSnapshot } = require("./app/ipc-router.cjs");
const { TrayController, nativeCopyFor } = require("./app/tray-controller.cjs");
const { createUpdateController } = require("./app/update-controller.cjs");
const {
  MIN_WINDOW_BOUNDS,
  readWindowState,
  trackWindowState,
} = require("./app/window-state.cjs");
const {
  createLogger,
  installProcessDiagnosticGuards,
} = require("./infra/logging.cjs");
const { DEVELOPMENT_PROFILE, resolveLauncherProfile } = require("./infra/profile.cjs");
const {
  createStateStore,
  nextSessionRefreshReminderAt,
} = require("./infra/state-store.cjs");
const { runtimeBundlePaths } = require("./runtime/runtime-command.cjs");
const { RuntimeHost } = require("./runtime/runtime-host.cjs");
const { ensurePackagedRuntime, waitForPackagedRuntimeSource } = require("./runtime/runtime-install.cjs");
const { RuntimeSupervisor } = require("./runtime/runtime-supervisor.cjs");

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const SOURCE_ROOT = path.resolve(__dirname, "../..");
const LAUNCHER_PROFILE = resolveLauncherProfile({ appData: app.getPath("appData") });
const IS_DEV_PROFILE = LAUNCHER_PROFILE.kind === DEVELOPMENT_PROFILE;
const CORE_HOME = LAUNCHER_PROFILE.coreHome;
const BROWSER_DESCRIPTOR_PATH = path.join(CORE_HOME, "runtime", "launcher-browser.json");
const BROWSER_HELPER_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "runtime", "app", "browser-helper.cjs")
  : path.join(SOURCE_ROOT, ".launcher-runtime", "browser-helper.cjs");
const GITHUB_URL = "https://github.com/huytvdev22/codex-chatgpt-web";
const X_URL = "https://x.com/miu21590";
const ALLOWED_EXTERNAL_URLS = new Set([GITHUB_URL, X_URL]);
const PACKAGED_RENDERER_URL = pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href;
const APP_ICON_PATH = path.join(__dirname, "..", "assets", "icon.png");

const launchEnvironment = {
  CODEX_CHATGPT_WEB_HOME: process.env.CODEX_CHATGPT_WEB_HOME,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.CODEX_CHATGPT_WEB_HOME = CORE_HOME;
process.env.CODEX_HOME = LAUNCHER_PROFILE.codexHome;
app.setName(LAUNCHER_PROFILE.displayName);
if (process.platform === "win32") {
  app.setAppUserModelId(IS_DEV_PROFILE ? "dev.codexwebgpt.launcher.dev" : "dev.codexwebgpt.launcher");
}
const launcherUserData = LAUNCHER_PROFILE.userData;
fs.mkdirSync(launcherUserData, { recursive: true, mode: 0o700 });
if (process.platform !== "win32") fs.chmodSync(launcherUserData, 0o700);
app.setPath("userData", launcherUserData);
app.setAppLogsPath(path.join(launcherUserData, "logs"));
installProcessDiagnosticGuards({
  filePath: path.join(launcherUserData, "logs", "process-stream-errors.log"),
});

let mainWindow = null;
let mainWindowReadyToShow = false;
let mainWindowShowRequested = false;
let startupFailed = false;
let browserHost = null;
let runtimeHost = null;
// Renderer actions can arrive as soon as loadRenderer starts, before startup has acquired any
// runtime operation lock. Keep setup/settings behind startup and its recovery as one boundary.
let finishRuntimeStartup;
const runtimeStartup = new Promise(resolve => { finishRuntimeStartup = resolve; });
let browserControl = null;
let runtimeSupervisor = null;
let trayController = null;
let catalogMonitor = null;
let quitting = false;
let shutdownInProgress = false;
let exitCommitted = false;
let smokePassedThisSession = false;
let cdpPort = 0;
let lastOperation = null;
let updateController = null;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function send(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, value);
  }
}

function publishOperation(operation) {
  lastOperation = operation;
  send("launcher:operation", operation);
}

function showMainWindow() {
  // A Windows login launch may still be materializing the packaged runtime when the user opens
  // the desktop shortcut. Electron delivers `second-instance` immediately, before `createWindow`
  // has produced anything to show. Preserve that foreground request until the real window reaches
  // `ready-to-show`; otherwise the already-running `--hidden` instance silently consumes it.
  mainWindowShowRequested = true;
  if ((!mainWindowReadyToShow && !startupFailed) || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindowShowRequested = false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function openWebUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Refusing to open a non-web URL: ${parsed.protocol}`);
  }
  await shell.openExternal(parsed.toString());
}

function rendererNavigationAllowed(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    return false;
  }
  if (isDev) {
    try {
      return target.origin === new URL(process.env.VITE_DEV_SERVER_URL).origin;
    } catch {
      return false;
    }
  }
  target.hash = "";
  target.search = "";
  return target.href === PACKAGED_RENDERER_URL;
}

function createWindow({ logger, stateStore, windowStatePath, startHidden }) {
  const isMac = process.platform === "darwin";
  const state = stateStore.read();
  const windowState = readWindowState(windowStatePath, screen.getAllDisplays());
  const window = new BrowserWindow({
    width: windowState.bounds.width,
    height: windowState.bounds.height,
    ...(Number.isFinite(windowState.bounds.x) && Number.isFinite(windowState.bounds.y)
      ? { x: windowState.bounds.x, y: windowState.bounds.y }
      : {}),
    minWidth: MIN_WINDOW_BOUNDS.width,
    minHeight: MIN_WINDOW_BOUNDS.height,
    title: LAUNCHER_PROFILE.displayName,
    icon: APP_ICON_PATH,
    show: false,
    backgroundColor: isMac ? "#00000000" : "#181818",
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    transparent: isMac,
    ...(isMac ? {
      trafficLightPosition: { x: 16, y: 17 },
      vibrancy: "under-window",
      visualEffectState: "active",
    } : {
      titleBarOverlay: {
        color: "#181818",
        symbolColor: "#a8a8a8",
        height: 46,
      },
    }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      v8CacheOptions: "bypassHeatCheckAndEagerCompile",
    },
  });
  window.setMenuBarVisibility(false);
  const guardRendererNavigation = (event, url) => {
    if (rendererNavigationAllowed(url)) return;
    event.preventDefault();
    let destination = "invalid URL";
    try { destination = new URL(url).origin; } catch {}
    logger.warn("launcher.renderer_navigation_blocked", { destination });
  };
  window.webContents.on("will-navigate", guardRendererNavigation);
  window.webContents.on("will-redirect", guardRendererNavigation);
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openWebUrl(url).catch((error) => {
      logger.warn("launcher.external_url_rejected", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return { action: "deny" };
  });
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (stateStore.read().keepRunningOnClose && trayController?.isAvailable()) window.hide();
    else void requestQuit();
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
      mainWindowReadyToShow = false;
    }
  });
  for (const event of ["enter-full-screen", "leave-full-screen", "maximize", "unmaximize"]) {
    window.on(event, () => send("launcher:window-state-changed", windowStateSnapshot(window)));
  }
  window.once("ready-to-show", () => {
    if (!state.onboardingComplete && !Number.isFinite(windowState.bounds.x)) window.center();
    if (windowState.maximized) window.maximize();
    if (windowState.fullscreen) window.setFullScreen(true);
    if (mainWindow === window) mainWindowReadyToShow = true;
    if (mainWindowShowRequested) showMainWindow();
    else if (!startHidden) window.show();
  });
  trackWindowState(window, windowStatePath, (error) => {
    logger.warn("launcher.window_state_write_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  });
  logger.info("launcher.window_created", { platform: process.platform, cdpPort });
  return window;
}

async function loadRenderer(window) {
  if (isDev) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
    return;
  }
  await window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

function syncPrefs(stateStore, config) {
  return syncFreshConversationPreference(stateStore, config, {
    runtimeHost,
    browserHost,
    send,
  });
}

async function requestQuit() {
  if (shutdownInProgress || exitCommitted) {
    return { ok: false, message: "Launcher shutdown is already in progress" };
  }
  shutdownInProgress = true;
  try {
    const activeOperation = runtimeHost?.currentOperation() || browserHost?.currentOperation();
    if (activeOperation) {
      throw new Error(`Wait for ${activeOperation} to finish before quitting Codex Web GPT`);
    }
    await runtimeSupervisor?.shutdown({ cancelActiveTurns: true, force: true });
    catalogMonitor?.stop();
    quitting = true;
    await browserHost?.persistSession();
    browserHost?.destroy();
    await browserControl?.close();
    exitCommitted = true;
    app.quit();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    quitting = false;
    showMainWindow();
    publishOperation({ name: "launcher-quit", status: "failed", message });
    return { ok: false, message };
  } finally {
    shutdownInProgress = false;
  }
}

async function start() {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on("second-instance", () => showMainWindow());
  app.on("activate", () => showMainWindow());

  cdpPort = await findFreePort();
  if (process.platform === "linux") {
    app.commandLine.appendSwitch("class", IS_DEV_PROFILE ? "codex-web-gpt-dev" : "codex-web-gpt");
  }
  // Giữ nguyên cơ chế tiết kiệm tài nguyên mặc định của Chromium cho renderer nền.
  // Lưu ý: Trong Chromium, các cờ "disable-*" là boolean switch (chỉ kiểm tra sự tồn tại
  // bằng HasSwitch, không đọc giá trị "false"). Do đó phải dùng removeSwitch thay vì appendSwitch.
  app.commandLine.removeSwitch("disable-background-timer-throttling");
  app.commandLine.removeSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.removeSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-component-update");
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));

  await app.whenReady();
  const cleanFallbackUa = sanitizeChromeUserAgent(app.userAgentFallback);
  if (cleanFallbackUa && cleanFallbackUa !== app.userAgentFallback) {
    app.userAgentFallback = cleanFallbackUa;
  }

  const providerRegistry = createDefaultProviderRegistry({
    descriptorPath: BROWSER_DESCRIPTOR_PATH,
    profile: LAUNCHER_PROFILE.kind,
  });
  const stateStore = createStateStore(path.join(app.getPath("userData"), "launcher-state.json"), {
    defaultProvider: providerRegistry.defaultId(),
    isValidProvider: id => providerRegistry.has(id),
  });
  if (IS_DEV_PROFILE && !stateStore.read().onboardingComplete) {
    stateStore.update({
      language: stateStore.read().language || "en",
      onboardingComplete: true,
      autoStart: false,
    });
  }
  if (stateStore.read().sessionRefreshReminderAt === null) {
    stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
  }
  const persistedState = stateStore.read();
  if (persistedState.coreSetupComplete === true && persistedState.codexCatalogVerified === undefined) {
    stateStore.update({
      coreSetupComplete: false,
      codexCatalogVerified: false,
      codexRestartRequired: false,
    });
  }
  const autostart = IS_DEV_PROFILE ? { supported: false, enabled: false } : getAutostart(app);
  if (!IS_DEV_PROFILE
    && stateStore.read().onboardingComplete
    && autostart.supported
    && stateStore.read().autoStart !== autostart.enabled) {
    setAutostart(app, stateStore.read().autoStart);
  }
  const logger = createLogger({
    filePath: path.join(app.getPath("logs"), "launcher.jsonl"),
  });
  const startHidden = process.argv.includes("--hidden") && stateStore.read().onboardingComplete;
  const launcherSmokeTest = process.argv.includes("--launcher-smoke-test");
  nativeTheme.themeSource = "system";
  publishOperation({
    name: "launcher-startup",
    status: "running",
    message: "Preparing local runtime",
  });
  mainWindow = createWindow({
    logger,
    stateStore,
    windowStatePath: path.join(app.getPath("userData"), "window-state.json"),
    startHidden,
  });
  catalogMonitor = new CatalogMonitor({
    logger,
    stateStore,
    getRuntimeSupervisor: () => runtimeSupervisor,
    getRuntimeHost: () => runtimeHost,
    getLastOperation: () => lastOperation,
    publishOperation,
    send,
  });
  trayController = new TrayController({
    logger,
    appIconPath: APP_ICON_PATH,
    displayName: LAUNCHER_PROFILE.displayName,
    showMainWindow,
    requestQuit,
  });
  new IpcRouter({
    app,
    logger,
    stateStore,
    launcherProfile: LAUNCHER_PROFILE,
    isDevProfile: IS_DEV_PROFILE,
    coreHome: CORE_HOME,
    launcherUserData,
    githubUrl: GITHUB_URL,
    xUrl: X_URL,
    allowedExternalUrls: ALLOWED_EXTERNAL_URLS,
    awaitRuntimeStartup: () => runtimeStartup,
    getMainWindow: () => mainWindow,
    getBrowserHost: () => browserHost,
    getRuntimeHost: () => runtimeHost,
    getUpdateController: () => updateController,
    getLastOperation: () => lastOperation,
    isSmokePassedThisSession: () => smokePassedThisSession,
    markSmokePassedThisSession: () => { smokePassedThisSession = true; },
    send,
    openWebUrl,
    updateTrayMenu: (language) => trayController.updateMenu(language),
    startCatalogVerificationMonitor: () => catalogMonitor.start(),
    stopCatalogVerificationMonitor: () => catalogMonitor.stop(),
    requestQuit,
  }).register();
  const trayAvailable = trayController.create(stateStore.read().language);
  if (startHidden && !trayAvailable) mainWindow.once("ready-to-show", () => showMainWindow());
  const rendererReady = loadRenderer(mainWindow);
  await rendererReady;
  if (!launcherSmokeTest && !startHidden) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  await waitForPackagedRuntimeSource({ app, resourcesPath: process.resourcesPath });
  let installedRuntimeRoot = null;
  let runtimeRootResolved = false;
  const runtimeRootProvider = () => {
    const packagedRuntimeWasRemoved = app.isPackaged
      && (!installedRuntimeRoot || !fs.existsSync(installedRuntimeRoot));
    if (!runtimeRootResolved || packagedRuntimeWasRemoved) {
      installedRuntimeRoot = ensurePackagedRuntime({
        app,
        coreHome: CORE_HOME,
        resourcesPath: process.resourcesPath,
      });
      runtimeRootResolved = true;
    }
    return installedRuntimeRoot;
  };
  installedRuntimeRoot = runtimeRootProvider();

  publishOperation({
    name: "launcher-startup",
    status: "running",
    message: "Initializing embedded browser",
  });
  browserControl = await new BrowserControlServer({
    logger,
    getBrowserHost: () => browserHost,
    getPreferences: () => syncPrefs(stateStore, runtimeHost.runtimeConfigSnapshot().config),
    providerRegistry,
  }).start();
  runtimeSupervisor = new RuntimeSupervisor({
    app,
    logger,
    sourceRoot: SOURCE_ROOT,
    installedRuntimeRoot,
    runtimeRootProvider,
    coreHome: CORE_HOME,
    browserDescriptorPath: BROWSER_DESCRIPTOR_PATH,
    launcherProfile: LAUNCHER_PROFILE.kind,
    publishOperation,
    onConfigRead: config => {
      // Setup may read an intermediate config before rollback. The setting IPC commits
      // its change only after the existing setup transaction has succeeded.
      if (browserHost && !runtimeHost?.currentOperation()) syncPrefs(stateStore, config);
    },
  });
  runtimeHost = new RuntimeHost({
    app,
    logger,
    sourceRoot: SOURCE_ROOT,
    installedRuntimeRoot,
    runtimeRootProvider,
    browserDescriptorPath: BROWSER_DESCRIPTOR_PATH,
    coreHome: CORE_HOME,
    codexHome: LAUNCHER_PROFILE.codexHome,
    launcherProfile: LAUNCHER_PROFILE.kind,
    publishOperation,
    supervisor: runtimeSupervisor,
  });
  browserHost = new BrowserHost({
    window: mainWindow,
    descriptorPath: BROWSER_DESCRIPTOR_PATH,
    cdpPort,
    control: browserControl.descriptor(),
    cancelTurn: IS_DEV_PROFILE ? undefined : (traceId, reason) => runtimeSupervisor.cancelBrowserTurn(traceId, reason),
    getConnectorName: () => runtimeHost.browserConnectorName(),
    getUseSavedChats: () => runtimeHost.runtimeConfigSnapshot().config?.useSavedChats === true,
    helper: { executable: process.execPath, script: BROWSER_HELPER_PATH },
    logger,
    partition: LAUNCHER_PROFILE.browserPartition,
    profile: LAUNCHER_PROFILE.kind,
    publishState: (state) => send("launcher:browser-state", state),
    showWindow: showMainWindow,
    provider: stateStore.read().selectedProvider,
    providerRegistry,
  });
  await browserHost.ready();
  const updaterRuntimeRoot = runtimeRootProvider();
  updateController = createUpdateController({
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged && !IS_DEV_PROFILE,
    executablePath: process.execPath,
    runtimeExecutable: updaterRuntimeRoot
      ? runtimeBundlePaths(updaterRuntimeRoot, process.platform).executable
      : null,
    logsDirectory: app.getPath("logs"),
    publish: (state) => send("launcher:update-state", state),
    logger,
  });
  send("launcher:connector-name-changed", runtimeHost.browserConnectorName());
  send("launcher:state-changed", syncPrefs(stateStore, runtimeHost.runtimeConfigSnapshot().config));
  send("launcher:browser-state", browserHost.snapshot());
  let startupAuthenticationRefresh = Promise.resolve();
  if (!launcherSmokeTest) {
    publishOperation({
      name: "launcher-startup",
      status: "running",
      message: "Checking saved sign-in session",
    });
    startupAuthenticationRefresh = browserHost.refreshAuthentication().catch((error) => {
      logger.warn("browser.session_refresh_failed", {
        ...navigationErrorForLog(error),
      });
    });
  }
  if (!launcherSmokeTest) void updateController.checkOnce();
  if (launcherSmokeTest) {
    const smokeRuntimeRoot = runtimeRootProvider();
    if (app.isPackaged && !smokeRuntimeRoot) {
      throw new Error("Packaged launcher smoke test could not install its durable runtime");
    }
    const versionInvocation = runtimeSupervisor.runtimeCommand(["--version"]);
    const versionResult = spawnSync(versionInvocation.executable, versionInvocation.args, {
      cwd: versionInvocation.cwd,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    if (versionResult.error) throw versionResult.error;
    if (versionResult.status !== 0 || versionResult.stdout.trim() !== app.getVersion()) {
      throw new Error(
        `Installed launcher runtime is not executable`
        + ` (status=${versionResult.status ?? "unknown"}, stdout=${JSON.stringify(versionResult.stdout.trim())},`
        + ` stderr=${JSON.stringify(versionResult.stderr.trim())})`,
      );
    }
    const markerPath = process.env.CODEX_WEB_GPT_SMOKE_FILE?.trim();
    if (!markerPath || !path.isAbsolute(markerPath)) {
      throw new Error("Packaged launcher smoke test requires an absolute CODEX_WEB_GPT_SMOKE_FILE");
    }
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `${JSON.stringify({
      ok: true,
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
      runtimeVerified: true,
    })}\n`);
    browserHost.destroy();
    await browserControl.close();
    mainWindow.destroy();
    app.quit();
    return;
  }
  if (IS_DEV_PROFILE) {
    let config = null;
    try {
      config = runtimeSupervisor.readConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("dev_profile.config_invalid", { message });
      publishOperation({ name: "dev-profile", status: "failed", message });
    }
    const state = stateStore.update({
      coreSetupComplete: Boolean(config),
      codexCatalogVerified: Boolean(config),
      codexRestartRequired: false,
      autoStart: false,
      experimentalBiggerContext: config?.experimentalBiggerContext === true,
      experimentalSkillAttachments: config?.experimentalSkillAttachments === true,
      experimentalFreshConversationPerTurn: config?.experimentalFreshConversationPerTurn === true,
      useSavedChats: config?.useSavedChats === true,
    });
    send("launcher:state-changed", state);
    logger.info("dev_profile.ready", {
      configured: Boolean(config),
      mode: config?.mode || null,
      coreHome: CORE_HOME,
      userData: launcherUserData,
    });
    if (config?.mode === "full") {
      void startupAuthenticationRefresh.then(() => {
        publishOperation({ name: "launcher-startup", status: "running", message: "Starting local bridge service" });
        return runtimeSupervisor.startIfConfigured();
      }).then(() => {
        publishOperation({ name: "launcher-startup", status: "completed", message: "Launcher ready" });
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("dev_profile.runtime_start_failed", { message });
        publishOperation({ name: "dev-profile", status: "failed", message });
      }).finally(finishRuntimeStartup);
    } else {
      publishOperation({ name: "launcher-startup", status: "completed", message: "Launcher ready" });
      finishRuntimeStartup();
    }
  } else void (async () => {
    await startupAuthenticationRefresh;
    publishOperation({ name: "launcher-startup", status: "running", message: "Starting local bridge service" });
    const upgrade = await runtimeHost.upgradeManagedRuntime();
    if (upgrade.updated) {
      const state = stateStore.update({
        coreSetupComplete: true,
        codexCatalogVerified: false,
        codexRestartRequired: true,
        experimentalBiggerContext: runtimeHost.runtimeConfigSnapshot().config?.experimentalBiggerContext === true,
        experimentalSkillAttachments: runtimeHost.runtimeConfigSnapshot().config?.experimentalSkillAttachments === true,
        experimentalFreshConversationPerTurn: runtimeHost.runtimeConfigSnapshot().config?.experimentalFreshConversationPerTurn === true,
        useSavedChats: runtimeHost.runtimeConfigSnapshot().config?.useSavedChats === true,
      });
      send("launcher:state-changed", state);
      logger.info("runtime.release_upgraded", {
        fromVersion: upgrade.fromVersion,
        toVersion: upgrade.toVersion,
        mode: upgrade.mode,
        connectorMigrated: upgrade.connectorMigrated,
      });
    }
    const configuredRuntime = runtimeHost.runtimeConfigSnapshot();
    if (configuredRuntime.configured) {
      const enabled = configuredRuntime.config?.experimentalBiggerContext === true;
      const experimentalSkillAttachments = configuredRuntime.config?.experimentalSkillAttachments === true;
      const experimentalFreshConversationPerTurn = configuredRuntime.config?.experimentalFreshConversationPerTurn === true;
      const useSavedChats = configuredRuntime.config?.useSavedChats === true;
      const saved = stateStore.read();
      if (saved.experimentalSkillAttachments !== experimentalSkillAttachments
        || saved.experimentalFreshConversationPerTurn !== experimentalFreshConversationPerTurn
        || saved.useSavedChats !== useSavedChats
        || saved.experimentalBiggerContext !== enabled) {
        const state = stateStore.update({ experimentalBiggerContext: enabled, experimentalSkillAttachments, experimentalFreshConversationPerTurn, useSavedChats });
        send("launcher:state-changed", state);
      }
    }
    const runtime = await runtimeSupervisor.startIfConfigured();
    if (runtime.status !== "ready") return runtime;
    const route = await runtimeHost.connectBridgeRoute();
    return { ...runtime, bridgeRouteChanged: route.changed === true };
  })().then(async (runtime) => {
    publishOperation({ name: "launcher-startup", status: "completed", message: "Launcher ready" });
    if (runtime.status === "ready") {
      const config = runtimeSupervisor.readConfig();
      const current = stateStore.read();
      const patch = {
        coreSetupComplete: true,
        experimentalBiggerContext: config.experimentalBiggerContext === true,
        experimentalSkillAttachments: config.experimentalSkillAttachments === true,
        experimentalFreshConversationPerTurn: config.experimentalFreshConversationPerTurn === true,
        useSavedChats: config.useSavedChats === true,
        ...(runtime.bridgeRouteChanged ? {
          codexCatalogVerified: false,
          codexRestartRequired: true,
        } : {}),
      };
      if (Object.entries(patch).some(([key, value]) => current[key] !== value)) {
        const state = stateStore.update(patch);
        send("launcher:state-changed", state);
      }
      catalogMonitor.start();
      return;
    }
    if (runtime.status === "not-configured") {
      const routeRecovery = await catalogMonitor.restoreCodexRouteAfterRuntimeFailure();
      const current = stateStore.read();
      if (current.coreSetupComplete) {
        const state = stateStore.update({
          coreSetupComplete: false,
          codexCatalogVerified: false,
        });
        send("launcher:state-changed", state);
      }
      if (routeRecovery.error) {
        publishOperation({
          name: "runtime-start",
          status: "failed",
          message: `Local runtime is not configured; restoring the previous Codex route also failed: ${routeRecovery.error}`,
        });
      }
      return;
    }
    const routeRecovery = await catalogMonitor.restoreCodexRouteAfterRuntimeFailure();
    const state = stateStore.update({ coreSetupComplete: false, codexCatalogVerified: false });
    send("launcher:state-changed", state);
    if (runtime.status === "external" || runtime.status === "needs-setup") {
      const detail = runtime.detail || (
        runtime.status === "external"
          ? "Another process owns the configured Codex Web GPT runtime"
          : "The installed runtime configuration must be repaired from Setup"
      );
      publishOperation({
        name: "runtime-start",
        status: "failed",
        message: routeRecovery.error
          ? `${detail}; restoring the previous Codex route also failed: ${routeRecovery.error}`
          : routeRecovery.restored
            ? `${detail}; the previous Codex route was restored, restart Codex once`
            : detail,
      });
    }
  }).catch(async (error) => {
    const primary = error instanceof Error ? error.message : String(error);
    const routeRecovery = await catalogMonitor.restoreCodexRouteAfterRuntimeFailure();
    const message = routeRecovery.error
      ? `${primary}; restoring the previous Codex route also failed: ${routeRecovery.error}`
      : routeRecovery.restored
        ? `${primary}; the previous Codex route was restored, restart Codex once`
        : primary;
    logger.error("runtime.startup_failed", { message });
    const state = stateStore.update({ coreSetupComplete: false, codexCatalogVerified: false });
    send("launcher:state-changed", state);
    publishOperation({ name: "runtime-start", status: "failed", message });
  }).finally(finishRuntimeStartup);

  app.on("before-quit", (event) => {
    if (exitCommitted) return;
    event.preventDefault();
    void requestQuit();
  });
  process.once("SIGINT", () => { void requestQuit(); });
  process.once("SIGTERM", () => { void requestQuit(); });
}

void start().catch(async (error) => {
  startupFailed = true;
  const message = error instanceof Error ? error.message : String(error);
  try {
    fs.appendFileSync(path.join(app.getPath("logs"), "launcher-fatal.log"), `${new Date().toISOString()} ${error?.stack || error}\n`);
  } catch {}
  try {
    // Browser bootstrap can fail before the renderer is loaded. Keep the error reachable
    // through the existing instance, and release browser resources before a user retry.
    const cleanupErrors = [];
    try { browserHost?.destroy(); } catch (caught) { cleanupErrors.push(String(caught)); }
    try { await browserControl?.close(); } catch (caught) { cleanupErrors.push(String(caught)); }
    if (process.argv.includes("--launcher-smoke-test")) return;
    await app.whenReady();
    quitting = true;
    showMainWindow();
    const copy = nativeCopyFor(createStateStore(path.join(app.getPath("userData"), "launcher-state.json")).read().language);
    const options = {
      type: "error",
      title: copy.startupTitle,
      message,
      detail: [copy.startupDetail,
        ...cleanupErrors.map(detail => `${copy.startupCleanupFailed}: ${detail}`)].join("\n"),
      buttons: [copy.retry, copy.quit],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (result.response === 0) {
      // Internal child commands use the resolved profile. A fresh launcher must instead
      // resolve the original launch environment, especially for the isolated DEV profile.
      for (const [key, value] of Object.entries(launchEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      app.relaunch({ args: process.argv.slice(1).filter(argument => argument !== "--hidden") });
    }
  } finally {
    // A failed dialog or relaunch must not leave a headless single-instance owner behind.
    app.exit(1);
  }
});
