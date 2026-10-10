const { shell } = require("electron");

const ALLOWED_M365_HOSTS = new Set([
  "m365.cloud.microsoft",
  "login.microsoftonline.com",
  "login.live.com",
  "account.activedirectory.windowsazure.com",
]);

function allowedM365Navigation(rawUrl) {
  let url;
  try { url = new URL(rawUrl); }
  catch { return false; }
  return url.protocol === "https:"
    && (ALLOWED_M365_HOSTS.has(url.hostname)
      || url.hostname.endsWith(".m365.cloud.microsoft")
      || url.hostname.endsWith(".microsoft.com"));
}

async function markM365TurnSurface(tab) {
  const contents = tab?.view?.webContents;
  if (!contents || contents.isDestroyed()) {
    throw new Error("M365 turn browser closed before ownership was established");
  }
  const encoded = JSON.stringify(tab.surfaceId);
  await contents.executeJavaScript(`(() => {
    Object.defineProperty(globalThis, "__CODEX_WEB_GPT_SURFACE_ID__", {
      value: ${encoded}, configurable: true, enumerable: false, writable: false,
    });
    document.documentElement.dataset.codexWebGptSurface = ${encoded};
  })()`, true);
}

/** Bind only M365-safe navigation and lifecycle behavior; no ChatGPT DOM hooks. */
function bindM365TurnContents(host, tab) {
  const contents = tab.view.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (!allowedM365Navigation(url)) {
      let parsed;
      try { parsed = new URL(url); } catch { return { action: "deny" }; }
      if (parsed.protocol === "https:" || parsed.protocol === "http:") void shell.openExternal(parsed.toString());
    }
    return { action: "deny" };
  });
  const restrictNavigation = (event, url, _inPlace, mainFrame) => {
    if (mainFrame === false || allowedM365Navigation(url)) return;
    event.preventDefault();
  };
  contents.on("will-navigate", restrictNavigation);
  contents.on("will-redirect", restrictNavigation);
  contents.on("did-start-navigation", (_event, url, inPlace, mainFrame) => {
    if (!mainFrame) return;
    tab.url = url;
    tab.loading = true;
    if (!inPlace) tab.rendererReady = false;
    host.publishState?.(host.snapshot());
  });
  contents.on("did-start-loading", () => {
    tab.loading = true;
    host.publishState?.(host.snapshot());
  });
  contents.on("did-stop-loading", () => {
    tab.loading = false;
    tab.url = contents.getURL();
    host.publishState?.(host.snapshot());
  });
  contents.on("did-finish-load", () => {
    tab.url = contents.getURL();
    tab.loading = false;
    tab.rendererReady = true;
    tab.bootstrapReady = allowedM365Navigation(tab.url);
    host.syncViewVisibility();
    if (host.browserInteractionMode() !== "automatic" || tab.initializingSurface) {
      host.publishState?.(host.snapshot());
      return;
    }
    void markM365TurnSurface(tab).then(
      () => host.publishState?.(host.snapshot()),
      error => {
        tab.status = "error";
        tab.message = `M365 browser ownership failed: ${error instanceof Error ? error.message : String(error)}`;
        host.syncPowerSaveBlocker();
        host.publishState?.(host.snapshot());
      },
    );
  });
  contents.on("page-title-updated", (_event, title) => {
    if (host.browserInteractionMode() !== "automatic") return;
    if (typeof title === "string" && title.trim()) tab.pageTitle = title.trim();
    host.publishState?.(host.snapshot());
  });
  contents.on("did-navigate-in-page", (_event, url, mainFrame) => {
    if (mainFrame) tab.url = url;
    host.publishState?.(host.snapshot());
  });
  contents.on("did-fail-load", (_event, errorCode, errorDescription, url, mainFrame) => {
    if (!mainFrame || errorCode === -3) return;
    tab.url = url;
    tab.message = errorDescription;
    host.logger.error("browser.m365_tab_navigation_failed", {
      tabId: tab.id, traceId: tab.traceId, errorCode, errorDescription, url,
    });
    host.removeTurnTab(tab, true);
  });
  contents.on("render-process-gone", (_event, details) => {
    tab.message = `M365 browser renderer stopped: ${details.reason}`;
    host.logger.error("browser.m365_tab_renderer_gone", {
      tabId: tab.id, traceId: tab.traceId, reason: details.reason, exitCode: details.exitCode,
    });
    host.removeTurnTab(tab, true);
  });
  contents.on("unresponsive", () => host.logger.warn("browser.m365_tab_unresponsive", {
    tabId: tab.id, traceId: tab.traceId,
  }));
  contents.on("responsive", () => host.logger.info("browser.m365_tab_responsive", {
    tabId: tab.id, traceId: tab.traceId,
  }));
}

module.exports = {
  allowedM365Navigation,
  bindM365TurnContents,
  markM365TurnSurface,
};
