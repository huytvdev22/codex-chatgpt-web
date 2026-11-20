const { randomBytes } = require("node:crypto");
const { WebContentsView, powerMonitor, powerSaveBlocker } = require("electron");
const { processRunning } = require("../runtime/process-tree.cjs");
const {
  refreshTurnLeasesAfterSuspension,
  shouldBlockSleepForTurns,
  sweepGapIndicatesSuspension,
} = require("../infra/turn-suspension.cjs");
const { M365BrowserProvider } = require("./providers/m365/m365-browser-provider.cjs");

const IDLE_BROWSER_URL = "data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Chtml%3E%3Chead%3E%3Cmeta%20charset%3D%22utf-8%22%3E%3Ctitle%3ECodex%20Web%20GPT%3C%2Ftitle%3E%3C%2Fhead%3E%3Cbody%3E%3C%2Fbody%3E%3C%2Fhtml%3E#codex-web-gpt-browser-host";
const PRIMARY_VIEW_BOOTSTRAP_TIMEOUT_MS = 10_000;
const TURN_TAB_INITIAL_LOAD_TIMEOUT_MS = 20_000;
const TURN_TAB_RETRY_LOAD_TIMEOUT_MS = 30_000;
const MAX_BROWSER_TABS = 5;
const MAX_CANCELLED_TURN_TRACES = 256;
const HIDDEN_TURN_VIEWPORT = Object.freeze({ width: 1024, height: 720 });
const TURN_HEARTBEAT_SWEEP_MS = 5_000;
const TURN_HEARTBEAT_TIMEOUT_MS = 60_000;
const TURN_TAB_BOOTSTRAP_TIMEOUT_MS = 120_000;
const RETAINED_TURN_TAB_TTL_MS = 30 * 60 * 1000;
const AI_STUDIO_REOPEN_COOLDOWN_MS = 3_000;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function sleepWithAbort(milliseconds, signal) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return Promise.resolve();
  signal?.throwIfAborted?.();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason || new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, milliseconds);
    timer.unref?.();
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function hasProviderOnHost(host, providerId) {
  const id = providerId || host?.provider || "m365";
  if (host?.providerRegistry?.has?.(id)) return true;
  return id === "m365";
}

function resolveProviderFromHost(host, providerId = host?.provider || "m365") {
  const id = providerId || host?.provider || "m365";
  if (host?.providerRegistry?.has?.(id)) {
    return host.providerRegistry.get(id);
  }
  if (id === "m365") {
    if (!host._fallbackM365Provider) {
      host._fallbackM365Provider = new M365BrowserProvider({ descriptorPath: host?.descriptorPath || null });
    }
    return host._fallbackM365Provider;
  }
  throw new Error(`Unknown browser provider: ${id}`);
}

class BrowserTurnCancelledError extends Error {
  constructor(traceId) {
    super(`Browser turn ${traceId} was cancelled by the user`);
    this.name = "BrowserTurnCancelledError";
    this.code = "turn_cancelled";
  }
}

