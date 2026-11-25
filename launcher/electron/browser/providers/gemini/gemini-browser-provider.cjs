const { BaseBrowserProvider, sanitizeChromeUserAgent } = require("../base-browser-provider.cjs");
const {
  GOOGLE_AUTH_COOKIE_NAMES,
  hasGoogleAuthSessionCookies,
} = require("../../external-chrome-login-service.cjs");
const {
  allowedGeminiNavigation,
  bindGeminiTurnContents,
  markGeminiTurnSurface,
} = require("./gemini-turn-surface.cjs");
const { GeminiSmokeTester } = require("./gemini-smoke-tester.cjs");

const GEMINI_ORIGIN = "https://gemini.google.com";
const GEMINI_CHAT_URL = `${GEMINI_ORIGIN}/app`;
const GEMINI_PARTITION = "persist:codex-web-gemini";
const GEMINI_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;
const GEMINI_CONVERSATION_PATH_PATTERN = /^\/(?:u\/\d+\/)?app\/([^/]+)\/?$/i;
const GEMINI_RESERVED_IDS = new Set([
  "new",
  "download",
  "extensions",
  "gems",
  "settings",
  "mystuff",
  "saved-info",
  "updates",
  "faq",
]);
const MAX_GEMINI_SURFACES = 8;
const MAX_PERSISTED_GEMINI_BINDINGS = 256;

const GEMINI_AUTH_HOSTS = new Set([
  "gemini.google.com",
  "accounts.google.com",
  "accounts.youtube.com",
  "myaccount.google.com",
  "gds.google.com",
  "consent.google.com",
]);

function normalizeGeminiConversationId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || GEMINI_RESERVED_IDS.has(trimmed.toLowerCase())) return null;
  return GEMINI_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function geminiConversationUrl(conversationId) {
  const normalized = normalizeGeminiConversationId(conversationId);
  if (!normalized) throw new Error("Gemini conversation id is invalid");
  return `${GEMINI_ORIGIN}/app/${normalized}`;
}

function parseGeminiConversationId(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.origin !== GEMINI_ORIGIN || url.username || url.password) return null;
  const match = GEMINI_CONVERSATION_PATH_PATTERN.exec(url.pathname);
  return normalizeGeminiConversationId(match?.[1]);
}

function isGeminiAuthOrAppUrl(value) {
  return typeof value === "string" && (
    value.includes("gemini.google.com")
    || value.includes("accounts.google.com")
    || value.includes("myaccount.google.com")
  );
}

function allowedGeminiAuthUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (
    parsed.hostname === "gemini.google.com"
    || parsed.hostname.endsWith(".gemini.google.com")
    || parsed.hostname.endsWith(".google.com")
  ) {
    return true;
  }
  return GEMINI_AUTH_HOSTS.has(parsed.hostname);
}

/**
 * Browser provider cho Gemini Web (`gemini.google.com`) trong Electron Launcher.
 */
class GeminiBrowserProvider extends BaseBrowserProvider {
  constructor({
    descriptorPath = null,
    partition = GEMINI_PARTITION,
    smokeTester = new GeminiSmokeTester(),
  } = {}) {
    super({
      id: "gemini",
      displayName: "Gemini",
      homeUrl: GEMINI_CHAT_URL,
      origin: GEMINI_ORIGIN,
      partition: partition || GEMINI_PARTITION,
      maxSurfaces: MAX_GEMINI_SURFACES,
      maxPersistedBindings: MAX_PERSISTED_GEMINI_BINDINGS,
      smokeTitle: "Gemini",
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
    return normalizeGeminiConversationId(value);
  }

  conversationUrl(conversationId) {
    return geminiConversationUrl(conversationId);
  }

  parseConversationId(rawUrl) {
    return parseGeminiConversationId(rawUrl);
  }

  isAllowedNavigation(rawUrl) {
    return allowedGeminiNavigation(rawUrl);
  }

  markTurnSurface(contents, options) {
    return markGeminiTurnSurface(contents, options);
  }

  onBindTurnContents(contents, handlers) {
    return bindGeminiTurnContents(contents, handlers);
  }

  isAuthCookieDomain(domain) {
    if (typeof domain !== "string") return false;
    return domain.includes("google.com") || domain.includes("gemini.google.com");
  }

  hasExternalAuthSessionCookies(cookies) {
    return hasGoogleAuthSessionCookies(cookies);
  }

  isAuthOrAppUrl(value) {
    return isGeminiAuthOrAppUrl(value);
  }

  allowedAuthUrl(rawUrl) {
    return allowedGeminiAuthUrl(rawUrl);
  }

  async hasAuthCookies(browserSession) {
    if (typeof browserSession?.cookies?.get !== "function") return null;
    try {
      const cookies = await browserSession.cookies.get({});
      const nowSeconds = Date.now() / 1000;
      return Array.isArray(cookies) && cookies.some((cookie) => (
        cookie
        && typeof cookie.name === "string"
        && GOOGLE_AUTH_COOKIE_NAMES.has(cookie.name)
        && typeof cookie.value === "string"
        && cookie.value.length > 0
        && typeof cookie.domain === "string"
        && cookie.domain.includes("google.com")
        && (!Number.isFinite(cookie.expirationDate) || cookie.expirationDate > nowSeconds)
      ));
    } catch {
      return null;
    }
  }

  async probeAuthentication(contents) {
    return await contents.executeJavaScript(`(() => {
      const href = location.href;
      const isGemini = href.includes("gemini.google.com");
      const isLogin = href.includes("accounts.google.com");
      const composer = Boolean(
        document.querySelector('rich-textarea .ql-editor[contenteditable="true"], div.ql-editor[contenteditable="true"][role="textbox"], [role="textbox"][contenteditable="true"]')
      );
      const accountControl = Boolean(
        document.querySelector('a[href*="accounts.google.com/SignOutOptions"], a[aria-label*="Google Account" i], img[alt*="Google Account" i], button[aria-label*="Google Account" i]')
      );
      const signInButton = Boolean(
        document.querySelector('a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/InteractiveLogin"], a[href*="accounts.google.com/v3/signin"], a[aria-label*="Sign in" i], button[aria-label*="Sign in" i]')
        || Array.from(document.querySelectorAll('a[href*="accounts.google.com"]:not([href*="SignOutOptions"]), button')).some((el) => {
          const text = (el.textContent || "").trim();
          return /^(?:sign in|log in|đăng nhập)$/i.test(text);
        })
      );
      return {
        url: href,
        composer,
        signInButton,
        accountControl,
        authenticated: isGemini && !isLogin && !signInButton && (composer || accountControl),
        readyState: document.readyState,
      };
    })()`, true).catch(() => {
      const liveUrl = contents.getURL() || "";
      const isGemini = liveUrl.includes("gemini.google.com");
      const isLogin = liveUrl.includes("accounts.google.com");
      return {
        url: liveUrl,
        composer: false,
        signInButton: isLogin,
        accountControl: false,
        authenticated: isGemini && !isLogin,
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
  GEMINI_AUTH_HOSTS,
  GEMINI_CHAT_URL,
  GEMINI_ORIGIN,
  GEMINI_PARTITION,
  GeminiBrowserProvider,
  allowedGeminiAuthUrl,
  geminiConversationUrl,
  isGeminiAuthOrAppUrl,
  normalizeGeminiConversationId,
  parseGeminiConversationId,
};
