const { shell } = require("electron");

const ALLOWED_AI_STUDIO_HOSTS = new Set([
  "aistudio.google.com",
  "accounts.google.com",
]);

function allowedAiStudioNavigation(rawUrl) {
  let url;
  try { url = new URL(rawUrl); }
  catch { return false; }
  return url.protocol === "https:"
    && (ALLOWED_AI_STUDIO_HOSTS.has(url.hostname)
      || url.hostname.endsWith(".aistudio.google.com"));
}

async function markAiStudioTurnSurface(tab) {
  const contents = tab?.view?.webContents;
  if (!contents || contents.isDestroyed()) {
    throw new Error("AI Studio turn browser closed before ownership was established");
  }
  const encoded = JSON.stringify(tab.surfaceId);
  await contents.executeJavaScript(`(() => {
    Object.defineProperty(globalThis, "__CODEX_WEB_GPT_SURFACE_ID__", {
      value: ${encoded}, configurable: true, enumerable: false, writable: false,
    });
    document.documentElement.dataset.codexWebGptSurface = ${encoded};
  })()`, true);
}

function bindAiStudioTurnContents(host, tab) {
  const contents = tab.view.webContents;
  const shouldPublishUiState = () => host.window?.isVisible?.() !== false;
  contents.setWindowOpenHandler(({ url }) => {
    if (!allowedAiStudioNavigation(url)) {
      let parsed;
      try { parsed = new URL(url); } catch { return { action: "deny" }; }
      if (parsed.protocol === "https:" || parsed.protocol === "http:") void shell.openExternal(parsed.toString());
    }
    return { action: "deny" };
  });
  const restrictNavigation = (event, url, _inPlace, mainFrame) => {
    if (mainFrame === false || allowedAiStudioNavigation(url)) return;
    event.preventDefault();
  };
  contents.on("will-navigate", restrictNavigation);
  contents.on("will-redirect", restrictNavigation);
  contents.on("did-start-navigation", (_event, url, inPlace, mainFrame) => {
    if (!mainFrame) return;
    tab.url = url;
    tab.loading = true;
    if (!inPlace) tab.rendererReady = false;
    if (shouldPublishUiState()) host.publishState?.(host.snapshot());
  });
  contents.on("did-start-loading", () => {
    tab.loading = true;
    if (shouldPublishUiState()) host.publishState?.(host.snapshot());
  });
  contents.on("did-stop-loading", () => {
    tab.loading = false;
    tab.url = contents.getURL();
    if (shouldPublishUiState()) host.publishState?.(host.snapshot());
  });
  contents.on("did-finish-load", () => {
    tab.url = contents.getURL();
    tab.loading = false;
    tab.rendererReady = true;
    tab.bootstrapReady = allowedAiStudioNavigation(tab.url);
    host.syncViewVisibility();
    if (tab.initializingSurface) {
      if (shouldPublishUiState()) host.publishState?.(host.snapshot());
      return;
    }
    void markAiStudioTurnSurface(tab).then(
      () => {
        if (shouldPublishUiState()) host.publishState?.(host.snapshot());
      },
      error => {
        if (contents.isDestroyed?.() || contents.isLoadingMainFrame?.()) {
          host.logger?.warn?.("browser.ai_studio_surface_mark_deferred", {
            tabId: tab.id,
            traceId: tab.traceId,
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        tab.status = "error";
        tab.message = `AI Studio browser ownership failed: ${error instanceof Error ? error.message : String(error)}`;
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
    if (mainFrame) tab.url = url;
    if (shouldPublishUiState()) host.publishState?.(host.snapshot());
  });
  contents.on("did-fail-load", (_event, errorCode, errorDescription, url, mainFrame) => {
    if (!mainFrame || errorCode === -3) return;
    tab.url = url;
    tab.message = errorDescription;
    host.logger.error("browser.ai_studio_tab_navigation_failed", {
      tabId: tab.id, traceId: tab.traceId, errorCode, errorDescription, url,
    });
    host.removeTurnTab(tab, true);
  });
  contents.on("render-process-gone", (_event, details) => {
    tab.message = `AI Studio browser renderer stopped: ${details.reason}`;
    host.logger.error("browser.ai_studio_tab_renderer_gone", {
      tabId: tab.id, traceId: tab.traceId, reason: details.reason, exitCode: details.exitCode,
    });
    host.removeTurnTab(tab, true);
  });
  contents.on("unresponsive", () => host.logger.warn("browser.ai_studio_tab_unresponsive", {
    tabId: tab.id, traceId: tab.traceId,
  }));
  contents.on("responsive", () => host.logger.info("browser.ai_studio_tab_responsive", {
    tabId: tab.id, traceId: tab.traceId,
  }));
}

module.exports = {
  allowedAiStudioNavigation,
  bindAiStudioTurnContents,
  markAiStudioTurnSurface,
};

