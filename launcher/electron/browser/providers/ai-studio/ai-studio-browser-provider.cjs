const { BaseBrowserProvider } = require("../base-browser-provider.cjs");
const {
  allowedAiStudioNavigation,
  bindAiStudioTurnContents,
  markAiStudioTurnSurface,
} = require("./ai-studio-turn-surface.cjs");
const { AiStudioSmokeTester } = require("./ai-studio-smoke-tester.cjs");

const AI_STUDIO_ORIGIN = "https://aistudio.google.com";
const AI_STUDIO_CHAT_URL = `${AI_STUDIO_ORIGIN}/prompts/new_chat?model=gemini-4-hydrogen`;
const AI_STUDIO_PARTITION = "persist:codex-web-aistudio";
const AI_STUDIO_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_AI_STUDIO_SURFACES = 3;
const MAX_PERSISTED_AI_STUDIO_BINDINGS = 256;

const AI_STUDIO_AUTH_HOSTS = new Set([
  "aistudio.google.com",
  "accounts.google.com",
  "accounts.youtube.com",
  "myaccount.google.com",
  "gds.google.com",
]);

function normalizeAiStudioConversationId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "new_chat") return null;
  return AI_STUDIO_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function aiStudioConversationUrl(conversationId) {
  const normalized = normalizeAiStudioConversationId(conversationId);
  if (!normalized) throw new Error("AI Studio conversation id is invalid");
  return `${AI_STUDIO_ORIGIN}/prompts/${normalized}`;
}

function parseAiStudioConversationId(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.origin !== AI_STUDIO_ORIGIN || url.username || url.password) return null;
  const match = url.pathname.match(/^\/prompts\/([^/]+)\/?$/);
  return normalizeAiStudioConversationId(match?.[1]);
}

function isAiStudioAuthOrAppUrl(value) {
  return typeof value === "string" && (
    value.includes("aistudio.google.com")
    || value.includes("accounts.google.com")
    || value.includes("myaccount.google.com")
  );
}

function allowedAiStudioAuthUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (
    parsed.hostname === "aistudio.google.com"
    || parsed.hostname.endsWith(".aistudio.google.com")
    || parsed.hostname.endsWith(".google.com")
  ) {
    return true;
  }
  return AI_STUDIO_AUTH_HOSTS.has(parsed.hostname);
}

/**
 * Browser provider cho Google AI Studio (`aistudio.google.com`) trong Electron Launcher.
 */
class AiStudioBrowserProvider extends BaseBrowserProvider {
  constructor({ descriptorPath = null, smokeTester = new AiStudioSmokeTester() } = {}) {
    super({
      id: "ai-studio",
      displayName: "Google AI Studio",
      homeUrl: AI_STUDIO_CHAT_URL,
      origin: AI_STUDIO_ORIGIN,
      partition: AI_STUDIO_PARTITION,
      maxSurfaces: MAX_AI_STUDIO_SURFACES,
      maxPersistedBindings: MAX_PERSISTED_AI_STUDIO_BINDINGS,
      smokeTitle: "Google AI Studio",
      descriptorPath,
    });
    this.smokeTester = smokeTester;
  }

  normalizeConversationId(value) {
    return normalizeAiStudioConversationId(value);
  }

  conversationUrl(conversationId) {
    return aiStudioConversationUrl(conversationId);
  }

  parseConversationId(rawUrl) {
    return parseAiStudioConversationId(rawUrl);
  }

  isAllowedNavigation(rawUrl) {
    return allowedAiStudioNavigation(rawUrl);
  }

  markTurnSurface(contents, options) {
    return markAiStudioTurnSurface(contents, options);
  }

  onBindTurnContents(contents, handlers) {
    return bindAiStudioTurnContents(contents, handlers);
  }

  isAuthCookieDomain(domain) {
    if (typeof domain !== "string") return false;
    return domain.includes("google.com") || domain.includes("aistudio.google.com");
  }

  isAuthOrAppUrl(value) {
    return isAiStudioAuthOrAppUrl(value);
  }

  allowedAuthUrl(rawUrl) {
    return allowedAiStudioAuthUrl(rawUrl);
  }

  async probeAuthentication(contents) {
    return await contents.executeJavaScript(`(() => {
      const href = location.href;
      const isAiStudio = href.includes("aistudio.google.com");
      const isLogin = href.includes("accounts.google.com");
      const composer = Boolean(document.querySelector('textarea[aria-label="Enter a prompt"]'));
      const signInButton = Boolean(document.querySelector('a[href*="accounts.google.com"], button[aria-label*="Sign in" i]'));
      return {
        url: href,
        composer,
        authenticated: isAiStudio && !isLogin && (composer || !signInButton),
        readyState: document.readyState,
      };
    })()`, true).catch(() => {
      const liveUrl = contents.getURL() || "";
      const isAiStudio = liveUrl.includes("aistudio.google.com");
      const isLogin = liveUrl.includes("accounts.google.com");
      return {
        url: liveUrl,
        composer: false,
        authenticated: isAiStudio && !isLogin,
        readyState: "complete",
      };
    });
  }

  async runSmokeTest(context) {
    return await this.smokeTester.run({
      ...context,
      homeUrl: this.homeUrl,
    });
  }
}

module.exports = {
  AI_STUDIO_AUTH_HOSTS,
  AI_STUDIO_CHAT_URL,
  AI_STUDIO_ORIGIN,
  AI_STUDIO_PARTITION,
  AiStudioBrowserProvider,
  aiStudioConversationUrl,
  allowedAiStudioAuthUrl,
  isAiStudioAuthOrAppUrl,
  normalizeAiStudioConversationId,
  parseAiStudioConversationId,
};

