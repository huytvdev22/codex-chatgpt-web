const { BaseBrowserProvider } = require("../base-browser-provider.cjs");
const { allowedM365Navigation, bindM365TurnContents, markM365TurnSurface } = require("./m365-turn-surface.cjs");
const { M365SmokeTester } = require("./m365-smoke-tester.cjs");

const M365_CHAT_URL = "https://m365.cloud.microsoft/chat";
const M365_ORIGIN = "https://m365.cloud.microsoft";
const M365_ALLOWED_ORIGINS = new Set([
  "https://m365.cloud.microsoft",
  "https://copilot.cloud.microsoft",
]);
const M365_PARTITION = "persist:codex-m365-copilot";
const M365_CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_M365_SURFACES = 3;
const MAX_PERSISTED_M365_BINDINGS = 256;
const M365_AUTH_SETTLE_TIMEOUT_MS = 8_000;
const M365_AUTH_SETTLE_POLL_MS = 200;
const M365_INTERACTIVE_LOGIN_STABLE_MS = 1_500;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const M365_AUTH_PROVIDER_HOSTS = new Set([
  "accounts.google.com",
  "login.microsoftonline.com",
  "account.activedirectory.windowsazure.com",
  "login.live.com",
  "mysignins.microsoft.com",
  "aadcdn.msauth.net",
  "aadcdn.msftauth.net",
  "m365.cloud.microsoft",
  "copilot.cloud.microsoft",
  "appleid.apple.com",
  "idmsa.apple.com",
]);

function normalizeM365ConversationId(value) {
  return typeof value === "string" && M365_CONVERSATION_ID_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

function m365ConversationUrl(conversationId) {
  const normalized = normalizeM365ConversationId(conversationId);
  if (!normalized) throw new Error("M365 conversation id is invalid");
  return `${M365_CHAT_URL}/conversation/${normalized}`;
}

function parseM365ConversationId(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!M365_ALLOWED_ORIGINS.has(url.origin) || url.username || url.password) return null;
  const match = url.pathname.match(/^\/chat\/conversation\/([^/]+)\/?$/i);
  return normalizeM365ConversationId(match?.[1]);
}

function isMicrosoftLoginUrl(value) {
  if (typeof value !== "string") return false;
  return value.includes("login.microsoftonline.com")
    || value.includes("login.live.com")
    || value.includes("account.activedirectory.windowsazure.com")
    || /^https:\/\/[^/]*\.cloud\.microsoft\/login(?:[/?#]|$)/i.test(value);
}

function isM365AppUrl(value) {
  if (typeof value !== "string") return false;
  return (value.includes("m365.cloud.microsoft") || value.includes("copilot.cloud.microsoft"))
    && !isMicrosoftLoginUrl(value);
}

function isMicrosoftAuthOrAppUrl(value) {
  return typeof value === "string" && (
    value.includes("m365.cloud.microsoft")
    || value.includes("copilot.cloud.microsoft")
    || value.includes("login.microsoftonline.com")
    || value.includes("login.live.com")
    || value.includes("account.activedirectory.windowsazure.com")
  );
}

function allowedM365AuthUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname.endsWith(".cloud.microsoft")
    || parsed.hostname.endsWith(".microsoft.com")) {
    return true;
  }
  return M365_AUTH_PROVIDER_HOSTS.has(parsed.hostname);
}

/**
 * Provider cụ thể cho Microsoft 365 Copilot, kế thừa từ BaseBrowserProvider.
 */
class M365BrowserProvider extends BaseBrowserProvider {
  constructor({
    descriptorPath = null,
    partition = M365_PARTITION,
    smokeTester = new M365SmokeTester(),
  } = {}) {
    super({
      id: "m365",
      displayName: "M365 Copilot",
      homeUrl: M365_CHAT_URL,
      origin: M365_ORIGIN,
      partition: partition || M365_PARTITION,
      maxSurfaces: MAX_M365_SURFACES,
      maxPersistedBindings: MAX_PERSISTED_M365_BINDINGS,
      smokeTitle: "M365 Copilot",
      descriptorPath,
    });
    this.smokeTester = smokeTester;
  }

  normalizeConversationId(value) {
    return normalizeM365ConversationId(value);
  }

  conversationUrl(conversationId) {
    return m365ConversationUrl(conversationId);
  }

  parseConversationId(rawUrl) {
    return parseM365ConversationId(rawUrl);
  }

