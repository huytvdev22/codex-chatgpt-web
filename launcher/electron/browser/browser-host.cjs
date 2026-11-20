const fs = require("node:fs");
const { randomBytes } = require("node:crypto");
const { WebContentsView, shell } = require("electron");
const { writePrivateFileAtomic } = require("../infra/atomic-file.cjs");
const { PrimaryViewManager } = require("./primary-view-manager.cjs");
const { BrowserProviderRegistry } = require("./providers/browser-provider-registry.cjs");
const {
  M365_ORIGIN,
  M365_PARTITION,
  M365BrowserProvider,
  allowedM365AuthUrl,
} = require("./providers/m365/m365-browser-provider.cjs");
const {
  AiStudioBrowserProvider,
} = require("./providers/ai-studio/ai-studio-browser-provider.cjs");
const {
  BrowserTurnCancelledError,
  IDLE_BROWSER_URL,
  MAX_BROWSER_TABS,
  TurnTabManager,
  hasProviderOnHost,
  loadCommittedBrowserSurface,
  resolveProviderFromHost,
} = require("./turn-tab-manager.cjs");
const {
  browserViewVisible,
  constrainBrowserBounds,
  navigateBrowser,
  readBrowserNavigationState,
  scaleBrowserBounds,
  shellZoomActionForInput,
} = require("./browser-state.cjs");

const MAX_BROWSER_VIEW_DIMENSION = 16_384;
const BROWSER_NAVIGATION_TIMEOUT_MS = 60_000;
const WINDOW_VISIBILITY_EVENTS = ["show", "hide", "minimize", "restore"];
const ZOOM_FACTORS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const SHELL_ZOOM_LEVEL_STEP = 0.5;
const SHELL_ZOOM_LEVEL_LIMIT = 5;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function normalizeBounds(bounds) {
  const read = (value) => Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return {
    x: Math.min(MAX_BROWSER_VIEW_DIMENSION, read(bounds?.x)),
    y: Math.min(MAX_BROWSER_VIEW_DIMENSION, read(bounds?.y)),
    width: Math.min(MAX_BROWSER_VIEW_DIMENSION, Math.max(1, read(bounds?.width))),
    height: Math.min(MAX_BROWSER_VIEW_DIMENSION, Math.max(1, read(bounds?.height))),
  };
}

function navigationOriginForLog(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : parsed.protocol;
  } catch {
    return "invalid-url";
  }
}

function navigationErrorForLog(error) {
  if (!error || typeof error !== "object") return { errorType: typeof error };
  const detail = {
    errorType: typeof error.name === "string" && error.name ? error.name : "Error",
  };
  if (typeof error.code === "string" || typeof error.code === "number") {
    detail.errorCode = error.code;
  }
  return detail;
}

function createDefaultProviderRegistry({ descriptorPath = null, profile = "production" } = {}) {
  const registry = new BrowserProviderRegistry();
  registry.register(new M365BrowserProvider({
    descriptorPath,
    partition: profile === "development" ? "persist:codex-web-gpt-dev-m365" : undefined,
  }));
  registry.register(new AiStudioBrowserProvider({
    descriptorPath,
    partition: profile === "development" ? "persist:codex-web-gpt-dev-ai-studio" : undefined,
  }));
  return registry;
}

function turnManagerFor(host) {
  return host.turnTabManager || new TurnTabManager(host, { standalone: true });
}

function surfaceIdForHost(host, providerId) {
  const id = providerId || host.provider || "m365";
  if (!host.surfaceIds) return host.surfaceId;
  if (!host.surfaceIds.has(id)) {
    host.surfaceIds.set(id, randomBytes(24).toString("base64url"));
  }
  return host.surfaceIds.get(id);
}

/**
 * Facade điều phối cửa sổ trình duyệt nhúng: gắn kết PrimaryViewManager,
 * TurnTabManager và BrowserProviderRegistry thông qua giao diện đa hình.
 */
