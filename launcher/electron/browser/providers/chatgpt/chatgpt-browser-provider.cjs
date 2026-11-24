const { BaseBrowserProvider, sanitizeChromeUserAgent } = require("../base-browser-provider.cjs");
const {
  allowedChatGptNavigation,
  bindChatGptTurnContents,
  markChatGptTurnSurface,
} = require("./chatgpt-turn-surface.cjs");
const { ChatGptSmokeTester } = require("./chatgpt-smoke-tester.cjs");

const CHATGPT_ORIGIN = "https://chatgpt.com";
const CHATGPT_CHAT_URL = `${CHATGPT_ORIGIN}/`;
const CHATGPT_PARTITION = "persist:codex-web-chatgpt";
const CHATGPT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{7,128}$/i;
const CHATGPT_CONVERSATION_PATH_PATTERN = /^\/(?:g\/[^/]+\/)?c\/([^/]+)\/?$/i;
const CHATGPT_RESERVED_IDS = new Set([
  "new",
  "auth",
  "login",
  "c",
  "g",
  "share",
  "backend-api",
]);
const CHATGPT_SESSION_COOKIE_PREFIX = "__Secure-next-auth.session-token";
const MAX_CHATGPT_SURFACES = 8;
const MAX_PERSISTED_CHATGPT_BINDINGS = 256;

const CHATGPT_AUTH_HOSTS = new Set([
  "chatgpt.com",
  "auth.openai.com",
  "auth0.openai.com",
  "openai.com",
  "accounts.google.com",
  "appleid.apple.com",
  "login.live.com",
  "login.microsoftonline.com",
  "challenges.cloudflare.com",
]);

function normalizeChatGptConversationId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || CHATGPT_RESERVED_IDS.has(trimmed.toLowerCase())) return null;
  return CHATGPT_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function chatGptConversationUrl(conversationId) {
  const normalized = normalizeChatGptConversationId(conversationId);
  if (!normalized) throw new Error("ChatGPT conversation id is invalid");
  return `${CHATGPT_ORIGIN}/c/${normalized}`;
}

function parseChatGptConversationId(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.origin !== CHATGPT_ORIGIN || url.username || url.password) return null;
  const match = CHATGPT_CONVERSATION_PATH_PATTERN.exec(url.pathname);
  return normalizeChatGptConversationId(match?.[1]);
}

function isChatGptAuthCookieName(name) {
  if (typeof name !== "string") return false;
  return name === CHATGPT_SESSION_COOKIE_PREFIX
    || name.startsWith(`${CHATGPT_SESSION_COOKIE_PREFIX}.`);
}

function hasChatGptAuthSessionCookies(cookies) {
  if (!Array.isArray(cookies)) return false;
  return cookies.some((cookie) => (
    cookie
    && isChatGptAuthCookieName(cookie.name)
    && typeof cookie.value === "string"
    && cookie.value.length > 0
  ));
}

function isChatGptAuthOrAppUrl(value) {
  return typeof value === "string" && (
    value.includes("chatgpt.com")
    || value.includes("auth.openai.com")
    || value.includes("auth0.openai.com")
  );
}

function allowedChatGptAuthUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (
    parsed.hostname === "chatgpt.com"
    || parsed.hostname.endsWith(".chatgpt.com")
    || parsed.hostname === "openai.com"
    || parsed.hostname.endsWith(".openai.com")
  ) {
    return true;
  }
  return CHATGPT_AUTH_HOSTS.has(parsed.hostname);
}

/**
 * Browser provider cho ChatGPT Web (`chatgpt.com`) trong Electron Launcher.
 */
class ChatGptBrowserProvider extends BaseBrowserProvider {
  constructor({
    descriptorPath = null,
    partition = CHATGPT_PARTITION,
    smokeTester = new ChatGptSmokeTester(),
  } = {}) {
    super({
      id: "chatgpt",
      displayName: "ChatGPT",
      homeUrl: CHATGPT_CHAT_URL,
      origin: CHATGPT_ORIGIN,
      partition: partition || CHATGPT_PARTITION,
      maxSurfaces: MAX_CHATGPT_SURFACES,
      maxPersistedBindings: MAX_PERSISTED_CHATGPT_BINDINGS,
      smokeTitle: "ChatGPT",
      descriptorPath,
      supportsProfiles: true,
      usesExternalChromeLogin: true,
    });
    this.smokeTester = smokeTester;
  }

  partitionForProfile(profileId = this.activeProfileId) {
    const normalized = typeof profileId === "string" ? profileId.trim().toLowerCase() : "";
    if (!normalized || normalized === "default") {
      return this.basePartition;
    }
    return `${this.basePartition}-${normalized}`;
  }

