const { shell } = require("electron");

const ALLOWED_GEMINI_HOSTS = new Set([
  "gemini.google.com",
  "accounts.google.com",
]);

function allowedGeminiNavigation(rawUrl) {
  let url;
  try { url = new URL(rawUrl); }
  catch { return false; }
  return url.protocol === "https:"
    && (ALLOWED_GEMINI_HOSTS.has(url.hostname)
      || url.hostname.endsWith(".gemini.google.com"));
}

async function markGeminiTurnSurface(tab) {
  const contents = tab?.view?.webContents;
  if (!contents || contents.isDestroyed()) {
    throw new Error("Gemini turn browser closed before ownership was established");
  }
  const encoded = JSON.stringify(tab.surfaceId);
  await contents.executeJavaScript(`(() => {
    Object.defineProperty(globalThis, "__CODEX_WEB_GPT_SURFACE_ID__", {
      value: ${encoded}, configurable: true, enumerable: false, writable: false,
    });
    document.documentElement.dataset.codexWebGptSurface = ${encoded};
  })()`, true);
}

function syncGeminiConversationBinding(host, tab, url) {
  if (!tab?.conversationKey || typeof url !== "string") return;
  const providerObj = host?.providerRegistry?.get?.(tab.provider || "gemini");
  if (
    !providerObj
    || typeof providerObj.parseConversationId !== "function"
    || typeof providerObj.bind !== "function"
  ) {
    return;
  }
  const parsedId = providerObj.parseConversationId(url);
  if (!parsedId || tab.conversationId === parsedId) return;
  const boundId = providerObj.bind(
    tab.conversationKey,
    parsedId,
    tab.profileId || "default",
  );
  if (boundId) {
    tab.conversationId = boundId;
    tab.connectorBound = true;
  }
}

function bindGeminiTurnContents(host, tab) {
  const contents = tab.view.webContents;
  const shouldPublishUiState = () => host.window?.isVisible?.() !== false;
  contents.setWindowOpenHandler(({ url }) => {
    if (!allowedGeminiNavigation(url)) {
      let parsed;
      try { parsed = new URL(url); } catch { return { action: "deny" }; }
      if (parsed.protocol === "https:" || parsed.protocol === "http:") void shell.openExternal(parsed.toString());
    }
    return { action: "deny" };
  });
  const restrictNavigation = (event, url, _inPlace, mainFrame) => {
    if (mainFrame === false || allowedGeminiNavigation(url)) return;
    event.preventDefault();
  };
  contents.on("will-navigate", restrictNavigation);
  contents.on("will-redirect", restrictNavigation);
  contents.on("did-start-navigation", (_event, url, inPlace, mainFrame) => {
    if (!mainFrame) return;
    tab.url = url;
    tab.loading = true;
    if (!inPlace) {
      tab.rendererReady = false;
      tab.deviceEmulationDirty = true;
    }
    if (shouldPublishUiState()) host.publishState?.(host.snapshot());
  });
  contents.on("did-start-loading", () => {
    tab.loading = true;
    if (shouldPublishUiState()) host.publishState?.(host.snapshot());
  });
  contents.on("did-stop-loading", () => {
    tab.loading = false;
    tab.url = contents.getURL();
    syncGeminiConversationBinding(host, tab, tab.url);
    if (shouldPublishUiState()) host.publishState?.(host.snapshot());
  });
  contents.on("did-finish-load", () => {
    tab.url = contents.getURL();
    syncGeminiConversationBinding(host, tab, tab.url);
    tab.loading = false;
    tab.rendererReady = true;
    tab.bootstrapReady = allowedGeminiNavigation(tab.url);
    host.syncViewVisibility();
    if (tab.initializingSurface) {
      if (shouldPublishUiState()) host.publishState?.(host.snapshot());
      return;
    }
    void markGeminiTurnSurface(tab).then(
      () => {
        if (shouldPublishUiState()) host.publishState?.(host.snapshot());
      },
      (error) => {
        if (contents.isDestroyed?.() || contents.isLoadingMainFrame?.()) {
          host.logger?.warn?.("browser.gemini_surface_mark_deferred", {
            tabId: tab.id,
            traceId: tab.traceId,
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        tab.status = "error";
        tab.message = `Gemini browser ownership failed: ${error instanceof Error ? error.message : String(error)}`;
        host.syncPowerSaveBlocker();
        host.publishState?.(host.snapshot());
      },
    );
  });
  contents.on("page-title-updated", (_event, title) => {
    if (typeof title === "string" && title.trim()) tab.pageTitle = title.trim();
    if (shouldPublishUiState()) host.publishState?.(host.snapshot());
  });
  contents.on("did-navigate-in-page", (_event, url, mainFrame) => {
    if (mainFrame) {
      tab.url = url;
      syncGeminiConversationBinding(host, tab, url);
    }
    if (shouldPublishUiState()) host.publishState?.(host.snapshot());
  });
  contents.on("did-fail-load", (_event, errorCode, errorDescription, url, mainFrame) => {
    if (!mainFrame || errorCode === -3) return;
    tab.url = url;
    tab.message = errorDescription;
    host.logger.error("browser.gemini_tab_navigation_failed", {
      tabId: tab.id, traceId: tab.traceId, errorCode, errorDescription, url,
    });
    host.removeTurnTab(tab, true);
  });
  contents.on("render-process-gone", (_event, details) => {
    tab.message = `Gemini browser renderer stopped: ${details.reason}`;
    host.logger.error("browser.gemini_tab_renderer_gone", {
      tabId: tab.id, traceId: tab.traceId, reason: details.reason, exitCode: details.exitCode,
    });
    host.removeTurnTab(tab, true);
  });
  contents.on("unresponsive", () => host.logger.warn("browser.gemini_tab_unresponsive", {
    tabId: tab.id, traceId: tab.traceId,
  }));
  contents.on("responsive", () => host.logger.info("browser.gemini_tab_responsive", {
    tabId: tab.id, traceId: tab.traceId,
  }));
}

module.exports = {
  allowedGeminiNavigation,
  bindGeminiTurnContents,
  markGeminiTurnSurface,
};