class BrowserHost {
  constructor({
    window,
    descriptorPath,
    cdpPort,
    control,
    cancelTurn,
    getConnectorName,
    helper,
    logger,
    partition = M365_PARTITION,
    profile = "production",
    publishState,
    showWindow = () => {},
    getUseSavedChats = () => false,
    provider = null,
    providerRegistry = null,
  }) {
    this.window = window;
    this.descriptorPath = descriptorPath;
    this.cdpPort = cdpPort;
    this.control = control;
    this.cancelTurn = cancelTurn;
    this.getConnectorName = getConnectorName;
    this.helper = helper;
    this.logger = logger;
    if (profile !== "production" && profile !== "development") {
      throw new Error("Browser host profile is invalid");
    }
    this.providerRegistry = providerRegistry || createDefaultProviderRegistry({ descriptorPath, profile });
    const requestedProvider = provider || this.providerRegistry.defaultId();
    const activeProvider = resolveProviderFromHost(this, requestedProvider);

    const allowedPartitions = new Set([
      "persist:codex-web-m365",
      activeProvider.partition,
    ]);
    if (!allowedPartitions.has(partition)) {
      this.logger?.warn?.("browser.unexpected_partition", { partition });
    }
    this.provider = activeProvider.id;
    this.partition = activeProvider.partition;
    this.profile = profile;
    this.publishState = publishState;
    this.showWindow = showWindow;
    this.getUseSavedChats = getUseSavedChats;

    this.surfaceIds = new Map();
    const initialSurfaceId = randomBytes(24).toString("base64url");
    this.surfaceIds.set(this.provider, initialSurfaceId);
    this.surfaceId = initialSurfaceId;
    this.authenticatedByProvider = {};
    for (const registeredProvider of this.providerRegistry.list()) {
      this.authenticatedByProvider[registeredProvider.id] = false;
    }
    this.providerViews = new Map();

    this.visible = false;
    this.surfaceActive = true;
    this.turnTabs = new Map();
    this.closedTurnOwners = new Map();
    this.userCancelledTurnOwners = new Map();
    this.selectedTabId = "home";
    this.homeSurfaceOpen = false;
    this.manualOperation = null;
    this.loginOperation = null;
    this.sessionRefreshOperation = null;
    this.authenticationRevision = 0;
    this.reauthenticationRequired = false;
    this.primaryRendererReady = false;
    this.primaryDeviceEmulationViewport = null;
    this.primaryDeviceEmulationDirty = true;
    this.shellZoomShortcutBindings = new Map();
    this.authView = null;
    this.authNavigationError = null;
    this.homeNavigationTimeout = null;
    this.lastTurnSweepAt = Date.now();
    this.powerSaveBlockerId = null;
    this.boundsReady = false;
    this.bounds = { x: 0, y: 0, width: 1, height: 1 };
    this.state = {
      status: "idle",
      message: "No active task",
      url: "about:blank",
      title: activeProvider.getFallbackTitle(),
      authenticated: false,
      visible: false,
      surfaceActive: true,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      zoomFactor: 1,
      provider: this.provider,
    };

    this.turnTabManager = new TurnTabManager(this);
    this.primaryViewManager = new PrimaryViewManager({
      window,
      logger: this.logger,
      createView: (providerId) => {
        const providerObj = resolveProviderFromHost(this, providerId);
        return new WebContentsView({
          webPreferences: {
            partition: providerObj.partition,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: true,
            backgroundThrottling: true,
          },
        });
      },
      onCreate: (providerName, view) => {
        this.providerViews?.set(providerName, view);
        const providerObj = resolveProviderFromHost(this, providerName);
        if (view?.webContents?.session) {
          providerObj.onPrimarySessionCreated(view.webContents.session, this);
        }
      },
    });

    this.view = this.primaryViewManager.ensure(this.provider);

    this.windowVisibilityListener = () => this.syncViewVisibility();
    for (const event of WINDOW_VISIBILITY_EVENTS) {
      this.window.on(event, this.windowVisibilityListener);
    }
    this.view.webContents.setZoomFactor(this.state.zoomFactor);
    this.bindShellZoomShortcuts(this.window.webContents);
    this.bindShellZoomShortcuts(this.view.webContents);
    this.bindAuthenticationChanges();
    this.bindWebContents();
    this.initializationReady = this.initializePrimaryView().catch((error) => {
      this.logger.error("browser.initialization_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      this.setState({ status: "error", message: "Embedded browser failed to initialize" });
      throw error;
    });
  }

  _hasProvider(providerId) {
    return hasProviderOnHost(this, providerId);
  }

  _resolveProvider(providerId = this.provider || "m365") {
    return resolveProviderFromHost(this, providerId);
  }

  _turns() {
    return this.turnTabManager || new TurnTabManager(this, { standalone: true });
  }

  _surfaceIdFor(providerId) {
    return surfaceIdForHost(this, providerId);
  }

  getHomeUrl() {
    return resolveProviderFromHost(this).homeUrl;
  }

  listProviders() {
    const list = this.providerRegistry ? this.providerRegistry.list() : [];
    return list.map((providerObj) => ({
      id: providerObj.id,
      displayName: providerObj.displayName,
      homeUrl: providerObj.homeUrl,
      partition: providerObj.partition,
      active: providerObj.id === this.provider,
      authenticated: Boolean(this.authenticatedByProvider?.[providerObj.id]),
    }));
  }

  releaseInactivePrimaryViews(activeProvider) {
    if (!this.primaryViewManager) return;
    const candidates = new Set([
      ...(this.providerRegistry ? this.providerRegistry.listIds() : []),
      ...(this.providerViews ? this.providerViews.keys() : []),
    ]);
    for (const providerId of candidates) {
      if (providerId === activeProvider) continue;
      const hasManagedView = typeof this.primaryViewManager.has === "function"
        ? this.primaryViewManager.has(providerId)
        : Boolean(this.providerViews?.has(providerId));
      if (!hasManagedView) continue;
      const view = typeof this.primaryViewManager.get === "function"
        ? this.primaryViewManager.get(providerId)
        : (this.providerViews?.get(providerId) || null);
      const contents = view?.webContents;
      if (contents && this.shellZoomShortcutBindings) {
        const binding = this.shellZoomShortcutBindings.get(contents);
        if (binding && !contents.isDestroyed()) {
          contents.off("before-input-event", binding);
        }
        this.shellZoomShortcutBindings.delete(contents);
      }
      this.primaryViewManager.destroy(providerId);
      this.providerViews?.delete(providerId);
    }
  }

  async switchProvider(providerId) {
    if (!hasProviderOnHost(this, providerId)) return this.snapshot();
    const providerObj = resolveProviderFromHost(this, providerId);
    this.provider = providerObj.id;
    const viewExisted = this.primaryViewManager.has(providerObj.id);
    this.view = this.primaryViewManager.ensure(providerObj.id);
    if (!viewExisted) {
      this.view.webContents.setZoomFactor(this.state.zoomFactor);
      this.bindShellZoomShortcuts(this.view.webContents);
      this.bindWebContents(this.view, providerObj.id);
      this.bindAuthenticationChanges();
    }
    this.surfaceId = surfaceIdForHost(this, providerObj.id);
    this.partition = providerObj.partition;
    const cachedAuth = Boolean(this.authenticatedByProvider?.[providerObj.id]);
    this.setState({
      provider: providerObj.id,
      title: providerObj.getFallbackTitle(),
      authenticated: cachedAuth,
    });

    this.releaseInactivePrimaryViews(providerObj.id);
    this.primaryViewManager.activate(
      providerObj.id,
      this.boundsReady ? this.bounds : this.hiddenTurnBounds(),
    );

    const currentUrl = this.view.webContents.getURL() || "";
    if (!providerObj.isAuthOrAppUrl(currentUrl)) {
      try {
        await this.view.webContents.loadURL(providerObj.homeUrl);
      } catch (err) {
        this.logger.error("browser.switch_provider_load_failed", {
          provider: providerObj.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.syncViewVisibility();
    await this.probeAuthentication();
    this.writeDescriptor();
    const snap = this.snapshot();
    this.publishState?.(snap);
    return snap;
  }

  async ready() {
    await this.initializationReady;
  }

  async markOwnedSurfaceFor(contents, surfaceId) {
    if (!contents || contents.isDestroyed()) return;
    const sid = JSON.stringify(surfaceId);
    await contents.executeJavaScript(`(() => {
      Object.defineProperty(globalThis, "__CODEX_WEB_GPT_SURFACE_ID__", {
        value: ${sid},
        configurable: true,
        enumerable: false,
        writable: false,
      });
      document.documentElement.dataset.codexWebGptSurface = ${sid};
    })()`, true).catch(() => {});
  }

  async initializePrimaryView() {
    if (this.view) {
      this.view.setBounds(this.hiddenTurnBounds());
      this.view.setVisible(true);
      await loadCommittedBrowserSurface(this.view.webContents, IDLE_BROWSER_URL);
      await this.markOwnedSurface();
    }
    this.syncViewVisibility();
    this.writeDescriptor();
    this.logger.info("browser.initialized", { url: this.view?.webContents?.getURL?.() });
  }

  currentOperation() {
    const providerName = resolveProviderFromHost(this).displayName;
    return this.manualOperation || (this.loginOperation ? `${providerName} login` : null);
  }

  get activeTraceId() {
    return [...this.turnTabs.values()].find((tab) => tab.status === "running")?.traceId || null;
  }

  tabSnapshot(tab) {
    return turnManagerFor(this).tabSnapshot(tab);
  }

  selectedTurnTab() {
    return turnManagerFor(this).selectedTurnTab();
  }

  async createTurnTab(traceId, helperPid, conversationKey, connectorIdentity, signal, provider = "m365", initialUrl = null) {
    return turnManagerFor(this).createTurnTab(traceId, helperPid, conversationKey, connectorIdentity, signal, provider, initialUrl);
  }

  async initializeTurnTab(tab, signal) {
    return turnManagerFor(this).initializeTurnTab(tab, signal);
  }

  evictOldestRetainedTurnTab() {
    return turnManagerFor(this).evictOldestRetainedTurnTab();
  }

  evictOldestReclaimableTurnTab() {
    return turnManagerFor(this).evictOldestReclaimableTurnTab();
  }

  zoomShell(action) {
    const contents = this.window.webContents;
    if (!contents || contents.isDestroyed()) throw new Error("Launcher shell is unavailable for zoom");
    const current = contents.getZoomLevel();
    if (!Number.isFinite(current)) throw new Error("Launcher shell zoom state is invalid");
    const next = action === "reset"
      ? 0
      : action === "in"
        ? Math.min(SHELL_ZOOM_LEVEL_LIMIT, current + SHELL_ZOOM_LEVEL_STEP)
        : Math.max(-SHELL_ZOOM_LEVEL_LIMIT, current - SHELL_ZOOM_LEVEL_STEP);
    contents.setZoomLevel(next);
  }

  bindShellZoomShortcuts(contents) {
    if (!contents || contents.isDestroyed() || this.shellZoomShortcutBindings.has(contents)) return;
    const handler = (event, input) => {
      const action = shellZoomActionForInput(input);
      if (!action) return;
      event.preventDefault();
      try {
        this.zoomShell(action);
      } catch (error) {
        this.logger.error("launcher.shell_zoom_shortcut_failed", {
          action,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    this.shellZoomShortcutBindings.set(contents, handler);
    contents.on("before-input-event", handler);
    contents.once("destroyed", () => this.shellZoomShortcutBindings.delete(contents));
  }

  bindWebContents(singleView = null, singleProvider = null) {
    const bindFor = (targetView, providerName) => {
      if (!targetView?.webContents) return;
      const contents = targetView.webContents;
      const providerObj = resolveProviderFromHost(this, providerName);
      const isTargetActive = () => this.provider === providerName && this.view === targetView;
      const surfaceId = surfaceIdForHost(this, providerName);
      providerObj.onPrimaryContentsBound(contents, this);

      contents.setWindowOpenHandler(({ url }) => {
        if (providerObj.allowedAuthUrl(url)) {
          return {
            action: "allow",
            createWindow: (options) => this.createAuthView(options, url),
          };
        }
        let parsed;
        try { parsed = new URL(url); } catch { return { action: "deny" }; }
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          void shell.openExternal(parsed.toString()).catch((error) => {
            const message = `Could not open the external link: ${error instanceof Error ? error.message : String(error)}`;
            this.logger.error("browser.external_url_open_failed", { url: parsed.toString(), message });
            if (isTargetActive()) this.setState({ status: "error", message, loading: false });
          });
        } else {
          this.logger.warn("browser.external_url_rejected", { protocol: parsed.protocol });
        }
        return { action: "deny" };
      });
      contents.on("did-start-navigation", (_event, url, inPlace, mainFrame) => {
        if (!mainFrame || !isTargetActive()) return;
        if (inPlace) {
          this.setState({ url });
          return;
        }
        if (url === IDLE_BROWSER_URL || url === "about:blank") {
          this.clearHomeNavigationTimeout();
          this.setState({ url, loading: false });
          return;
        }
        this.primaryRendererReady = false;
        this.primaryDeviceEmulationDirty = true;
        this.armHomeNavigationTimeout(contents, url);
        this.setState(this.activeTraceId || this.manualOperation
          ? { url, loading: true }
          : { status: "loading", message: `Opening ${providerObj.displayName}`, url, loading: true });
      });
      contents.on("did-finish-load", () => {
        this.clearHomeNavigationTimeout();
        const isActive = isTargetActive();
        if (isActive) {
          this.primaryRendererReady = true;
          this.syncViewVisibility();
        }
        const url = contents.getURL();
        if (isActive) {
          if (this.state?.status === "loading" && !this.activeTraceId && !this.manualOperation) {
            const isAuth = Boolean(this.authenticatedByProvider?.[providerName]);
            this.setState({
              status: isAuth ? "ready" : "signed-out",
              message: isAuth ? `${providerObj.displayName} is ready` : `Sign in to ${providerObj.displayName}`,
              url,
              loading: false,
            });
          } else {
            this.setState({ url, loading: false });
          }
        }
        void this.markOwnedSurfaceFor(contents, surfaceId)
          .then(() => {
            if (this.provider === providerName) {
              return this.probeAuthentication();
            }
          })
          .catch((error) => {
            this.logger.error("browser.surface_mark_failed", {
              message: error instanceof Error ? error.message : String(error),
            });
            if (isActive) {
              this.setState({ status: "error", message: "Embedded browser ownership could not be established" });
            }
          });
      });
      contents.on("did-start-loading", () => {
        if (isTargetActive()) this.setState({ loading: true });
      });
      contents.on("did-stop-loading", () => {
        this.clearHomeNavigationTimeout();
        if (isTargetActive()) this.setState({ loading: false });
      });
      contents.on("page-title-updated", (_event, title) => {
        if (!isTargetActive()) return;
        this.setState({ title: typeof title === "string" && title.trim() ? title.trim() : providerObj.getFallbackTitle() });
      });
      contents.on("did-navigate-in-page", (_event, url, mainFrame) => {
        if (mainFrame) {
          if (isTargetActive()) this.setState({ url });
          void this.refreshAuthenticationFromSession();
        }
      });
      contents.on("did-fail-load", (_event, errorCode, errorDescription, url, mainFrame) => {
        if (!mainFrame || errorCode === -3) return;
        this.clearHomeNavigationTimeout();
        this.logger.error("browser.navigation_failed", {
          errorCode,
          errorDescription,
          origin: navigationOriginForLog(url),
        });
        if (isTargetActive()) {
          this.setState({ status: "error", message: errorDescription, url, loading: false });
        }
      });
      contents.on("render-process-gone", (_event, details) => {
        this.clearHomeNavigationTimeout();
        this.logger.error("browser.renderer_gone", { reason: details.reason, exitCode: details.exitCode });
        if (isTargetActive()) {
          this.setState({ status: "error", message: `Browser renderer stopped: ${details.reason}`, loading: false });
        }
      });
    };

    if (singleView && singleProvider) {
      bindFor(singleView, singleProvider);
    } else if (this.view) {
      bindFor(this.view, this.provider || "m365");
    }
  }

  armHomeNavigationTimeout(contents, url) {
    this.clearHomeNavigationTimeout();
    const providerLabel = resolveProviderFromHost(this).displayName;
    this.homeNavigationTimeout = setTimeout(() => {
      this.homeNavigationTimeout = null;
      if (contents.isDestroyed() || !contents.isLoadingMainFrame()) return;
      contents.stop();
      const message = `${providerLabel} did not finish loading within 60 seconds. Check your connection and retry.`;
      this.logger.error("browser.navigation_timeout", { origin: navigationOriginForLog(url) });
      this.setState({ status: "error", message, url, loading: false });
    }, BROWSER_NAVIGATION_TIMEOUT_MS);
    this.homeNavigationTimeout.unref?.();
  }

  clearHomeNavigationTimeout() {
    if (!this.homeNavigationTimeout) return;
    clearTimeout(this.homeNavigationTimeout);
    this.homeNavigationTimeout = null;
  }

  bindAuthenticationChanges() {
    this.authenticationCookieBindings ||= new Map();
    const listener = (_event, cookie, cause, removed) => {
      if (removed && (cause === "overwrite" || cause === "expired-overwrite")) return;
      if (!removed && this.authenticationRefresh) return;
      const providers = this.providerRegistry
        ? this.providerRegistry.list()
        : [resolveProviderFromHost(this, "m365")];
      const isTargetDomain = providers.some(provider => provider.isAuthCookieDomain(cookie.domain));
      if (cookie.httpOnly && isTargetDomain) {
        void this.refreshAuthenticationFromSession();
      }
    };
    const sessions = new Set();
    if (this.view?.webContents?.session?.cookies) sessions.add(this.view.webContents.session.cookies);
    if (this.providerViews) {
      for (const view of this.providerViews.values()) {
        if (view?.webContents?.session?.cookies) sessions.add(view.webContents.session.cookies);
      }
    }
    for (const sessionCookies of sessions) {
      if (this.authenticationCookieBindings.has(sessionCookies)) continue;
      sessionCookies.on("changed", listener);
      this.authenticationCookieBindings.set(sessionCookies, listener);
    }
    this.authenticationCookieListener = listener;
  }

  refreshAuthenticationFromSession() {
    if (this.destroyed || this.reauthenticationRequired) return Promise.resolve();
    this.authenticationRevision = (this.authenticationRevision ?? 0) + 1;
    if (this.authenticationRefresh) return this.authenticationRefresh;
    const providerLabel = resolveProviderFromHost(this).displayName;
    const operation = (async () => {
      let revision;
      do {
        revision = this.authenticationRevision;
        const contents = this.view?.webContents;
        if (!contents || contents.isDestroyed()) return;
        if (this.authenticationProbe) await this.authenticationProbe;
        if (this.destroyed || this.reauthenticationRequired) return;
        if (revision !== this.authenticationRevision) continue;
        await this.probeAuthentication();
      } while (revision !== this.authenticationRevision);
    })();
    const tracked = operation.catch(() => {
      if (!this.destroyed && !this.reauthenticationRequired) {
        this.logger.warn("browser.session_refresh_failed");
        this.setState({
          authenticated: false,
          ...(this.activeTraceId || this.manualOperation
            ? {}
            : { status: "error", message: `Could not check the ${providerLabel} session. Retry the session check.` }),
        });
      }
    }).finally(() => {
      if (this.authenticationRefresh === tracked) this.authenticationRefresh = null;
    });
    this.authenticationRefresh = tracked;
    return tracked;
  }

  snapshot() {
    const contents = this.activeView()?.webContents;
    const selected = this.selectedTurnTab();
    const providerObj = resolveProviderFromHost(this);
    const defaultTitle = providerObj.getFallbackTitle();
    const homeTab = {
      id: "home",
      traceId: null,
      title: this.state.title || defaultTitle,
      status: this.state.status,
      loading: this.state.loading === true,
      active: this.selectedTabId === "home",
      closable: Boolean(this.primaryViewManager),
    };
    const includeHomeTab = this.primaryViewManager
      ? Boolean(
          this.homeSurfaceOpen
          || this.authView
          || this.loginOperation
          || (this.manualOperation && this.manualOperation !== "session refresh")
        )
      : (this.turnTabs.size === 0
          || this.selectedTabId === "home"
          || Boolean(this.authView || this.loginOperation || this.manualOperation || this.reauthenticationRequired));
    const effectiveVisible = this.primaryViewManager
      ? (this.visible && (this.turnTabs.size > 0 || includeHomeTab))
      : this.visible;
    const state = selected
      ? {
          ...this.state,
          status: selected.authenticationRequired ? "signed-out" : selected.status,
          message: selected.message,
          url: selected.url,
          title: selected.pageTitle,
          loading: selected.loading,
        }
      : this.state;
    return {
      ...readBrowserNavigationState(contents, {
        ...state,
        visible: effectiveVisible,
        surfaceActive: this.surfaceActive,
      }),
      activeTabId: this.selectedTabId,
      provider: this.provider,
      providers: typeof this.listProviders === "function" ? this.listProviders() : [],
      authenticatedByProvider: { ...(this.authenticatedByProvider || {}) },
      tabs: includeHomeTab
        ? (this.turnTabs.size > 0
            ? [
                homeTab,
                ...[...this.turnTabs.values()].map((tab) => this.tabSnapshot(tab)),
              ]
            : [homeTab])
        : [...this.turnTabs.values()].map((tab) => this.tabSnapshot(tab)),
      maxTabs: MAX_BROWSER_TABS,
    };
  }

  setState(patch) {
    this.state = {
      ...this.state,
      ...patch,
      visible: this.visible,
      surfaceActive: this.surfaceActive,
    };
    this.publishState?.(this.snapshot());
  }

  heartbeatTurn(traceId, helperPid, refreshViewport = false) {
    return turnManagerFor(this).heartbeatTurn(traceId, helperPid, refreshViewport);
  }

  refreshTurnLeases(reason, now = Date.now()) {
    return turnManagerFor(this).refreshTurnLeases(reason, now);
  }

  syncPowerSaveBlocker() {
    return turnManagerFor(this).syncPowerSaveBlocker();
  }

  reapExpiredTurnTabs(now = Date.now()) {
    return turnManagerFor(this).reapExpiredTurnTabs(now);
  }

  setBounds(bounds, rendererZoomFactor = 1) {
    const [width, height] = this.window.getContentSize();
    this.bounds = constrainBrowserBounds(
      normalizeBounds(scaleBrowserBounds(bounds, rendererZoomFactor)),
      { width, height },
    );
    this.boundsReady = true;
    this.authView?.setBounds(this.bounds);
    this.syncViewVisibility();
    void this.view?.webContents?.executeJavaScript("window.dispatchEvent(new Event('resize'))", true).catch(() => {});
    if (this.authView && !this.authView.webContents.isDestroyed()) {
      void this.authView.webContents.executeJavaScript("window.dispatchEvent(new Event('resize'))", true).catch(() => {});
    }
  }

  activeView() {
    return this.authView || this.selectedTurnTab()?.view || this.view;
  }

  hiddenTurnBounds() {
    const [contentWidth, contentHeight] = this.window.getContentSize();
    const width = Math.max(1024, Math.round(contentWidth || 0));
    const height = Math.max(720, Math.round(contentHeight || 0));
    return {
      x: Math.max(width, Math.round(contentWidth || 0)) + 1,
      y: Math.max(height, Math.round(contentHeight || 0)) + 1,
      width,
      height,
    };
  }

  enableHiddenTurnViewport(contents, { width, height }) {
    contents.enableDeviceEmulation({
      screenPosition: "desktop",
      screenSize: { width, height },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize: { width, height },
      scale: 1,
    });
  }

  presentTurnView(tab, visible) {
    return turnManagerFor(this).presentTurnView(tab, visible);
  }

  parkIdlePrimaryView() {
    if (this.homeSurfaceOpen
      || (this.manualOperation && this.manualOperation !== "session refresh")
      || this.loginOperation
      || this.authView) {
      return;
    }
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed?.()) return;
    contents.setBackgroundThrottling?.(true);
    const currentUrl = typeof contents.getURL === "function" ? contents.getURL() : "";
    if (currentUrl && currentUrl !== IDLE_BROWSER_URL && currentUrl !== "about:blank") {
      void contents.loadURL?.(IDLE_BROWSER_URL)?.catch?.(() => {});
    }
  }

  presentPrimaryView(visible) {
    const bounds = visible ? this.bounds : this.hiddenTurnBounds();
    if (this.primaryViewManager) {
      this.primaryViewManager.attach(this.provider);
    }
    if (this.primaryViewManager
      && !this.homeSurfaceOpen
      && (!this.manualOperation || this.manualOperation === "session refresh")
      && !this.loginOperation
      && !this.authView) {
      if (this.primaryRendererReady && this.primaryDeviceEmulationViewport) {
        this.view.webContents?.disableDeviceEmulation?.();
        this.primaryDeviceEmulationViewport = null;
        this.primaryDeviceEmulationDirty = true;
      }
      this.view.setBounds(this.hiddenTurnBounds());
      this.view.setVisible(false);
      return;
    }
    if (visible) {
      this.view.setBounds(bounds);
      if (this.primaryRendererReady && this.primaryDeviceEmulationViewport) {
        this.view.webContents.disableDeviceEmulation();
        this.primaryDeviceEmulationViewport = null;
      }
      if (this.primaryRendererReady) this.primaryDeviceEmulationDirty = false;
    } else {
      if (this.primaryRendererReady
        && (this.primaryDeviceEmulationDirty
          || this.primaryDeviceEmulationViewport?.width !== bounds.width
          || this.primaryDeviceEmulationViewport?.height !== bounds.height)) {
        this.enableHiddenTurnViewport(this.view.webContents, bounds);
        this.primaryDeviceEmulationViewport = { width: bounds.width, height: bounds.height };
        this.primaryDeviceEmulationDirty = false;
      }
      this.view.setBounds(bounds);
    }
    this.view.setVisible(true);
  }

  activateHomeSurface() {
    this.selectedTabId = "home";
    this.syncViewVisibility();
    if (this.visible && this.surfaceActive) this.activeView().webContents.focus();
    this.publishState?.(this.snapshot());
    this.writeDescriptor();
  }

  syncViewVisibility() {
    const windowVisible = this.window.isVisible() && !this.window.isMinimized();
    const visible = windowVisible
      && browserViewVisible(this.visible, this.surfaceActive, this.boundsReady);
    const selected = this.selectedTurnTab();
    this.presentPrimaryView(visible && !this.authView && !selected);
    for (const tab of this.turnTabs.values()) {
      const tabVisible = visible && !this.authView && selected?.id === tab.id;
      this.presentTurnView(tab, tabVisible);
    }
    this.authView?.setVisible(visible);
  }

  selectTab(tabId) {
    if (tabId !== "home" && !this.turnTabs.has(tabId)) throw new Error("Browser tab does not exist");
    if (this.authView) this.closeAuthView(this.authView, true);
    this.selectedTabId = tabId;
    this.syncViewVisibility();
    if (this.visible && this.surfaceActive) this.activeView().webContents.focus();
    this.publishState?.(this.snapshot());
    this.writeDescriptor();
    return this.snapshot();
  }

  removeTurnTab(tab, abortRunning) {
    return turnManagerFor(this).removeTurnTab(tab, abortRunning);
  }

  rememberUserCancelledTurn(traceId, helperPid) {
    return turnManagerFor(this).rememberUserCancelledTurn(traceId, helperPid);
  }

  async closeTab(tabId) {
    return turnManagerFor(this).closeTab(tabId);
  }

  createAuthView(options = {}, requestedUrl = "") {
    this.closeAuthView(this.authView, true);
    const providerObj = resolveProviderFromHost(this);
    const authView = new WebContentsView({ webContents: options.webContents });
    this.authView = authView;
    this.authNavigationError = null;
    this.window.contentView.addChildView(authView);
    authView.setBounds(this.bounds);
    authView.setVisible(false);
    authView.webContents.setZoomFactor(this.state.zoomFactor);
    this.bindShellZoomShortcuts(authView.webContents);
    const contents = authView.webContents;
    const clearNavigationTimeout = () => {
      if (!authView.navigationTimeout) return;
      clearTimeout(authView.navigationTimeout);
      authView.navigationTimeout = null;
    };
    const armNavigationTimeout = (url) => {
      clearNavigationTimeout();
      authView.navigationTimeout = setTimeout(() => {
        authView.navigationTimeout = null;
        if (this.authView !== authView || contents.isDestroyed()) return;
        contents.stop();
        const message = "The sign-in page did not finish loading within 60 seconds. Check your connection and try again.";
        this.authNavigationError = new Error(message);
        this.logger.error("browser.auth_navigation_timeout", {
          surface: "popup",
          origin: navigationOriginForLog(url),
        });
        this.closeAuthView(authView, true, false);
        this.setState({ status: "error", message, url, loading: false });
      }, BROWSER_NAVIGATION_TIMEOUT_MS);
      authView.navigationTimeout.unref?.();
    };
    armNavigationTimeout(requestedUrl);
    this.setState({
      status: "loading",
      message: "Opening sign-in",
      url: requestedUrl || contents.getURL(),
      loading: true,
    });
    contents.on("did-start-navigation", (_event, url, _inPlace, mainFrame) => {
      if (!mainFrame) return;
      armNavigationTimeout(url);
      this.logger.info("browser.auth_navigation_started", {
        surface: "popup",
        origin: navigationOriginForLog(url),
      });
    });
    contents.on("did-start-loading", () => this.setState({ loading: true }));
    contents.on("did-stop-loading", () => {
      clearNavigationTimeout();
      this.setState({ loading: false });
    });
    contents.on("did-finish-load", () => {
      clearNavigationTimeout();
      this.logger.info("browser.auth_navigation_completed", {
        surface: "popup",
        origin: navigationOriginForLog(contents.getURL()),
      });
      this.setState({ url: contents.getURL(), loading: false });
      void this.probeAuthentication();
    });
    contents.on("page-title-updated", (_event, title) => {
      this.setState({ title: typeof title === "string" && title.trim() ? title.trim() : providerObj.getFallbackTitle() });
    });
    contents.on("close", () => this.closeAuthView(authView, true));
    contents.on("destroyed", () => this.closeAuthView(authView, false));
    contents.on("did-fail-load", (_event, errorCode, errorDescription, url, mainFrame) => {
      if (!mainFrame || errorCode === -3) return;
      clearNavigationTimeout();
      const message = `Sign-in page failed to load: ${errorDescription}`;
      this.authNavigationError = new Error(message);
      this.logger.error("browser.auth_navigation_failed", {
        surface: "popup",
        errorCode,
        errorDescription,
        origin: navigationOriginForLog(url),
      });
      this.closeAuthView(authView, true, false);
      this.setState({ status: "error", message, url, loading: false });
    });
    contents.on("render-process-gone", (_event, details) => {
      clearNavigationTimeout();
      const message = `Sign-in renderer stopped: ${details.reason}`;
      this.authNavigationError = new Error(message);
      this.logger.error("browser.auth_renderer_gone", { reason: details.reason, exitCode: details.exitCode });
      this.closeAuthView(authView, false);
      this.setState({ status: "error", message, loading: false });
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (providerObj.allowedAuthUrl(url)) {
        armNavigationTimeout(url);
        void contents.loadURL(url).catch((error) => {
          if (error && typeof error === "object" && error.code === "ERR_ABORTED") return;
          if (this.authView !== authView || contents.isDestroyed()) return;
          clearNavigationTimeout();
          const message = `Sign-in page failed to open: ${error instanceof Error ? error.message : String(error)}`;
          this.authNavigationError = new Error(message);
          this.logger.error("browser.auth_window_open_failed", {
            surface: "popup",
            origin: navigationOriginForLog(url),
            ...navigationErrorForLog(error),
          });
          this.closeAuthView(authView, true, false);
          this.setState({ status: "error", message, url, loading: false });
        });
      } else {
        let parsed;
        try { parsed = new URL(url); } catch { return { action: "deny" }; }
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          void shell.openExternal(parsed.toString()).catch((error) => {
            const message = `Could not open the external link: ${error instanceof Error ? error.message : String(error)}`;
            this.logger.error("browser.external_url_open_failed", { url: parsed.toString(), message });
            this.setState({ status: "error", message, loading: false });
          });
        }
      }
      return { action: "deny" };
    });
    this.syncViewVisibility();
    this.logger.info("browser.auth_surface_opened");
    return contents;
  }

  closeAuthView(authView, closeContents) {
    if (!authView || this.authView !== authView) return;
    if (authView.navigationTimeout) {
      clearTimeout(authView.navigationTimeout);
      authView.navigationTimeout = null;
    }
    this.authView = null;
    try { this.window.contentView.removeChildView(authView); } catch {}
    if (closeContents && !authView.webContents.isDestroyed()) authView.webContents.close();
    this.syncViewVisibility();
    this.logger.info("browser.auth_surface_closed");
  }

  async markOwnedSurface() {
    await this.markOwnedSurfaceFor(this.view.webContents, this.surfaceId);
  }

  show() {
    this.visible = true;
    this.syncViewVisibility();
    this.setState({ visible: true });
    if (this.surfaceActive && this.boundsReady) this.activeView().webContents.focus();
  }

  async reveal(inspectSession = true) {
    const providerObj = resolveProviderFromHost(this);
    if (!this.selectedTurnTab()) {
      this.homeSurfaceOpen = true;
    }
    this.show();
    const currentUrl = this.view.webContents.getURL() || "";
    if (!this.selectedTurnTab()) {
      if (!providerObj.isAuthOrAppUrl(currentUrl) || currentUrl === IDLE_BROWSER_URL || currentUrl === "about:blank") {
        await this.view.webContents.loadURL(providerObj.homeUrl);
        if (inspectSession) await this.probeAuthentication();
      }
    }
    return this.snapshot();
  }

  hide() {
    this.homeSurfaceOpen = false;
    this.visible = false;
    this.syncViewVisibility();
    this.setState({ visible: false });
  }

  setSurfaceActive(active) {
    this.surfaceActive = active === true;
    this.syncViewVisibility();
    this.setState({ surfaceActive: this.surfaceActive });
    return this.snapshot();
  }

  async waitForSurfaceReady(timeoutMs = 15_000, pollMs = 50) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.surfaceActive && this.boundsReady) return;
      await sleep(pollMs);
    }
    throw new Error(
      "Embedded browser surface did not receive measured bounds before the operation",
    );
  }

  navigate(action) {
    const providerLabel = resolveProviderFromHost(this).displayName;
    if (this.activeTraceId) {
      throw new Error(`Browser navigation is locked while ${providerLabel} is running a Codex turn`);
    }
    if (this.manualOperation) {
      throw new Error(`Browser navigation is locked during ${this.manualOperation}`);
    }
    const contents = this.activeView().webContents;
    navigateBrowser(contents, action);
    return this.snapshot();
  }

  openDevTools() {
    const contents = this.activeView()?.webContents;
    if (!contents || contents.isDestroyed()) {
      throw new Error("The active browser surface is unavailable for DevTools");
    }
    contents.openDevTools({ mode: "detach", activate: true });
    return true;
  }

  zoom(action) {
    if (action !== "in" && action !== "out" && action !== "reset") {
      throw new Error(`Unknown browser zoom action: ${action}`);
    }
    const current = this.state.zoomFactor;
    const currentIndex = ZOOM_FACTORS.indexOf(current);
    if (currentIndex < 0) throw new Error(`Browser zoom state is invalid: ${current}`);
    const next = action === "reset"
      ? 1
      : action === "in"
        ? ZOOM_FACTORS[Math.min(currentIndex + 1, ZOOM_FACTORS.length - 1)]
        : ZOOM_FACTORS[Math.max(currentIndex - 1, 0)];
    const contents = [this.view, ...[...this.turnTabs.values()].map((tab) => tab.view)]
      .map((view) => view?.webContents)
      .filter((candidate) => candidate && !candidate.isDestroyed());
    if (contents.length === 0) throw new Error("Browser is unavailable for zoom");
    for (const candidate of contents) candidate.setZoomFactor(next);
    this.setState({ zoomFactor: next });
    return this.snapshot();
  }

  async beginTurn(
    traceId,
    reveal,
    helperPid,
    conversationKey,
    connectorIdentity,
    requireRetainedConversation = false,
    providerOrSignal = this.provider || "m365",
    acquisitionSignal,
    initialUrl,
  ) {
    const args = [
      traceId,
      reveal,
      helperPid,
      conversationKey,
      connectorIdentity,
      requireRetainedConversation,
      providerOrSignal,
      acquisitionSignal,
    ];
    if (initialUrl !== undefined) {
      args.push(initialUrl);
    }
    return turnManagerFor(this).beginTurn(...args);
  }

  async endTurn(
    traceId,
    helperPid,
    status,
    hideAfterTurn,
    message,
    retain = false,
    connectorBound = false,
    conversationId,
  ) {
    return turnManagerFor(this).endTurn(
      traceId,
      helperPid,
      status,
      hideAfterTurn,
      message,
      retain,
      connectorBound,
      conversationId,
    );
  }

  async returnToIdle() {
    const providerLabel = resolveProviderFromHost(this).displayName;
    this.hide();
    this.view.webContents.setBackgroundThrottling(true);
    if (this.view.webContents.getURL() !== IDLE_BROWSER_URL) {
      await this.view.webContents.loadURL(IDLE_BROWSER_URL);
    }
    this.setState({
      status: this.state.authenticated ? "ready" : "signed-out",
      message: this.state.authenticated ? "No active task" : `Sign in to ${providerLabel}`,
    });
  }

  async openLogin(providerId) {
    if (providerId && providerId !== this.provider && typeof this.switchProvider === "function") {
      await this.switchProvider(providerId);
    }
    const providerObj = resolveProviderFromHost(this);
    this.homeSurfaceOpen = true;
    this.activateHomeSurface();
    this.show();
    const current = this.view.webContents.getURL();
    if (!providerObj.isAuthOrAppUrl(current)) {
      void this.view.webContents.loadURL(providerObj.homeUrl);
    }
    return this.snapshot();
  }

  async logout() {
    const providerObj = resolveProviderFromHost(this);
    return await this.withManualOperation(`${providerObj.displayName} logout`, async () => {
      if (this.authView) this.closeAuthView(this.authView, true, false);
      const contents = this.view.webContents;
      await contents.session.clearStorageData();
      this.authenticatedByProvider ||= {};
      this.authenticatedByProvider[providerObj.id] = false;
      this.setState({
        authenticated: false,
        loading: true,
        message: `Signing out of ${providerObj.displayName}`,
        status: "loading",
      });
      await contents.loadURL(providerObj.homeUrl);
      await this.probeAuthentication();
      this.activateHomeSurface();
      this.show();
      this.logger.info("browser.logout_completed");
      return this.snapshot();
    });
  }

  refreshAuthentication() {
    const providerObj = resolveProviderFromHost(this);
    const targetView = this.primaryViewManager?.get?.(providerObj.id)
      || this.providerViews?.get?.(providerObj.id)
      || this.view;
    const contents = targetView?.webContents;
    const currentUrl = contents?.getURL?.() || "";
    const loadPromise = !providerObj.isAuthOrAppUrl(currentUrl)
      ? Promise.resolve(contents?.loadURL?.(providerObj.homeUrl)).catch(() => {})
      : Promise.resolve();
    return loadPromise
      .then(() => providerObj.waitForAuthenticationSettle?.(contents))
      .then(() => this.probeAuthentication())
      .finally(() => {
        if (this.primaryViewManager) {
          this.parkIdlePrimaryView?.();
          this.syncViewVisibility?.();
        }
      });
  }

  async probeAuthentication() {
    if (this.authenticationProbe) return this.authenticationProbe;
    const revision = this.authenticationRevision;
    const providerObj = resolveProviderFromHost(this);
    const operation = (async () => {
      if (!this.view || this.view.webContents.isDestroyed()) return this.snapshot();
      const url = this.view.webContents.getURL();
      if (!url || url === IDLE_BROWSER_URL || url === "about:blank") {
        this.setState({
          status: this.state.authenticated ? "ready" : "signed-out",
          message: this.state.authenticated
            ? `${providerObj.displayName} is ready`
            : `Sign in to ${providerObj.displayName}`,
          url,
          title: providerObj.getFallbackTitle(),
        });
        return this.snapshot();
      }
      const result = await providerObj.probeAuthentication(this.view.webContents);
      if (revision !== this.authenticationRevision) return this.snapshot();
      this.authenticatedByProvider ||= {};
      if (result.authenticated) {
        this.reauthenticationRequired = false;
        this.authenticatedByProvider[providerObj.id] = true;
        if (this.authView && !this.authView.webContents.isDestroyed()) {
          this.closeAuthView(this.authView, true, false);
        }
        this.setState({
          status: this.activeTraceId ? "running" : "ready",
          message: this.activeTraceId
            ? `${providerObj.displayName} is working`
            : `${providerObj.displayName} is ready`,
          authenticated: true,
          url: result.url,
          title: providerObj.getFallbackTitle(),
          loading: false,
        });
      } else {
        this.authenticatedByProvider[providerObj.id] = false;
        const loaded = result.readyState === "complete";
        this.setState({
          status: loaded ? "signed-out" : "loading",
          message: loaded
            ? `Sign in to ${providerObj.displayName}`
            : `Waiting for ${providerObj.displayName}`,
          authenticated: false,
          url: result.url || url,
          title: providerObj.getFallbackTitle(),
          loading: !loaded,
        });
      }
      return this.snapshot();
    })();
    const tracked = operation.finally(() => {
      if (this.authenticationProbe === tracked) this.authenticationProbe = null;
    });
    this.authenticationProbe = tracked;
    return tracked;
  }

  async smokeTest(providerId) {
    if (providerId && providerId !== this.provider && typeof this.switchProvider === "function") {
      await this.switchProvider(providerId);
    }
    return await this.withManualOperation("browser smoke test", () => this.runSmokeTest());
  }

  async runSmokeTest() {
    this.homeSurfaceOpen = true;
    const providerObj = resolveProviderFromHost(this);
    return await providerObj.runSmokeTest({
      view: this.view,
      show: () => this.show(),
      activateHomeSurface: () => this.activateHomeSurface(),
      waitForSurfaceReady: () => this.waitForSurfaceReady(),
      setState: (patch) => this.setState(patch),
      logger: this.logger,
      idleBrowserUrl: IDLE_BROWSER_URL,
    });
  }

  async inspectSession() {
    return await this.withManualOperation("session inspection", () => this.runSessionInspection());
  }

  async runSessionInspection() {
    const liveUrl = (this.view && !this.view.webContents.isDestroyed()) ? this.view.webContents.getURL() : "";
    const snapshot = await this.probeAuthentication();
    return {
      authenticated: Boolean(snapshot?.authenticated),
      url: snapshot?.url || liveUrl,
      provider: this.provider,
    };
  }

  async withManualOperation(name, action) {
    await this.ready();
    if (this.activeTraceId) {
      throw new Error(`Browser is running Codex turn ${this.activeTraceId}`);
    }
    if (this.manualOperation) {
      throw new Error(`Browser is already busy with ${this.manualOperation}`);
    }
    this.activateHomeSurface();
    this.manualOperation = name;
    const contents = this.view?.webContents;
    if (contents && !contents.isDestroyed()) contents.setBackgroundThrottling(false);
    const providerLabel = resolveProviderFromHost(this).displayName;
    try {
      return await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setState({ status: "error", message, loading: false });
      throw error;
    } finally {
      if (contents && !contents.isDestroyed()) contents.setBackgroundThrottling(true);
      this.manualOperation = null;
      if (!this.activeTraceId && this.state) {
        const isAuth = Boolean(this.authenticatedByProvider?.[this.provider]);
        const currentStatus = this.state?.status;
        if (currentStatus === "loading" || currentStatus === "testing") {
          this.setState({
            status: isAuth ? "ready" : "signed-out",
            message: isAuth ? `${providerLabel} is ready` : `Sign in to ${providerLabel}`,
            loading: false,
          });
        }
      }
      this.publishState?.(this.snapshot());
    }
  }

  writeDescriptor() {
    const surfaceTargets = {};
    const providerSurfaceIds = {};
    if (this.surfaceIds) {
      for (const [providerId, surfaceId] of this.surfaceIds.entries()) {
        if (surfaceId) providerSurfaceIds[providerId] = surfaceId;
      }
    }
    const providerPrimarySurfaces = [];
    if (this.surfaceIds) {
      for (const [providerId, surfaceId] of this.surfaceIds.entries()) {
        const view = this.primaryViewManager?.get?.(providerId) || this.providerViews?.get?.(providerId);
        if (surfaceId && view) {
          providerPrimarySurfaces.push([surfaceId, view.webContents]);
        }
      }
    }
    const surfaces = [
      ...providerPrimarySurfaces,
      ...(this.surfaceId && this.view ? [[this.surfaceId, this.view?.webContents]] : []),
      ...[...this.turnTabs.values()].map(tab => [tab.surfaceId, tab.view?.webContents || tab.view]),
    ];
    for (const [surfaceId, contents] of surfaces) {
      if (!surfaceId || !contents || (typeof contents.isDestroyed === "function" && contents.isDestroyed())) continue;
      if (Object.hasOwn(surfaceTargets, surfaceId)) continue;
      surfaceTargets[surfaceId] = contents.getOrCreateDevToolsTargetId();
    }
    const descriptor = {
      version: 3,
      kind: "codex-web-gpt-launcher",
      profile: this.profile,
      pid: process.pid,
      endpoint: `http://127.0.0.1:${this.cdpPort}`,
      control: this.control,
      helper: this.helper,
      partition: this.partition,
      idleUrl: IDLE_BROWSER_URL,
      surfaceId: this.surfaceId,
      activeSurfaceId: this.surfaceId,
      providerSurfaceIds,
      surfaceTargets,
      provider: this.provider || this.providerRegistry?.defaultId?.() || "m365",
      createdAt: new Date().toISOString(),
    };
    writePrivateFileAtomic(this.descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  }

  async persistSession() {
    const sessions = new Set();
    const candidates = [
      this.view?.webContents,
      ...(this.providerViews ? [...this.providerViews.values()].map(view => view?.webContents) : []),
      ...(this.turnTabs ? [...this.turnTabs.values()].map(tab => tab?.view?.webContents) : []),
    ];
    for (const contents of candidates) {
      if (!contents || contents.isDestroyed?.() || !contents.session) continue;
      sessions.add(contents.session);
    }
    await Promise.allSettled([...sessions].map(async (browserSession) => {
      browserSession.flushStorageData?.();
      await browserSession.cookies?.flushStore?.();
    }));
  }

  destroy() {
    this.destroyed = true;
    if (this.authenticationCookieBindings) {
      for (const [sessionCookies, listener] of this.authenticationCookieBindings) {
        sessionCookies.off("changed", listener);
      }
      this.authenticationCookieBindings.clear();
    } else if (this.authenticationCookieListener && this.view?.webContents?.session?.cookies) {
      this.view.webContents.session.cookies.off("changed", this.authenticationCookieListener);
    }
    try {
      const current = JSON.parse(fs.readFileSync(this.descriptorPath, "utf8"));
      if (current.pid === process.pid) fs.rmSync(this.descriptorPath, { force: true });
    } catch {}
    for (const [contents, handler] of this.shellZoomShortcutBindings) {
      if (!contents.isDestroyed()) contents.off("before-input-event", handler);
    }
    this.shellZoomShortcutBindings.clear();
    for (const event of WINDOW_VISIBILITY_EVENTS) {
      this.window.off(event, this.windowVisibilityListener);
    }
    this.closeAuthView(this.authView, true);
    this.clearHomeNavigationTimeout();
    this.turnTabManager?.destroy();
    this.primaryViewManager?.destroyAll();
    this.providerViews?.clear();
    this.view = null;
  }
}

module.exports = {
  allowedAuthUrl: allowedM365AuthUrl,
  BrowserHost,
  BrowserTurnCancelledError,
  createDefaultProviderRegistry,
  IDLE_BROWSER_URL,
  loadCommittedBrowserSurface,
  M365_ORIGIN,
  M365_PARTITION,
  navigationErrorForLog,
  navigationOriginForLog,
};