  onPrimarySessionCreated(browserSession) {
    if (typeof browserSession?.getUserAgent !== "function" || typeof browserSession?.setUserAgent !== "function") {
      return;
    }
    const cleanUa = sanitizeChromeUserAgent(browserSession.getUserAgent());
    if (cleanUa) browserSession.setUserAgent(cleanUa);
  }

  normalizeConversationId(value) {
    return normalizeChatGptConversationId(value);
  }

  conversationUrl(conversationId) {
    return chatGptConversationUrl(conversationId);
  }

  parseConversationId(rawUrl) {
    return parseChatGptConversationId(rawUrl);
  }

  isAllowedNavigation(rawUrl) {
    return allowedChatGptNavigation(rawUrl);
  }

  markTurnSurface(contents, options) {
    return markChatGptTurnSurface(contents, options);
  }

  onBindTurnContents(contents, handlers) {
    return bindChatGptTurnContents(contents, handlers);
  }

  isAuthCookieDomain(domain) {
    if (typeof domain !== "string") return false;
    return domain.includes("chatgpt.com") || domain.includes("openai.com");
  }

  isAuthOrAppUrl(value) {
    return isChatGptAuthOrAppUrl(value);
  }

  allowedAuthUrl(rawUrl) {
    return allowedChatGptAuthUrl(rawUrl);
  }

  hasExternalAuthSessionCookies(cookies) {
    return hasChatGptAuthSessionCookies(cookies);
  }

  async hasAuthCookies(browserSession) {
    if (typeof browserSession?.cookies?.get !== "function") return null;
    try {
      const cookies = await browserSession.cookies.get({});
      const nowSeconds = Date.now() / 1000;
      return Array.isArray(cookies) && cookies.some((cookie) => (
        cookie
        && isChatGptAuthCookieName(cookie.name)
        && typeof cookie.value === "string"
        && cookie.value.length > 0
        && typeof cookie.domain === "string"
        && (cookie.domain.includes("chatgpt.com") || cookie.domain.includes("openai.com"))
        && (!Number.isFinite(cookie.expirationDate) || cookie.expirationDate > nowSeconds)
      ));
    } catch {
      return null;
    }
  }

  async probeAuthentication(contents) {
    return await contents.executeJavaScript(`(() => {
      const href = location.href;
      const isChatGpt = href.includes("chatgpt.com");
      const isAuth = href.includes("auth.openai.com")
        || href.includes("auth0.openai.com")
        || /^https:\\/\\/chatgpt\\.com\\/auth\\b/i.test(href);
      const composer = Boolean(
        document.querySelector('div.ProseMirror[data-composer-markdown][role="textbox"], #prompt-textarea')
      );
      const profileMenu = Boolean(document.querySelector('button[aria-label="Open profile menu"]'));
      const loginControl = Boolean(
        document.querySelector('[data-testid="login-button"], [data-testid="signup-button"], a[href*="/auth/login"]')
        || Array.from(document.querySelectorAll('button, a')).some((el) => {
          const text = (el.textContent || "").trim();
          return /^(?:log in|sign in|sign up)$/i.test(text);
        })
      );
      return {
        url: href,
        composer,
        profileMenu,
        loginControl,
        authenticated: isChatGpt && !isAuth && !loginControl && (profileMenu || composer),
        readyState: document.readyState,
      };
    })()`, true).catch(() => {
      const liveUrl = contents.getURL() || "";
      const isChatGpt = liveUrl.includes("chatgpt.com");
      const isAuth = liveUrl.includes("auth.openai.com")
        || liveUrl.includes("auth0.openai.com")
        || /\/auth\b/i.test(liveUrl);
      return {
        url: liveUrl,
        composer: false,
        profileMenu: false,
        loginControl: isAuth,
        authenticated: isChatGpt && !isAuth,
        readyState: "complete",
      };
    });
  }

  async runSmokeTest(context) {
    return await this.smokeTester.run({
      ...context,
      homeUrl: this.homeUrl,
      probeAuthentication: (contents) => this.probeAuthentication(contents),
    });
  }
}

module.exports = {
  CHATGPT_AUTH_HOSTS,
  CHATGPT_CHAT_URL,
  CHATGPT_ORIGIN,
  CHATGPT_PARTITION,
  ChatGptBrowserProvider,
  allowedChatGptAuthUrl,
  chatGptConversationUrl,
  hasChatGptAuthSessionCookies,
  isChatGptAuthCookieName,
  isChatGptAuthOrAppUrl,
  normalizeChatGptConversationId,
  parseChatGptConversationId,
};
