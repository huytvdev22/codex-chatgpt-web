"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CHROME_STOP_TIMEOUT_MS = 5_000;
const GOOGLE_AUTH_COOKIE_NAMES = new Set([
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "__Secure-1PSID",
  "__Secure-3PSID",
]);

function resolveChromeExecutablePath(
  platform = process.platform,
  env = process.env,
  existsFn = fs.existsSync,
) {
  const candidates = [];
  if (platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
    );
  } else if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
    for (const root of roots) {
      candidates.push(path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    );
  }

  for (const candidate of candidates) {
    if (candidate && existsFn(candidate)) {
      return candidate;
    }
  }
  return null;
}

function mapSameSite(sameSite) {
  if (sameSite === "Strict") return "strict";
  if (sameSite === "Lax") return "lax";
  if (sameSite === "None") return "no_restriction";
  return "unspecified";
}

function toElectronCookieDetails(cookie) {
  if (!cookie || typeof cookie !== "object") return null;
  const name = typeof cookie.name === "string" ? cookie.name : "";
  const value = typeof cookie.value === "string" ? cookie.value : null;
  const rawDomain = typeof cookie.domain === "string" ? cookie.domain.trim() : "";
  if (!name || value === null || !rawDomain) return null;

  const cleanHost = rawDomain.replace(/^\.+/, "");
  if (!cleanHost) return null;

  const isHostPrefix = name.startsWith("__Host-");
  const isSecurePrefix = name.startsWith("__Secure-");
  const sameSite = mapSameSite(cookie.sameSite);
  const secure = Boolean(cookie.secure) || sameSite === "no_restriction" || isHostPrefix || isSecurePrefix;
  const cookiePath = isHostPrefix
    ? "/"
    : (typeof cookie.path === "string" && cookie.path.startsWith("/") ? cookie.path : "/");
  const protocol = secure ? "https" : "http";

  const details = {
    url: `${protocol}://${cleanHost}${cookiePath}`,
    name,
    value,
    path: cookiePath,
    secure,
    httpOnly: Boolean(cookie.httpOnly),
    sameSite,
  };

  if (!isHostPrefix && rawDomain.startsWith(".")) {
    details.domain = rawDomain;
  }
  if (Number.isFinite(cookie.expires) && cookie.expires > 0) {
    details.expirationDate = cookie.expires;
  }
  return details;
}

function hasGoogleAuthSessionCookies(cookies) {
  if (!Array.isArray(cookies)) return false;
  return cookies.some((cookie) => (
    cookie
    && typeof cookie.name === "string"
    && GOOGLE_AUTH_COOKIE_NAMES.has(cookie.name)
    && typeof cookie.value === "string"
    && cookie.value.length > 0
  ));
}

function processExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function waitForProcessExit(child, timeoutMs) {
  if (processExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
    if (processExited(child)) finish(true);
  });
}

async function stopLoginProcess(child) {
  if (processExited(child)) return;
  const graceful = waitForProcessExit(child, CHROME_STOP_TIMEOUT_MS);
  try {
    child.kill();
  } catch {}
  if (await graceful) return;
  const forced = waitForProcessExit(child, CHROME_STOP_TIMEOUT_MS);
  try {
    child.kill("SIGKILL");
  } catch {}
  await forced;
}

/**
 * Điều phối đăng nhập qua trình duyệt Google Chrome thật với profile tạm riêng biệt,
 * sau đó đọc session offline và chuyển đổi cookie sang Electron partition.
 */
class ExternalChromeLoginService {
  constructor({
    tempRoot = path.join(os.tmpdir(), "codex-web-gpt-chrome-login"),
    runExtractor,
    spawnFn = spawn,
    resolveChromePath = () => resolveChromeExecutablePath(),
    logger = null,
    onStateChanged = null,
    onAutoCompleted = null,
    onUnexpectedExit = null,
  } = {}) {
    if (typeof runExtractor !== "function") {
      throw new Error("ExternalChromeLoginService requires a runExtractor callback");
    }
    this.tempRoot = tempRoot;
    this.runExtractor = runExtractor;
    this.spawnFn = spawnFn;
    this.resolveChromePath = resolveChromePath;
    this.logger = logger;
    this.onStateChanged = onStateChanged;
    this.onAutoCompleted = onAutoCompleted;
    this.onUnexpectedExit = onUnexpectedExit;
    this.activeSession = null;
  }

  getState() {
    if (!this.activeSession) return null;
    return {
      active: true,
      status: this.activeSession.status,
      providerId: this.activeSession.providerId,
      profileId: this.activeSession.profileId,
      profileName: this.activeSession.profileName,
    };
  }

  _emitState() {
    this.onStateChanged?.(this.getState());
  }

