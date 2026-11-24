import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import { defaultChromeExecutable } from "./config";

export interface ExtractedCookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface ExtractedLocalStorageEntry {
  name: string;
  value: string;
}

export interface ChromeSessionExtractionResult {
  origin: string;
  cookies: ExtractedCookieRecord[];
  localStorage: ExtractedLocalStorageEntry[];
}

export const DEFAULT_CHROME_COOKIE_ROOT_DOMAINS = [
  "google.com",
  "aistudio.google.com",
  "googleusercontent.com",
  "gstatic.com",
  "youtube.com",
] as const;

export const CHROME_COOKIE_ROOT_DOMAINS_BY_PROVIDER: Record<string, readonly string[]> = {
  "ai-studio": DEFAULT_CHROME_COOKIE_ROOT_DOMAINS,
  chatgpt: [
    "chatgpt.com",
    "openai.com",
    "oaistatic.com",
    "oaiusercontent.com",
  ],
};

export function resolveChromeCookieRootDomains(providerId?: string): readonly string[] {
  const normalized = providerId?.trim().toLowerCase() || "ai-studio";
  const domains = CHROME_COOKIE_ROOT_DOMAINS_BY_PROVIDER[normalized];
  if (!domains) {
    throw new Error(`Unsupported external Chrome login provider: ${normalized}`);
  }
  return domains;
}

const SESSION_ARTIFACT_FILES = [
  "Current Session",
  "Current Tabs",
  "Last Session",
  "Last Tabs",
] as const;

export function isAllowedChromeSessionHost(
  rawHostname: string,
  allowedRootDomains: readonly string[] = DEFAULT_CHROME_COOKIE_ROOT_DOMAINS,
): boolean {
  const hostname = rawHostname.trim().toLowerCase().replace(/^\.+/, "");
  if (!hostname
    || !/^[a-z0-9.-]+$/.test(hostname)
    || hostname.startsWith(".")
    || hostname.endsWith(".")
    || hostname.includes("..")) {
    return false;
  }
  try {
    const parsed = new URL(`https://${hostname}/`);
    if (parsed.hostname !== hostname
      || parsed.host !== hostname
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash) {
      return false;
    }
  } catch {
    return false;
  }
  return allowedRootDomains.some((root) => hostname === root || hostname.endsWith(`.${root}`));
}

export function removeTemporaryChromeTabSessions(profileDir: string): void {
  const defaultProfile = join(profileDir, "Default");
  rmSync(join(defaultProfile, "Sessions"), { recursive: true, force: true });
  for (const name of SESSION_ARTIFACT_FILES) {
    rmSync(join(defaultProfile, name), { force: true });
  }
}

export function filterExtractedStorageState(
  storageState: Awaited<ReturnType<BrowserContext["storageState"]>>,
  targetOrigin: string,
  allowedRootDomains: readonly string[] = DEFAULT_CHROME_COOKIE_ROOT_DOMAINS,
): ChromeSessionExtractionResult {
  const cookies: ExtractedCookieRecord[] = (storageState.cookies || [])
    .filter((cookie) => !Object.prototype.hasOwnProperty.call(cookie, "partitionKey")
      && isAllowedChromeSessionHost(cookie.domain, allowedRootDomains))
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    }));

  const originEntry = (storageState.origins || []).find((entry) => entry.origin === targetOrigin);
  const localStorage: ExtractedLocalStorageEntry[] = originEntry
    ? originEntry.localStorage.map((item) => ({ name: item.name, value: item.value }))
    : [];

  return {
    origin: targetOrigin,
    cookies,
    localStorage,
  };
}

export async function extractChromeProfileSession(options: {
  profileDir: string;
  targetUrl: string;
  providerId?: string;
  chromeExecutablePath?: string;
  timeoutMs?: number;
}): Promise<ChromeSessionExtractionResult> {
  const profileDir = options.profileDir.trim();
  if (!profileDir || !existsSync(profileDir) || !statSync(profileDir).isDirectory()) {
    throw new Error(`Chrome login profile directory does not exist: ${profileDir}`);
  }
  const allowedRootDomains = resolveChromeCookieRootDomains(options.providerId);
  const targetParsed = new URL(options.targetUrl);
  if (targetParsed.protocol !== "https:" || !isAllowedChromeSessionHost(targetParsed.hostname, allowedRootDomains)) {
    throw new Error(`Unsupported external login target origin: ${targetParsed.origin}`);
  }

  const executablePath = (options.chromeExecutablePath?.trim() || defaultChromeExecutable()).trim();
  if (!executablePath || !existsSync(executablePath)) {
    throw new Error(`Google Chrome executable was not found: ${executablePath}`);
  }

  removeTemporaryChromeTabSessions(profileDir);

  const timeoutMs = options.timeoutMs ?? 30_000;
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless: true,
      chromiumSandbox: true,
      offline: true,
      serviceWorkers: "block",
      ignoreDefaultArgs: [
        "--no-sandbox",
        "--enable-automation",
        "--password-store=basic",
        "--use-mock-keychain",
      ],
      args: [
        "--disable-background-mode",
        "--disable-background-networking",
        "--no-first-run",
        "--no-default-browser-check",
        "--restore-last-session",
      ],
      timeout: timeoutMs,
    });
    await context.setOffline(true);
    const storageState = await context.storageState();
    return filterExtractedStorageState(storageState, targetParsed.origin, allowedRootDomains);
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}
