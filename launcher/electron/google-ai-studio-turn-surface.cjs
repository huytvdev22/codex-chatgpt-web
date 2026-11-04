const { shell } = require("electron");
const { GOOGLE_AI_STUDIO_HOME_URL } = require("./google-ai-studio-surface-manager.cjs");

function javaScriptLiteral(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function allowedGoogleAIStudioNavigation(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return parsed.hostname === "aistudio.google.com"
    || parsed.hostname === "accounts.google.com"
    || parsed.hostname.endsWith(".google.com");
}

function isGoogleAIStudioLoginRedirect(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  return parsed.hostname === "accounts.google.com";
}

function isAbortedNavigationError(error) {
  const code = error && typeof error === "object" ? error.code : null;
  const errno = error && typeof error === "object" ? error.errno : null;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return code === "ERR_ABORTED" || errno === -3 || message.includes("ERR_ABORTED");
}

async function markGoogleAIStudioTurnSurface(tab) {
  const contents = tab?.view?.webContents;
  if (!contents || contents.isDestroyed()) {
    throw new Error("Google AI Studio turn browser surface was closed before ownership could be marked");
  }
  const literal = javaScriptLiteral(tab.surfaceId);
  await contents.executeJavaScript(`(() => {
    window.__CODEX_WEB_GPT_SURFACE_ID__ = ${literal};
    document.documentElement?.setAttribute("data-codex-web-gpt-surface", ${literal});
    return true;
  })()`, true);
}

function bindGoogleAIStudioTurnContents(host, tab) {
  const contents = tab.view.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    let parsed;
    try { parsed = new URL(url); } catch { return { action: "deny" }; }
    if (parsed.protocol === "https:" || parsed.protocol === "http:") void shell.openExternal(parsed.toString());
    return { action: "deny" };
  });
  const handleNavigation = (event, url, _inPlace, mainFrame) => {
    if (mainFrame === false) return;
    if (allowedGoogleAIStudioNavigation(url)) {
      if (isGoogleAIStudioLoginRedirect(url)) {
        tab.authenticationRequired = true;
        tab.message = "Sign in to Google AI Studio in the Home tab";
        host.reauthenticationRequired = true;
      }
      return;
    }
    event.preventDefault();
  };
  contents.on("will-navigate", handleNavigation);
  contents.on("will-redirect", handleNavigation);
  contents.on("did-start-navigation", (_event, url, inPlace, mainFrame) => {
    if (!mainFrame) return;
    tab.url = url;
    tab.loading = true;
    if (!inPlace) {
      tab.rendererReady = false;
      tab.deviceEmulationDirty = true;
    }
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
  contents.on("page-title-updated", (_event, title) => {
    tab.pageTitle = title || "Google AI Studio";
    host.publishState?.(host.snapshot());
  });
  contents.on("did-finish-load", () => {
    tab.url = contents.getURL() || GOOGLE_AI_STUDIO_HOME_URL;
    tab.pageTitle = contents.getTitle() || "Google AI Studio";
    tab.loading = false;
    tab.bootstrapReady = allowedGoogleAIStudioNavigation(tab.url);
    tab.rendererReady = true;
    tab.deviceEmulationDirty = true;
    host.syncTurnDeviceEmulation?.(tab);
    if (!tab.initializingSurface) {
      void markGoogleAIStudioTurnSurface(tab).catch((error) => {
        if (host.turnTabs.get(tab.id) !== tab || contents.isDestroyed()) return;
        host.logger?.warn?.("browser.google_ai_studio_turn_surface_mark_failed", {
          tabId: tab.id,
          traceId: tab.traceId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
    host.publishState?.(host.snapshot());
  });
  contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || isAbortedNavigationError({ code: errorCode, errno: errorCode, message: errorDescription })) {
      return;
    }
    tab.loading = false;
    tab.url = validatedURL || contents.getURL();
    tab.status = "error";
    tab.message = `Google AI Studio failed to load (${errorDescription || errorCode})`;
    host.publishState?.(host.snapshot());
  });
  contents.on("render-process-gone", (_event, details) => {
    tab.loading = false;
    tab.rendererReady = false;
    tab.deviceEmulationViewport = null;
    tab.deviceEmulationDirty = true;
    tab.status = "error";
    tab.message = `Google AI Studio tab exited (${details?.reason || "crashed"})`;
    host.publishState?.(host.snapshot());
  });
}

module.exports = {
  allowedGoogleAIStudioNavigation,
  bindGoogleAIStudioTurnContents,
  markGoogleAIStudioTurnSurface,
};