  _cleanupProfileDir(profileDir) {
    if (!profileDir) return;
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch (error) {
      this.logger?.warn?.("browser.external_login_cleanup_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  start({ providerId, profileId, profileName, targetUrl }) {
    if (this.activeSession) {
      throw new Error("A Chrome sign-in window is already open. Import or cancel it first.");
    }
    const chromeExecutablePath = this.resolveChromePath();
    if (!chromeExecutablePath) {
      throw new Error("Google Chrome was not found on this machine. Install Google Chrome to sign in externally.");
    }

    fs.mkdirSync(this.tempRoot, { recursive: true, mode: 0o700 });
    const profileDir = fs.mkdtempSync(path.join(this.tempRoot, "profile-"));
    try {
      if (process.platform !== "win32") fs.chmodSync(profileDir, 0o700);
    } catch {}

    const child = this.spawnFn(chromeExecutablePath, [
      `--user-data-dir=${profileDir}`,
      "--new-window",
      "--disable-background-mode",
      "--no-first-run",
      "--no-default-browser-check",
      targetUrl,
    ], {
      env: process.env,
      stdio: "ignore",
    });

    const sessionRecord = {
      providerId,
      profileId,
      profileName,
      targetUrl,
      chromeExecutablePath,
      profileDir,
      child,
      status: "waiting",
      cancelled: false,
      completing: false,
      startedAt: Date.now(),
    };
    this.activeSession = sessionRecord;

    child.once("error", (error) => {
      if (this.activeSession !== sessionRecord || sessionRecord.cancelled || sessionRecord.completing) return;
      this.activeSession = null;
      this._cleanupProfileDir(profileDir);
      this._emitState();
      this.onUnexpectedExit?.(error instanceof Error ? error.message : String(error));
    });

    child.once("exit", (code, signal) => {
      if (this.activeSession !== sessionRecord) return;
      if (sessionRecord.cancelled || sessionRecord.completing) return;
      if (code === 0 && !signal) {
        this.logger?.info?.("browser.external_login_chrome_closed", {
          providerId: sessionRecord.providerId,
          profileId: sessionRecord.profileId,
        });
        this.onAutoCompleted?.(sessionRecord);
        return;
      }
      this.activeSession = null;
      this._cleanupProfileDir(profileDir);
      this._emitState();
      this.onUnexpectedExit?.(
        signal
          ? `Google Chrome closed unexpectedly (signal ${signal}).`
          : `Google Chrome exited with status ${code ?? 1}.`,
      );
    });

    this.logger?.info?.("browser.external_login_started", { providerId, profileId });
    this._emitState();
    return this.getState();
  }

  async complete() {
    const sessionRecord = this.activeSession;
    if (!sessionRecord) {
      throw new Error("No Chrome sign-in session is currently waiting.");
    }
    if (sessionRecord.completing) {
      throw new Error("Chrome sign-in import is already in progress.");
    }

    sessionRecord.completing = true;
    sessionRecord.status = "importing";
    this._emitState();

    try {
      await stopLoginProcess(sessionRecord.child);
      if (sessionRecord.cancelled) {
        throw new Error("Chrome sign-in was cancelled.");
      }
      const extracted = await this.runExtractor({
        profileDir: sessionRecord.profileDir,
        chromeExecutablePath: sessionRecord.chromeExecutablePath,
        targetUrl: sessionRecord.targetUrl,
      });
      if (sessionRecord.cancelled) {
        throw new Error("Chrome sign-in was cancelled.");
      }
      const cookies = Array.isArray(extracted?.cookies) ? extracted.cookies : [];
      if (!hasGoogleAuthSessionCookies(cookies)) {
        throw new Error(
          "No signed-in Google session was found in Chrome. Finish signing in to Google AI Studio before clicking Import session.",
        );
      }
      const electronCookies = cookies.map(toElectronCookieDetails).filter(Boolean);
      const localStorage = Array.isArray(extracted?.localStorage) ? extracted.localStorage : [];
      this.logger?.info?.("browser.external_login_extracted", {
        providerId: sessionRecord.providerId,
        profileId: sessionRecord.profileId,
        cookieCount: electronCookies.length,
      });
      return {
        providerId: sessionRecord.providerId,
        profileId: sessionRecord.profileId,
        profileName: sessionRecord.profileName,
        origin: extracted?.origin || new URL(sessionRecord.targetUrl).origin,
        cookies: electronCookies,
        localStorage,
      };
    } finally {
      if (this.activeSession === sessionRecord) {
        this.activeSession = null;
      }
      this._cleanupProfileDir(sessionRecord.profileDir);
      this._emitState();
    }
  }

  async cancel() {
    const sessionRecord = this.activeSession;
    if (!sessionRecord) return false;
    sessionRecord.cancelled = true;
    this.activeSession = null;
    await stopLoginProcess(sessionRecord.child);
    this._cleanupProfileDir(sessionRecord.profileDir);
    this._emitState();
    this.logger?.info?.("browser.external_login_cancelled", {
      providerId: sessionRecord.providerId,
      profileId: sessionRecord.profileId,
    });
    return true;
  }

  destroy() {
    if (!this.activeSession) return;
    const sessionRecord = this.activeSession;
    sessionRecord.cancelled = true;
    this.activeSession = null;
    try {
      if (!processExited(sessionRecord.child)) sessionRecord.child.kill();
    } catch {}
    this._cleanupProfileDir(sessionRecord.profileDir);
  }
}

module.exports = {
  ExternalChromeLoginService,
  GOOGLE_AUTH_COOKIE_NAMES,
  hasGoogleAuthSessionCookies,
  resolveChromeExecutablePath,
  toElectronCookieDetails,
};
