const { shell } = require("electron");

const ALLOWED_QWEN_HOSTS = new Set([
  "chat.qwen.ai",
  "qwen.ai",
  "account.aliyun.com",
  "signin.aliyun.com",
]);

function allowedQwenNavigation(rawUrl) {
  let url;
  try { url = new URL(rawUrl); }
  catch { return false; }
  return url.protocol === "https:"
    && (ALLOWED_QWEN_HOSTS.has(url.hostname)
      || url.hostname.endsWith(".qwen.ai")
      || url.hostname.endsWith(".aliyun.com"));
}

async function markQwenTurnSurface(tab) {
  const contents = tab?.view?.webContents;
  if (!contents || contents.isDestroyed()) {
    throw new Error("Qwen turn browser closed before ownership was established");
  }
  const encoded = JSON.stringify(tab.surfaceId);
  await contents.executeJavaScript(`(() => {
    Object.defineProperty(globalThis, "__CODEX_WEB_GPT_SURFACE_ID__", {
      value: ${encoded}, configurable: true, enumerable: false, writable: false,
    });
    document.documentElement.dataset.codexWebGptSurface = ${encoded};
  })()`, true).catch(() => {});
}

/** Bind only Qwen-safe navigation and lifecycle behavior; no ChatGPT DOM hooks. */
function bindQwenTurnContents(host, tab) {
  const contents = tab.view.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (!allowedQwenNavigation(url)) {
      let parsed;
      try { parsed = new URL(url); } catch { return { action: "deny" }; }
      if (parsed.protocol === "https:" || parsed.protocol === "http:") void shell.openExternal(parsed.toString());
    }
    return { action: "deny" };
  });
  const restrictNavigation = (event, url, _inPlace, mainFrame) => {
    if (mainFrame === false || allowedQwenNavigation(url)) return;
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
    tab.bootstrapReady = allowedQwenNavigation(tab.url);
    host.syncViewVisibility();
    if (host.browserInteractionMode() !== "automatic" || tab.initializingSurface) {
      host.publishState?.(host.snapshot());
      return;
    }
    void markQwenTurnSurface(tab).then(
      () => host.publishState?.(host.snapshot()),
      error => {
        tab.status = "error";
        tab.message = `Qwen browser ownership failed: ${error instanceof Error ? error.message : String(error)}`;
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
    host.logger.error("browser.qwen_tab_navigation_failed", {
      tabId: tab.id, traceId: tab.traceId, errorCode, errorDescription, url,
    });
    host.removeTurnTab(tab, true);
  });
  contents.on("render-process-gone", (_event, details) => {
    tab.message = `Qwen browser renderer stopped: ${details.reason}`;
    host.logger.error("browser.qwen_tab_renderer_gone", {
      tabId: tab.id, traceId: tab.traceId, reason: details.reason, exitCode: details.exitCode,
    });
    host.removeTurnTab(tab, true);
  });
}

module.exports = {
  allowedQwenNavigation,
  bindQwenTurnContents,
  markQwenTurnSurface,
};