function loadCommittedBrowserSurface(
  contents,
  url,
  timeoutMs = PRIMARY_VIEW_BOOTSTRAP_TIMEOUT_MS,
  { isCommittedUrl = null } = {},
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Browser idle document timeout must be positive");
  }
  if (!contents || contents.isDestroyed()) {
    return Promise.reject(new Error("Browser closed before idle document bootstrap"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      contents.off("did-stop-loading", onReady);
      contents.off("did-finish-load", onReady);
      contents.off("did-fail-load", onFailed);
      contents.off("render-process-gone", onRendererGone);
      contents.off("destroyed", onDestroyed);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => {
      if (contents.isDestroyed()) {
        finish(new Error("Browser closed during idle document bootstrap"));
        return;
      }
      const currentUrl = contents.getURL();
      const committed = typeof isCommittedUrl === "function"
        ? isCommittedUrl(currentUrl)
        : currentUrl === url;
      if (committed) finish();
    };
    const allowRedirectAbort = typeof isCommittedUrl === "function";
    const onFailed = (_event, errorCode, errorDescription, failedUrl, mainFrame) => {
      if (!mainFrame) return;
      if (allowRedirectAbort && errorCode === -3) return;
      finish(new Error(
        `Browser idle document failed: ${errorDescription} (${errorCode}) at ${failedUrl}`,
      ));
    };
    const onRendererGone = (_event, details) => {
      finish(new Error(`Browser renderer stopped during idle document bootstrap: ${details.reason}`));
    };
    const onDestroyed = () => finish(new Error("Browser closed during idle document bootstrap"));
    const timeout = setTimeout(() => {
      finish(new Error(`Browser idle document did not commit within ${timeoutMs}ms`));
      if (!contents.isDestroyed()) contents.stop();
    }, timeoutMs);
    timeout.unref?.();
    contents.on("did-stop-loading", onReady);
    contents.on("did-finish-load", onReady);
    contents.on("did-fail-load", onFailed);
    contents.on("render-process-gone", onRendererGone);
    contents.on("destroyed", onDestroyed);
    try {
      Promise.resolve(contents.loadURL(url)).then(onReady, error => {
        const isAbort = error && typeof error === "object"
          && (error.code === "ERR_ABORTED" || error.errno === -3 || String(error.message || "").includes("ERR_ABORTED"));
        if (allowRedirectAbort && isAbort) {
          onReady();
          return;
        }
        finish(error instanceof Error ? error : new Error(String(error)));
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Quản lý toàn bộ vòng đời các tab turn song song: cấp phát theo capacity & LRU,
 * bootstrap + retry, heartbeat/lease reaping, power-save blocking và dọn dẹp tài nguyên.
 */
class TurnTabManager {
  constructor(host, { standalone = false, aiStudioReopenCooldownMs } = {}) {
    this.host = host;
    this.turnTabs = host.turnTabs instanceof Map ? host.turnTabs : new Map();
    this.closedTurnOwners = host.closedTurnOwners instanceof Map ? host.closedTurnOwners : new Map();
    this.userCancelledTurnOwners = host.userCancelledTurnOwners instanceof Map ? host.userCancelledTurnOwners : new Map();
    this.lastClosedAtByProvider = host.lastClosedAtByProvider instanceof Map
      ? host.lastClosedAtByProvider
      : new Map();
    this.aiStudioReopenCooldownMs = typeof aiStudioReopenCooldownMs === "number"
      ? aiStudioReopenCooldownMs
      : typeof host.aiStudioReopenCooldownMs === "number"
        ? host.aiStudioReopenCooldownMs
        : AI_STUDIO_REOPEN_COOLDOWN_MS;
    this.turnLeaseSweep = null;
    this.resumeListener = null;

    if (!standalone) {
      if (host.lastTurnSweepAt === undefined) host.lastTurnSweepAt = Date.now();
      if (host.powerSaveBlockerId === undefined) host.powerSaveBlockerId = null;
      this.turnLeaseSweep = setInterval(() => {
        void this.reapExpiredTurnTabs();
      }, TURN_HEARTBEAT_SWEEP_MS);
      this.turnLeaseSweep.unref?.();
      this.resumeListener = () => this.refreshTurnLeases("system_resume");
      if (powerMonitor && typeof powerMonitor.on === "function") {
        powerMonitor.on("resume", this.resumeListener);
      } else {
        this.resumeListener = null;
      }
    }
  }

  resolveProvider(providerId) {
    return resolveProviderFromHost(this.host, providerId);
  }

  hasProvider(providerId) {
    return hasProviderOnHost(this.host, providerId);
  }

  get activeTraceId() {
    return [...this.turnTabs.values()].find((tab) => tab.status === "running")?.traceId || null;
  }

  tabSnapshot(tab) {
    return {
      id: tab.id,
      traceId: tab.traceId,
      title: tab.label,
      status: tab.status,
      loading: tab.loading === true,
      active: this.host.selectedTabId === tab.id,
      closable: true,
    };
  }

  selectedTurnTab() {
    return this.turnTabs.get(this.host.selectedTabId) || null;
  }

  evictOldestRetainedTurnTab() {
    const retained = [...this.turnTabs.values()]
      .filter(tab => tab.status === "ready")
      .sort((left, right) => (left.lastHeartbeatAt ?? 0) - (right.lastHeartbeatAt ?? 0))[0];
    if (!retained) return false;
    (this.host.removeTurnTab || this.removeTurnTab).call(this.host, retained, false);
    return true;
  }

  evictOldestReclaimableTurnTab() {
    const deadTurn = [...this.turnTabs.values()]
      .filter(tab => tab.status === "error" || tab.status === "aborted")
      .sort((left, right) => (left.lastHeartbeatAt ?? 0) - (right.lastHeartbeatAt ?? 0))[0];
    if (deadTurn) {
      (this.host.removeTurnTab || this.removeTurnTab).call(this.host, deadTurn, false);
      return true;
    }
    const orphanTurn = [...this.turnTabs.values()]
      .filter(tab => tab.status === "running" && tab.helperPid && !processRunning(tab.helperPid))
      .sort((left, right) => (left.lastHeartbeatAt ?? 0) - (right.lastHeartbeatAt ?? 0))[0];
    if (orphanTurn) {
      (this.host.removeTurnTab || this.removeTurnTab).call(this.host, orphanTurn, false);
      return true;
    }
    return this.host.evictOldestRetainedTurnTab
      ? this.host.evictOldestRetainedTurnTab()
      : this.evictOldestRetainedTurnTab();
  }

  async createTurnTab(traceId, helperPid, conversationKey, connectorIdentity, signal, providerId = this.host?.provider || "m365", initialUrl = null) {
    signal?.throwIfAborted();
    if (providerId === "ai-studio" && this.aiStudioReopenCooldownMs > 0) {
      const lastClosedAt = this.lastClosedAtByProvider?.get("ai-studio") || 0;
      const elapsed = Date.now() - lastClosedAt;
      if (lastClosedAt > 0 && elapsed < this.aiStudioReopenCooldownMs) {
        const remainingMs = this.aiStudioReopenCooldownMs - elapsed;
        this.host.logger?.info?.("browser.ai_studio_reopen_cooldown", { traceId, remainingMs });
        await sleepWithAbort(remainingMs, signal);
      }
    }
    const evictReclaimable = this.host.evictOldestReclaimableTurnTab || (() => this.evictOldestReclaimableTurnTab());
    if (this.turnTabs.size >= MAX_BROWSER_TABS && !evictReclaimable.call(this.host)) {
      const providerLabel = this.hasProvider(providerId)
        ? this.resolveProvider(providerId).displayName
        : "Browser";
      throw new Error(
        `${providerLabel} already has ${MAX_BROWSER_TABS} browser tabs; close one before starting another turn to avoid excessive parallel traffic on the account`,
      );
    }
    const providerObj = this.resolveProvider(providerId);
    const id = randomBytes(12).toString("base64url");
    const surfaceId = randomBytes(24).toString("base64url");
    const ordinal = Array.from({ length: MAX_BROWSER_TABS }, (_unused, index) => index + 1)
      .find(candidate => ![...this.turnTabs.values()].some(tab => tab.ordinal === candidate));
    if (!ordinal) throw new Error("Browser tab allocation is inconsistent");
    const resolvedInitialUrl = typeof initialUrl === "string" && initialUrl.trim() && providerObj.isAllowedNavigation(initialUrl)
      ? initialUrl.trim()
      : null;
    const bootstrapUrl = resolvedInitialUrl || providerObj.initialUrl?.(conversationKey) || providerObj.homeUrl;
    const conversationId = providerObj.conversationId?.(conversationKey) || null;
    const view = new WebContentsView({
      webPreferences: {
        partition: providerObj.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        backgroundThrottling: false,
      },
    });
    const labelPrefix = providerObj.id.toUpperCase();
    const tab = {
      id,
      surfaceId,
      traceId,
      conversationKey,
      connectorIdentity,
      connectorBound: false,
      provider: providerObj.id,
      conversationId,
      helperPid,
      view,
      status: "running",
      ordinal,
      label: `${labelPrefix} ${ordinal}`,
      pageTitle: providerObj.getFallbackTitle(),
      url: bootstrapUrl,
      loading: true,
      message: `${providerObj.displayName} is working`,
      initializingSurface: true,
      bootstrapReady: false,
      rendererReady: false,
      deviceEmulationViewport: null,
      deviceEmulationDirty: true,
      bootstrapDeadlineAt: Date.now() + TURN_TAB_BOOTSTRAP_TIMEOUT_MS,
      lastHeartbeatAt: Date.now(),
    };
    this.turnTabs.set(id, tab);
    this.syncPowerSaveBlocker();
    this.host.window.contentView.addChildView(view);
    this.host.presentTurnView(tab, false);
    view.webContents.setZoomFactor(this.host.state.zoomFactor);
    this.host.bindShellZoomShortcuts(view.webContents);
    if (view?.webContents?.session) {
      providerObj.onPrimarySessionCreated?.(view.webContents.session, this.host);
    }
    providerObj.bindTurnContents(this.host, tab);
    await (this.host.initializeTurnTab || this.initializeTurnTab).call(this.host, tab, signal);
    return tab;
  }

  async initializeTurnTab(tab, signal) {
    const providerObj = this.resolveProvider(tab.provider);
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      signal?.throwIfAborted();
      await Promise.race([(async () => {
        const contents = tab.view.webContents;
        const targetUrl = tab.url || IDLE_BROWSER_URL;
        const urlMatcher = targetUrl.startsWith("https://")
          ? (current) => current === targetUrl || providerObj.isAllowedNavigation(current)
          : null;
        try {
          await loadCommittedBrowserSurface(
            contents,
            targetUrl,
            TURN_TAB_INITIAL_LOAD_TIMEOUT_MS,
            { isCommittedUrl: urlMatcher },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const retryable = message.includes("Browser idle document did not commit within")
            || (Boolean(urlMatcher) && (message.includes("ERR_ABORTED") || message.includes("(-3)")));
          if (!retryable || contents.isDestroyed()) throw error;
          this.host.logger.warn("browser.tab_initialization_retry", {
            tabId: tab.id,
            traceId: tab.traceId,
            provider: tab.provider,
            message,
          });
          await sleep(500);
          signal?.throwIfAborted();
          const currentUrl = typeof contents.getURL === "function" ? contents.getURL() : "";
          if (!urlMatcher || !urlMatcher(currentUrl)) {
            await loadCommittedBrowserSurface(
              contents,
              targetUrl,
              TURN_TAB_RETRY_LOAD_TIMEOUT_MS,
              { isCommittedUrl: urlMatcher },
            );
          }
        }
        signal?.throwIfAborted();
        await providerObj.markOwnedSurface(tab);
      })(), aborted]);
      signal?.throwIfAborted();
      tab.initializingSurface = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.host.logger.error("browser.tab_initialization_failed", {
        tabId: tab.id,
        traceId: tab.traceId,
        message,
      });
      if (this.turnTabs.get(tab.id) === tab) {
        (this.host.removeTurnTab || this.removeTurnTab).call(this.host, tab, true);
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  heartbeatTurn(traceId, helperPid, refreshViewport = false) {
    if (typeof refreshViewport !== "boolean") throw new Error("refreshViewport is invalid");
    const tab = [...this.turnTabs.values()].find(candidate => candidate.traceId === traceId);
    if (!tab) {
      const closedOwner = this.closedTurnOwners.get(traceId);
      if (closedOwner === helperPid) throw new Error(`Browser turn ${traceId} was already released`);
      throw new Error(`Browser turn ownership mismatch: no browser tab owns ${traceId}`);
    }
    if (tab.helperPid !== helperPid) {
      throw new Error(`Browser helper ownership mismatch: expected ${tab.helperPid}, received ${helperPid}`);
    }
    if (tab.status !== "running") throw new Error(`Browser turn ${traceId} is no longer running`);
    tab.lastHeartbeatAt = Date.now();
    if (refreshViewport) {
      tab.deviceEmulationDirty = true;
      this.host.syncViewVisibility();
    }
    return this.host.snapshot();
  }

  refreshTurnLeases(reason, now = Date.now()) {
    const refreshed = refreshTurnLeasesAfterSuspension(
      [...this.turnTabs.values()],
      now,
      TURN_TAB_BOOTSTRAP_TIMEOUT_MS,
    );
    if (refreshed.length > 0) {
      this.host.logger.warn("browser.turn_leases_refreshed_after_suspension", { reason, traceIds: refreshed });
    }
  }

  syncPowerSaveBlocker() {
    if (!powerSaveBlocker || typeof powerSaveBlocker.start !== "function") return;
    const wanted = shouldBlockSleepForTurns([...this.turnTabs.values()]);
    const currentId = this.host.powerSaveBlockerId ?? null;
    const active = currentId !== null && powerSaveBlocker.isStarted(currentId);
    if (wanted && !active) {
      this.host.powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
      this.host.logger.info("browser.sleep_blocked_for_turns", { blockerId: this.host.powerSaveBlockerId });
    } else if (!wanted && active) {
      powerSaveBlocker.stop(currentId);
      this.host.logger.info("browser.sleep_block_released", { blockerId: currentId });
      this.host.powerSaveBlockerId = null;
    }
  }

  reapExpiredTurnTabs(now = Date.now()) {
    const cancellations = [];
    const lastSweepAt = this.host.lastTurnSweepAt;
    this.host.lastTurnSweepAt = now;
    if (sweepGapIndicatesSuspension(lastSweepAt, now, TURN_HEARTBEAT_SWEEP_MS)) {
      (this.host.refreshTurnLeases || this.refreshTurnLeases).call(this.host, "sweep_gap", now);
      return;
    }
    for (const tab of [...this.turnTabs.values()]) {
      if (tab.status === "ready") {
        if (now - (tab.lastHeartbeatAt ?? 0) < RETAINED_TURN_TAB_TTL_MS) continue;
        (this.host.removeTurnTab || this.removeTurnTab).call(this.host, tab, false);
        continue;
      }
      if (tab.status !== "running") continue;
      const bootstrapExpired = tab.bootstrapReady !== true
        && now >= (tab.bootstrapDeadlineAt ?? Number.POSITIVE_INFINITY);
      const heartbeatExpired = tab.bootstrapReady === true
        && now - (tab.lastHeartbeatAt ?? 0) >= TURN_HEARTBEAT_TIMEOUT_MS;
      if (!bootstrapExpired && !heartbeatExpired) continue;
      if (tab.expiryCancellation) {
        cancellations.push(tab.expiryCancellation);
        continue;
      }
      const evidence = bootstrapExpired ? "browser_surface_bootstrap_timeout" : "helper_heartbeat_expired";
      const expiredOwner = {
        tabId: tab.id,
        traceId: tab.traceId,
        helperPid: tab.helperPid,
        evidence,
      };
      this.host.logger.warn("browser.orphan_turn_expired", expiredOwner);
      if (!this.host.cancelTurn) {
        (this.host.removeTurnTab || this.removeTurnTab).call(this.host, tab, true);
        this.host.logger.warn("browser.orphan_turn_reaped", expiredOwner);
        continue;
      }
      const { traceId, helperPid } = tab;
      tab.expiryCancellation = Promise.resolve().then(async () => {
        try {
          await this.host.cancelTurn(traceId, evidence);
          if (this.turnTabs.get(tab.id) === tab && tab.traceId === traceId
            && tab.helperPid === helperPid && tab.status === "running") {
            (this.host.removeTurnTab || this.removeTurnTab).call(this.host, tab, true);
          }
          this.host.logger.warn("browser.orphan_turn_reaped", expiredOwner);
        } catch (error) {
          this.host.logger.warn("browser.orphan_turn_cancel_failed", {
            tabId: tab.id, traceId, evidence, errorType: error?.name || "Error",
          });
        } finally {
          delete tab.expiryCancellation;
        }
      });
      cancellations.push(tab.expiryCancellation);
    }
    return Promise.all(cancellations);
  }

  presentTurnView(tab, visible) {
    if (visible) {
      tab.view.setBounds(this.host.bounds);
      if (tab.rendererReady && tab.deviceEmulationViewport) {
        tab.view.webContents.disableDeviceEmulation();
        tab.deviceEmulationViewport = null;
      }
      if (tab.rendererReady) tab.deviceEmulationDirty = false;
    } else if (tab.status === "running") {
      const bounds = this.host.hiddenTurnBounds();
      if (tab.rendererReady
        && (tab.deviceEmulationDirty
          || tab.deviceEmulationViewport?.width !== bounds.width
          || tab.deviceEmulationViewport?.height !== bounds.height)) {
        this.host.enableHiddenTurnViewport(tab.view.webContents, bounds);
        tab.deviceEmulationViewport = { width: bounds.width, height: bounds.height };
        tab.deviceEmulationDirty = false;
      }
      tab.view.setBounds(bounds);
    } else {
      if (tab.rendererReady && tab.deviceEmulationViewport) {
        tab.view.webContents?.disableDeviceEmulation?.();
        tab.deviceEmulationViewport = null;
        tab.deviceEmulationDirty = true;
      }
      tab.view.setBounds(this.host.hiddenTurnBounds());
    }
    tab.view.setVisible(visible || tab.status === "running");
  }

  removeTurnTab(tab, abortRunning) {
    if (!this.turnTabs.has(tab.id)) return;
    this.turnTabs.delete(tab.id);
    if ((tab.provider || this.host?.provider) === "ai-studio") {
      this.lastClosedAtByProvider?.set?.("ai-studio", Date.now());
    }
    this.syncPowerSaveBlocker();
    if (abortRunning && tab.status === "running") {
      this.closedTurnOwners.set(tab.traceId, tab.helperPid);
      tab.status = "aborted";
    }
    const contents = tab.view?.webContents;
    if (contents && this.host.shellZoomShortcutBindings) {
      const binding = this.host.shellZoomShortcutBindings.get(contents);
      if (binding && !contents.isDestroyed?.()) {
        contents.off?.("before-input-event", binding);
      }
      this.host.shellZoomShortcutBindings.delete(contents);
    }
    try { this.host.window.contentView.removeChildView(tab.view); } catch {}
    if (contents && !contents.isDestroyed()) {
      if (tab.deviceEmulationViewport) {
        contents.disableDeviceEmulation?.();
        tab.deviceEmulationViewport = null;
      }
      contents.removeAllListeners?.();
      contents.close();
    }
    if (this.host.selectedTabId === tab.id) {
      this.host.selectedTabId = [...this.turnTabs.keys()].at(-1) || "home";
      const homeContents = this.host.view?.webContents;
      if (this.host.selectedTabId === "home"
        && !this.host.activeTraceId
        && homeContents
        && typeof homeContents.getURL === "function"
        && homeContents.getURL() === IDLE_BROWSER_URL) {
        this.host.hide?.();
      }
    }
    this.host.syncViewVisibility();
    this.host.publishState?.(this.host.snapshot());
    this.host.writeDescriptor();
  }

  rememberUserCancelledTurn(traceId, helperPid) {
    this.userCancelledTurnOwners.delete(traceId);
    this.userCancelledTurnOwners.set(traceId, helperPid);
    while (this.userCancelledTurnOwners.size > MAX_CANCELLED_TURN_TRACES) {
      const oldest = this.userCancelledTurnOwners.keys().next();
      if (oldest.done) break;
      this.userCancelledTurnOwners.delete(oldest.value);
    }
  }

  async closeTab(tabId) {
    if (tabId === "home") {
      this.host.homeSurfaceOpen = false;
      if (this.turnTabs.size > 0) {
        this.host.selectedTabId = [...this.turnTabs.keys()].at(-1);
      }
      this.host.parkIdlePrimaryView();
      if (this.turnTabs.size === 0) this.host.hide();
      else this.host.syncViewVisibility();
      this.host.publishState?.(this.host.snapshot());
      return this.host.snapshot();
    }
    const tab = this.turnTabs.get(tabId);
    if (!tab) throw new Error("Browser tab does not exist");
    const running = tab.status === "running";
    if (running) {
      (this.host.rememberUserCancelledTurn || this.rememberUserCancelledTurn).call(this.host, tab.traceId, tab.helperPid);
      if (this.host.cancelTurn) await this.host.cancelTurn(tab.traceId);
    }
    if (this.turnTabs.get(tabId) === tab) {
      (this.host.removeTurnTab || this.removeTurnTab).call(this.host, tab, true);
    }
    this.host.logger.info("browser.tab_closed", { tabId, traceId: tab.traceId, status: tab.status });
    return this.host.snapshot();
  }

  async beginTurn(
    traceId,
    reveal,
    helperPid,
    conversationKey,
    connectorIdentity,
    requireRetainedConversation = false,
    providerOrSignal = "m365",
    acquisitionSignal,
    initialUrl = null,
  ) {
    const providerId = typeof providerOrSignal === "string" ? providerOrSignal : "m365";
    const signal = typeof providerOrSignal === "string" ? acquisitionSignal : providerOrSignal;
    signal?.throwIfAborted();
    if (!this.hasProvider(providerId)) {
      throw new Error("Browser turn provider is invalid");
    }
    const providerObj = this.resolveProvider(providerId);
    if (this.host.manualOperation) {
      throw new Error(`Browser is busy with ${this.host.manualOperation}`);
    }
    if (this.userCancelledTurnOwners.has(traceId)) {
      throw new BrowserTurnCancelledError(traceId);
    }
    const sameTrace = [...this.turnTabs.values()].find((tab) => tab.traceId === traceId);
    if (sameTrace && (sameTrace.conversationKey !== conversationKey
      || sameTrace.connectorIdentity !== connectorIdentity
      || (sameTrace.provider || "m365") !== providerId)) {
      throw new Error(`Browser turn ${traceId} conversation metadata does not match its owned tab`);
    }
    const retainedMatches = conversationKey ? [...this.turnTabs.values()].filter((tab) => (
      tab.status === "ready"
      && tab.conversationKey === conversationKey
      && tab.connectorIdentity === connectorIdentity
      && (tab.provider || "m365") === providerId
      && (!connectorIdentity || tab.connectorBound === true)
    )) : [];
    if (retainedMatches.length > 1) {
      this.host.logger.warn("browser.multiple_retained_tabs_reconciled", {
        conversationKey,
        count: retainedMatches.length,
      });
      retainedMatches.sort((left, right) => (right.lastHeartbeatAt ?? 0) - (left.lastHeartbeatAt ?? 0));
      const chosen = retainedMatches.shift();
      for (const extra of retainedMatches) {
        (this.host.removeTurnTab || this.removeTurnTab).call(this.host, extra, false);
      }
      retainedMatches.length = 1;
      retainedMatches[0] = chosen;
    }
    const exactRetained = retainedMatches[0];
    if (sameTrace?.status === "ready" && sameTrace !== exactRetained) {
      throw new Error(`Browser turn ${traceId} is retained under different conversation metadata`);
    }
    const existing = sameTrace?.status === "running" ? sameTrace : exactRetained;
    if (existing) {
      const reused = existing.status === "ready";
      if (existing.status === "running" && existing.helperPid !== helperPid) {
        if (processRunning(existing.helperPid)) {
          throw new Error(`Browser turn ${traceId} is owned by another helper process`);
        }
        this.host.logger.warn("browser.stale_turn_owner_replaced", {
          tabId: existing.id,
          traceId,
          previousHelperPid: existing.helperPid,
          helperPid,
          evidence: "previous helper exited",
        });
      }
      existing.helperPid = helperPid;
      existing.traceId = traceId;
      existing.status = "running";
      existing.loading = true;
      existing.message = `${providerObj.displayName} is working`;
      if (!reused) {
        existing.bootstrapReady = false;
        existing.bootstrapDeadlineAt = Date.now() + TURN_TAB_BOOTSTRAP_TIMEOUT_MS;
      }
      existing.lastHeartbeatAt = Date.now();
      if (!existing.view.webContents.isDestroyed()) {
        existing.view.webContents.setBackgroundThrottling(false);
      }
      this.host.homeSurfaceOpen = false;
      this.host.selectedTabId = existing.id;
      this.host.parkIdlePrimaryView?.();
      if (reveal) this.host.show();
      else this.host.syncViewVisibility();
      this.host.publishState?.(this.host.snapshot());
      this.host.writeDescriptor();
      return {
        surfaceId: existing.surfaceId,
        tabId: existing.id,
        reused,
        connectorBound: existing.connectorBound === true,
        ...(existing.conversationId ? { conversationId: existing.conversationId } : {}),
      };
    }
    if (requireRetainedConversation) {
      const error = new Error(`The retained ${providerObj.displayName} conversation is no longer available`);
      error.code = "retained_conversation_unavailable";
      throw error;
    }
    providerObj.prepareAllocation(
      this.turnTabs,
      conversationKey,
      tab => (this.host.removeTurnTab || this.removeTurnTab).call(this.host, tab, false),
    );
    const createTab = this.host.createTurnTab || ((...args) => this.createTurnTab(...args));
    const createTabArgs = [
      traceId,
      helperPid,
      conversationKey,
      connectorIdentity,
      signal,
      providerId,
    ];
    if (typeof initialUrl === "string" && initialUrl.trim()) {
      createTabArgs.push(initialUrl);
    }
    const tab = await createTab.call(this.host, ...createTabArgs);
    this.host.homeSurfaceOpen = false;
    this.host.selectedTabId = tab.id;
    this.host.parkIdlePrimaryView?.();
    if (reveal) this.host.show();
    else this.host.syncViewVisibility();
    this.host.publishState?.(this.host.snapshot());
    this.host.logger.info("browser.tab_created", { tabId: tab.id, traceId, tabCount: this.turnTabs.size });
    this.host.writeDescriptor();
    return {
      surfaceId: tab.surfaceId,
      tabId: tab.id,
      reused: false,
      connectorBound: tab.connectorBound === true,
      ...(tab.conversationId ? { conversationId: tab.conversationId } : {}),
    };
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
    const tab = [...this.turnTabs.values()].find((candidate) => candidate.traceId === traceId);
    if (!tab) {
      const closedOwner = this.closedTurnOwners.get(traceId);
      if (closedOwner === helperPid) {
        const cancelledByUser = this.userCancelledTurnOwners.get(traceId) === helperPid;
        this.closedTurnOwners.delete(traceId);
        return { cancelledByUser };
      }
      throw new Error(`Browser turn ownership mismatch: no browser tab owns ${traceId}`);
    }
    if (tab.helperPid !== helperPid) {
      throw new Error(
        `Browser helper ownership mismatch: expected ${tab.helperPid}, received ${helperPid}`,
      );
    }
    const providerObj = this.resolveProvider(tab.provider || this.host?.provider || "m365");
    const cancelledByUser = this.userCancelledTurnOwners.get(traceId) === helperPid;
    const authenticationRequired = tab.authenticationRequired === true;
    if (authenticationRequired && status === "completed") status = "failed";
    let effectiveConnectorBound = connectorBound === true;
    const requiresConversationIdBinding = Boolean(tab.connectorIdentity) || conversationId !== undefined;
    if (status === "completed" && retain && requiresConversationIdBinding) {
      const normalizedConversationId = providerObj.normalizeConversationId(conversationId);
      if (!normalizedConversationId || !tab.conversationKey) {
        status = "failed";
        message = `${providerObj.displayName} completed without a valid persistent conversation id`;
        effectiveConnectorBound = false;
      } else {
        tab.conversationId = providerObj.bind(tab.conversationKey, normalizedConversationId);
        effectiveConnectorBound = true;
      }
    }
    tab.status = status === "completed" ? "ready" : status === "aborted" ? "aborted" : "error";
    this.syncPowerSaveBlocker();
    tab.message = status === "completed" ? "Task completed" : message || `${providerObj.displayName} turn ${status}`;
    tab.loading = false;
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.setBackgroundThrottling(true);
    if (status === "completed"
      && retain
      && tab.conversationKey
      && (!tab.connectorIdentity || effectiveConnectorBound)) {
      tab.connectorBound = effectiveConnectorBound;
      tab.lastHeartbeatAt = Date.now();
      if (hideAfterTurn && !this.host.activeTraceId) this.host.hide();
      else this.host.syncViewVisibility?.();
      this.host.publishState?.(this.host.snapshot());
      this.host.writeDescriptor();
      return { cancelledByUser };
    }
    (this.host.removeTurnTab || this.removeTurnTab).call(this.host, tab, false);
    if (hideAfterTurn && !this.host.activeTraceId) this.host.hide();
    this.host.logger.info("browser.tab_released", { tabId: tab.id, traceId, status: tab.status });
    return { cancelledByUser, ...(authenticationRequired ? { authenticationRequired: true } : {}) };
  }

  destroy() {
    if (this.turnLeaseSweep) {
      clearInterval(this.turnLeaseSweep);
      this.turnLeaseSweep = null;
    }
    if (this.resumeListener && powerMonitor && typeof powerMonitor.removeListener === "function") {
      powerMonitor.removeListener("resume", this.resumeListener);
      this.resumeListener = null;
    }
    if (this.host.powerSaveBlockerId !== null && powerSaveBlocker && typeof powerSaveBlocker.stop === "function") {
      powerSaveBlocker.stop(this.host.powerSaveBlockerId);
      this.host.powerSaveBlockerId = null;
    }
    for (const tab of this.turnTabs.values()) {
      try { this.host.window.contentView.removeChildView(tab.view); } catch {}
      if (!tab.view.webContents.isDestroyed()) {
        if (tab.deviceEmulationViewport) {
          tab.view.webContents.disableDeviceEmulation?.();
          tab.deviceEmulationViewport = null;
        }
        tab.view.webContents.removeAllListeners?.();
        tab.view.webContents.close();
      }
    }
    this.turnTabs.clear();
  }
}

module.exports = {
  AI_STUDIO_REOPEN_COOLDOWN_MS,
  BrowserTurnCancelledError,
  HIDDEN_TURN_VIEWPORT,
  IDLE_BROWSER_URL,
  MAX_BROWSER_TABS,
  MAX_CANCELLED_TURN_TRACES,
  PRIMARY_VIEW_BOOTSTRAP_TIMEOUT_MS,
  RETAINED_TURN_TAB_TTL_MS,
  TURN_HEARTBEAT_SWEEP_MS,
  TURN_HEARTBEAT_TIMEOUT_MS,
  TURN_TAB_BOOTSTRAP_TIMEOUT_MS,
  TurnTabManager,
  hasProviderOnHost,
  loadCommittedBrowserSurface,
  resolveProviderFromHost,
};