  isAllowedNavigation(rawUrl) {
    return allowedM365Navigation(rawUrl);
  }

  markTurnSurface(contents, options) {
    return markM365TurnSurface(contents, options);
  }

  onBindTurnContents(contents, handlers) {
    return bindM365TurnContents(contents, handlers);
  }

  isAuthCookieDomain(domain) {
    if (typeof domain !== "string") return false;
    return domain.includes("microsoft")
      || domain.includes("cloud.microsoft")
      || domain.includes("live.com")
      || domain.includes("google.com");
  }

  isAuthOrAppUrl(value) {
    return isMicrosoftAuthOrAppUrl(value);
  }

  allowedAuthUrl(rawUrl) {
    return allowedM365AuthUrl(rawUrl);
  }

  async probeAuthentication(contents) {
    return await contents.executeJavaScript(`(() => {
      const href = location.href;
      const isM365 = href.includes("m365.cloud.microsoft") || href.includes("copilot.cloud.microsoft");
      const isLogin = href.includes("login.microsoftonline.com")
        || href.includes("login.live.com")
        || href.includes("account.activedirectory.windowsazure.com")
        || /^https:\\/\\/[^/]*\\.cloud\\.microsoft\\/login(?:[/?#]|$)/i.test(href);
      const composer = Boolean(document.querySelector("#m365-chat-editor-target-element, div[contenteditable='true'], [role='textbox']"));
      return {
        url: href,
        composer,
        authenticated: isM365 && !isLogin,
        readyState: document.readyState,
      };
    })()`, true).catch(() => {
      const liveUrl = contents.getURL() || "";
      return {
        url: liveUrl,
        composer: false,
        authenticated: isM365AppUrl(liveUrl),
        readyState: "complete",
      };
    });
  }

  async waitForAuthenticationSettle(contents, timeoutMs = M365_AUTH_SETTLE_TIMEOUT_MS) {
    if (!contents || contents.isDestroyed?.() || typeof contents.getURL !== "function") return;
    const canCheckLoading = typeof contents.isLoading === "function";
    const initialUrl = contents.getURL() || "";
    if (!canCheckLoading && !isMicrosoftLoginUrl(initialUrl)) return;

    const deadline = Date.now() + timeoutMs;
    const pollMs = Math.min(M365_AUTH_SETTLE_POLL_MS, Math.max(10, Math.floor(timeoutMs / 3)));
    const stableLimitMs = Math.min(M365_INTERACTIVE_LOGIN_STABLE_MS, timeoutMs);
    let lastLoginUrl = "";
    let interactiveSince = null;

    while (Date.now() < deadline) {
      if (contents.isDestroyed?.()) return;
      const currentUrl = contents.getURL() || "";
      const loading = canCheckLoading ? contents.isLoading() : false;

      if (isM365AppUrl(currentUrl) && !loading) {
        return;
      }

      if (isMicrosoftLoginUrl(currentUrl) && !loading && typeof contents.executeJavaScript === "function") {
        if (currentUrl !== lastLoginUrl) {
          lastLoginUrl = currentUrl;
          interactiveSince = null;
        }
        const interactive = await contents.executeJavaScript(`(() => {
          if (document.readyState !== "complete") return false;
          return Boolean(document.querySelector(
            'input[name="loginfmt"]:not([type="hidden"]), input[name="passwd"]:not([type="hidden"]), input[name="otc"]:not([type="hidden"]), input[type="password"]:not([type="hidden"]), #tilesHolder [data-test-id], [data-testid="signin-prompt"]'
          ));
        })()`, true).catch(() => false);
        if (interactive) {
          interactiveSince ??= Date.now();
          if (Date.now() - interactiveSince >= stableLimitMs) return;
        } else {
          interactiveSince = null;
        }
      } else {
        interactiveSince = null;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(pollMs, remaining));
    }
  }

  async runSmokeTest(context) {
    return await this.smokeTester.run({
      ...context,
      homeUrl: this.homeUrl,
    });
  }
}

module.exports = {
  MAX_M365_SURFACES,
  MAX_PERSISTED_M365_BINDINGS,
  M365_AUTH_PROVIDER_HOSTS,
  M365_CHAT_URL,
  M365_ORIGIN,
  M365_PARTITION,
  M365BrowserProvider,
  allowedM365AuthUrl,
  isMicrosoftAuthOrAppUrl,
  m365ConversationUrl,
  normalizeM365ConversationId,
  parseM365ConversationId,
};

