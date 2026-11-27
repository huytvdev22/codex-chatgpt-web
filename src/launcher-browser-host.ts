import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { expandUserPath } from "./config";
import { launcherCdpPool } from "./launcher-cdp-pool";
import { processRunning } from "./process";

export const LAUNCHER_BROWSER_HOST_KIND = "codex-web-gpt-launcher";
export const LAUNCHER_BROWSER_IDLE_URL = "data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Chtml%3E%3Chead%3E%3Cmeta%20charset%3D%22utf-8%22%3E%3Ctitle%3ECodex%20Web%20GPT%3C%2Ftitle%3E%3C%2Fhead%3E%3Cbody%3E%3C%2Fbody%3E%3C%2Fhtml%3E#codex-web-gpt-browser-host";
export type LauncherBrowserHostProfile = "production" | "development";

export class LauncherBrowserTurnCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherBrowserTurnCancelledError";
  }
}

export class LauncherRetainedConversationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherRetainedConversationUnavailableError";
  }
}

export interface LauncherDescriptorProfileEntry {
  id: string;
  name: string;
  authenticated: boolean;
}

export interface LauncherDescriptorProviderProfiles {
  activeProfileId: string;
  profiles: LauncherDescriptorProfileEntry[];
}

export interface LauncherBrowserHostDescriptor {
  version: 3;
  kind: typeof LAUNCHER_BROWSER_HOST_KIND;
  profile: LauncherBrowserHostProfile;
  pid: number;
  endpoint: string;
  control: {
    endpoint: string;
    token: string;
  };
  helper: {
    executable: string;
    script: string;
  };
  partition: string;
  idleUrl: string;
  surfaceId: string;
  activeSurfaceId?: string;
  provider?: string;
  providerSurfaceIds?: Record<string, string>;
  providerProfiles?: Record<string, LauncherDescriptorProviderProfiles>;
  surfaceTargets: Record<string, string>;
  createdAt: string;
}

export interface LauncherBrowserConnection {
  descriptor: LauncherBrowserHostDescriptor;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  release?: () => Promise<void>;
}

function assertLoopbackEndpoint(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing`);
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error(`${label} is not a valid URL`); }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw new Error(`${label} must use http://127.0.0.1`);
  }
  if (!parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must contain only a loopback host and explicit port`);
  }
  return parsed.origin;
}

function assertDescriptorShape(value: unknown): LauncherBrowserHostDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Launcher browser descriptor is not an object");
  }
  const descriptor = value as Partial<LauncherBrowserHostDescriptor>;
  if (descriptor.version !== 3 || descriptor.kind !== LAUNCHER_BROWSER_HOST_KIND) {
    throw new Error("Launcher browser descriptor has an unsupported identity or version; restart the updated launcher");
  }
  if (descriptor.profile !== "production" && descriptor.profile !== "development") {
    throw new Error("Launcher browser descriptor has an invalid profile");
  }
  if (!Number.isInteger(descriptor.pid) || descriptor.pid! < 1) {
    throw new Error("Launcher browser descriptor has an invalid pid");
  }
  const endpoint = assertLoopbackEndpoint(descriptor.endpoint, "Launcher CDP endpoint");
  if (!descriptor.control || typeof descriptor.control !== "object") {
    throw new Error("Launcher browser descriptor is missing its control channel");
  }
  const controlEndpoint = assertLoopbackEndpoint(descriptor.control.endpoint, "Launcher control endpoint");
  if (typeof descriptor.control.token !== "string" || !/^[A-Za-z0-9_-]{40,}$/.test(descriptor.control.token)) {
    throw new Error("Launcher browser descriptor has an invalid control token");
  }
  if (!descriptor.helper || typeof descriptor.helper !== "object") {
    throw new Error("Launcher browser descriptor is missing its Node helper command");
  }
  const helperExecutable = typeof descriptor.helper.executable === "string" ? resolve(descriptor.helper.executable) : "";
  const helperScript = typeof descriptor.helper.script === "string" ? resolve(descriptor.helper.script) : "";
  if (!helperExecutable || !existsSync(helperExecutable)) {
    throw new Error("Launcher browser descriptor helper executable does not exist");
  }
  if (!helperScript || !existsSync(helperScript)) {
    throw new Error("Launcher browser descriptor helper script does not exist");
  }
  const allowedPartitionPattern = descriptor.profile === "development"
    ? /^persist:codex-web-gpt-dev-[a-z0-9-]+$/
    : /^persist:codex-(?:web-gpt-|web-|m365-)[a-z0-9-]+$/;
  if (typeof descriptor.partition !== "string" || !allowedPartitionPattern.test(descriptor.partition)) {
    throw new Error("Launcher browser descriptor identifies an unexpected browser partition");
  }
  if (descriptor.idleUrl !== LAUNCHER_BROWSER_IDLE_URL) {
    throw new Error("Launcher browser descriptor identifies an unexpected idle surface");
  }
  if (typeof descriptor.surfaceId !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(descriptor.surfaceId)) {
    throw new Error("Launcher browser descriptor has an invalid owned surface id");
  }
  let providerSurfaceIds: Record<string, string> | undefined;
  if (descriptor.providerSurfaceIds !== undefined) {
    if (!descriptor.providerSurfaceIds || typeof descriptor.providerSurfaceIds !== "object" || Array.isArray(descriptor.providerSurfaceIds)) {
      throw new Error("Launcher browser descriptor has invalid providerSurfaceIds");
    }
    for (const [providerKey, surface] of Object.entries(descriptor.providerSurfaceIds)) {
      if (!/^[a-z0-9-]+$/.test(providerKey) || typeof surface !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(surface)) {
        throw new Error("Launcher browser descriptor has invalid provider surface entry");
      }
    }
    providerSurfaceIds = { ...descriptor.providerSurfaceIds };
  }
  let providerProfiles: Record<string, LauncherDescriptorProviderProfiles> | undefined;
  if (
    descriptor.providerProfiles &&
    typeof descriptor.providerProfiles === "object" &&
    !Array.isArray(descriptor.providerProfiles)
  ) {
    const sanitizedGroups: Record<string, LauncherDescriptorProviderProfiles> = {};
    for (const [providerKey, rawGroup] of Object.entries(descriptor.providerProfiles)) {
      if (!/^[a-z0-9-]+$/.test(providerKey) || !rawGroup || typeof rawGroup !== "object") continue;
      const rawList = Array.isArray(rawGroup.profiles) ? rawGroup.profiles : [];
      const profiles: LauncherDescriptorProfileEntry[] = [];
      for (const item of rawList) {
        if (!item || typeof item !== "object") continue;
        const id = typeof item.id === "string" ? item.id.trim().toLowerCase() : "";
        if (!id || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) continue;
        profiles.push({
          id,
          name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : id,
          authenticated: item.authenticated === true,
        });
      }
      if (profiles.length > 0) {
        sanitizedGroups[providerKey] = {
          activeProfileId:
            typeof rawGroup.activeProfileId === "string" && rawGroup.activeProfileId.trim()
              ? rawGroup.activeProfileId.trim().toLowerCase()
              : profiles[0].id,
          profiles,
        };
      }
    }
    if (Object.keys(sanitizedGroups).length > 0) {
      providerProfiles = sanitizedGroups;
    }
  }
  const targets = descriptor.surfaceTargets;
  if (!targets || typeof targets !== "object" || Array.isArray(targets)
    || Object.entries(targets).some(([surface, target]) => !/^[A-Za-z0-9_-]{32}$/.test(surface)
      || typeof target !== "string" || !target.trim())
    || new Set(Object.values(targets)).size !== Object.keys(targets).length) {
    throw new Error("Launcher browser descriptor has invalid or duplicated surface targets");
  }
  if (typeof descriptor.createdAt !== "string" || Number.isNaN(Date.parse(descriptor.createdAt))) {
    throw new Error("Launcher browser descriptor has an invalid creation time");
  }
  return {
    version: 3,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: descriptor.profile,
    pid: descriptor.pid!,
    endpoint,
    control: { endpoint: controlEndpoint, token: descriptor.control.token },
    helper: { executable: helperExecutable, script: helperScript },
    partition: descriptor.partition,
    idleUrl: descriptor.idleUrl,
    surfaceId: descriptor.surfaceId,
    activeSurfaceId: descriptor.activeSurfaceId,
    provider: descriptor.provider,
    ...(providerSurfaceIds ? { providerSurfaceIds } : {}),
    ...(providerProfiles ? { providerProfiles } : {}),
    surfaceTargets: targets,
    createdAt: descriptor.createdAt,
  };
}

export function readLauncherBrowserHostDescriptor(configuredPath: string): LauncherBrowserHostDescriptor {
  const path = resolve(expandUserPath(configuredPath));
  if (!existsSync(path)) throw new Error(`Launcher browser host is unavailable: descriptor is missing at ${path}`);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`Launcher browser descriptor is not a regular file: ${path}`);
  if (process.platform !== "win32") {
    if ((stat.mode & 0o077) !== 0) throw new Error(`Launcher browser descriptor has unsafe permissions: ${path}`);
    const getuid = process.getuid;
    if (typeof getuid === "function" && stat.uid !== getuid()) {
      throw new Error(`Launcher browser descriptor is not owned by the current user: ${path}`);
    }
  }
  let decoded: unknown;
  try { decoded = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    throw new Error(`Launcher browser descriptor is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const descriptor = assertDescriptorShape(decoded);
  if (!processRunning(descriptor.pid)) {
    throw new Error(`Launcher browser host process is not running (pid ${descriptor.pid})`);
  }
  return descriptor;
}

async function assertCdpReady(descriptor: LauncherBrowserHostDescriptor, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${descriptor.endpoint}/json/version`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as Record<string, unknown>;
    if (typeof body.webSocketDebuggerUrl !== "string" || !body.webSocketDebuggerUrl.startsWith("ws://127.0.0.1:")) {
      throw new Error("CDP metadata did not expose a loopback WebSocket endpoint");
    }
  } catch (error) {
    throw new Error(`Launcher browser CDP endpoint is not ready: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectLauncherBrowserHostLiveness(
  descriptorPath: string,
  options: {
    expectedProfile?: LauncherBrowserHostProfile;
    timeoutMs?: number;
  } = {},
): Promise<LauncherBrowserHostDescriptor> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  if (options.expectedProfile && descriptor.profile !== options.expectedProfile) {
    throw new Error(
      `Launcher browser belongs to ${descriptor.profile}, but ${options.expectedProfile} was required`,
    );
  }
  await assertCdpReady(descriptor, options.timeoutMs ?? 5_000);
  return descriptor;
}

export interface SelectLauncherPageOptions {
  explicitTargetId?: string;
  pageTargetCache?: WeakMap<Page, string>;
  duplicateCheckGraceMs?: number;
}

const MATCH_DUPLICATE_GRACE_MS = 25;

export async function selectLauncherPage(
  browser: Browser,
  descriptor: LauncherBrowserHostDescriptor,
  timeoutMs: number,
  surfaceId = descriptor.surfaceId,
  abortSignal?: AbortSignal,
  options: SelectLauncherPageOptions = {},
): Promise<{ context: BrowserContext; page: Page }> {
  if (abortSignal?.aborted) {
    throw new DOMException("Launcher browser connection aborted", "AbortError");
  }
  const targetId = options.explicitTargetId?.trim() || descriptor.surfaceTargets[surfaceId];
  if (!targetId) throw new Error("Launcher browser surface is no longer registered with its native target");
  const cache = options.pageTargetCache;
  const duplicateGraceMs = options.duplicateCheckGraceMs ?? MATCH_DUPLICATE_GRACE_MS;
  const deadline = Date.now() + timeoutMs;
  do {
    if (abortSignal?.aborted) {
      throw new DOMException("Launcher browser connection aborted", "AbortError");
    }
    const candidates = browser.contexts().flatMap(context => context.pages().map(page => ({ context, page })));

    if (cache) {
      const cachedMatches = candidates.filter(candidate => cache.get(candidate.page) === targetId);
      if (cachedMatches.length === 1) {
        return { context: cachedMatches[0].context, page: cachedMatches[0].page };
      }
      if (cachedMatches.length > 1) {
        throw new Error(`Launcher browser host exposed ${cachedMatches.length} surfaces with the same ownership id`);
      }
    }

    const uncachedCandidates = cache
      ? candidates.filter(candidate => !cache.has(candidate.page))
      : candidates;

    if (uncachedCandidates.length > 0) {
      // Target metadata thuộc về browser process; dùng race-to-first-match để một tab cũ
      // đang đứng/unresponsive không bao giờ kéo chậm 1.5s–3s việc lấy tab sở hữu đã sẵn sàng.
      const inspectCandidate = async (candidate: { context: BrowserContext; page: Page }) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const sessionPromise = candidate.context.newCDPSession(candidate.page).catch(() => undefined);
        try {
          const session = await Promise.race([
            sessionPromise,
            new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), 1_500);
              timer.unref?.();
            }),
          ]);
          if (!session) {
            void sessionPromise.then(s => s?.detach().catch(() => {}));
            return { ...candidate, targetId: undefined };
          }
          let innerTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const { targetInfo } = await Promise.race([
              session.send("Target.getTargetInfo"),
              new Promise<never>((_resolve, reject) => {
                innerTimer = setTimeout(() => reject(new Error("Target.getTargetInfo timed out")), 1_500);
                innerTimer.unref?.();
              }),
            ]);
            if (targetInfo?.targetId) {
              cache?.set(candidate.page, targetInfo.targetId);
            }
            return { ...candidate, targetId: targetInfo.targetId };
          } catch {
            return { ...candidate, targetId: undefined };
          } finally {
            if (innerTimer) clearTimeout(innerTimer);
            await session.detach().catch(() => {});
          }
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      const owned = await new Promise<Array<{ context: BrowserContext; page: Page; targetId: string | undefined }>>(
        (resolve, reject) => {
          const matches: Array<{ context: BrowserContext; page: Page; targetId: string | undefined }> = [];
          let remaining = uncachedCandidates.length;
          let settled = false;
          let graceTimer: ReturnType<typeof setTimeout> | undefined;

          const finish = () => {
            if (settled) return;
            settled = true;
            if (graceTimer) clearTimeout(graceTimer);
            abortSignal?.removeEventListener("abort", onAbort);
            resolve(matches);
          };

          const onAbort = () => {
            if (settled) return;
            settled = true;
            if (graceTimer) clearTimeout(graceTimer);
            reject(new DOMException("Launcher browser connection aborted", "AbortError"));
          };
          abortSignal?.addEventListener("abort", onAbort, { once: true });

          for (const candidate of uncachedCandidates) {
            void inspectCandidate(candidate).then((result) => {
              remaining -= 1;
              if (result.targetId === targetId) {
                matches.push(result);
                if (matches.length > 1) {
                  finish();
                  return;
                }
                if (remaining > 0 && !graceTimer) {
                  graceTimer = setTimeout(finish, duplicateGraceMs);
                  graceTimer.unref?.();
                }
              }
              if (remaining === 0) {
                finish();
              }
            });
          }
        },
      );

      if (owned.length === 1) {
        return { context: owned[0].context, page: owned[0].page };
      }
      if (owned.length > 1) {
        throw new Error(`Launcher browser host exposed ${owned.length} surfaces with the same ownership id`);
      }
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("Launcher browser host did not expose its owned browser surface");
}

export async function connectLauncherBrowserHost(
  descriptorPath: string,
  timeoutMs = 20_000,
  surfaceId?: string,
  abortSignal?: AbortSignal,
  explicitTargetId?: string,
): Promise<LauncherBrowserConnection> {
  if (abortSignal?.aborted) {
    throw new DOMException("Launcher browser connection aborted", "AbortError");
  }
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const deadline = Date.now() + timeoutMs;

  const attemptConnect = async (allowStaleRetry: boolean): Promise<LauncherBrowserConnection> => {
    const remainingMs = Math.max(1_000, deadline - Date.now());
    const lease = await launcherCdpPool.acquire({
      endpoint: descriptor.endpoint,
      pid: descriptor.pid,
      timeoutMs: remainingMs,
      signal: abortSignal,
    });
    if (!lease.reusedConnection) {
      await assertCdpReady(descriptor, Math.min(remainingMs, 5_000)).catch(async (error) => {
        await lease.invalidate();
        throw error;
      });
    }
    try {
      if (abortSignal?.aborted) {
        throw new DOMException("Launcher browser connection aborted", "AbortError");
      }
      // Nếu đang dùng shared connection cũ mà chưa thấy page mới sau 3s, tự reconnect 1 lần
      const selectBudgetMs = lease.reusedConnection && allowStaleRetry
        ? Math.min(3_000, Math.max(1_000, deadline - Date.now()))
        : Math.max(1_000, deadline - Date.now());
      const { context, page } = await selectLauncherPage(
        lease.browser,
        descriptor,
        selectBudgetMs,
        surfaceId,
        abortSignal,
        {
          explicitTargetId,
          pageTargetCache: lease.pageTargetCache,
        },
      );
      return {
        descriptor,
        browser: lease.browser,
        context,
        page,
        release: lease.release,
      };
    } catch (error) {
      if (lease.reusedConnection && allowStaleRetry && !abortSignal?.aborted && Date.now() < deadline) {
        await lease.invalidate();
        return await attemptConnect(false);
      }
      await lease.release();
      throw error;
    }
  };

  return await attemptConnect(true);
}

export async function inspectLauncherBrowserHost(
  descriptorPath: string,
  options: {
    expectedProfile?: LauncherBrowserHostProfile;
    timeoutMs?: number;
  } = {},
): Promise<{ url: string; provider?: string }> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  if (options.expectedProfile && descriptor.profile !== options.expectedProfile) {
    throw new Error(
      `Launcher browser belongs to ${descriptor.profile}, but ${options.expectedProfile} was required`,
    );
  }
  const timeoutMs = options.timeoutMs ?? LAUNCHER_SESSION_INSPECTION_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(`${descriptor.control.endpoint}/v1/session/inspect`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.control.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
    if (body.authenticated !== true || typeof body.url !== "string") {
      throw new Error("Launcher returned invalid Web browser session evidence");
    }
    return {
      url: body.url,
      ...(typeof body.provider === "string" ? { provider: body.provider } : {}),
    };
  } catch (error) {
    const detail = timedOut
      ? `session inspection timed out after ${timeoutMs}ms`
      : error instanceof Error ? error.message : String(error);
    throw new Error(`Launcher Web browser session could not be verified: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

export const LAUNCHER_SESSION_INSPECTION_TIMEOUT_MS = 30_000;

export type LauncherTurnActivity =
  | {
      phase: "start";
      traceId: string;
      helperPid: number;
      conversationKey?: string;
      connectorIdentity?: string;
      provider?: string;
      requireRetainedConversation?: boolean;
      initialUrl?: string;
      profileId?: string;
    }
  | {
      phase: "heartbeat";
      traceId: string;
      helperPid: number;
      /** Re-establish the launcher's hidden viewport after the caller closes its CDP session. */
      refreshViewport?: boolean;
    }
  | {
      phase: "end";
      traceId: string;
      helperPid: number;
      status: "completed" | "failed" | "aborted";
      message?: string;
      retain?: boolean;
      connectorBound?: boolean;
      conversationId?: string;
      provider?: string;
    };

// Startup must exceed the launcher's bootstrap + retry budget (20s + 0.5s + 30s). This is not a model-turn budget.
export const LAUNCHER_TURN_START_TIMEOUT_MS = 60_000;
export const LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS = 10_000;
export const LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS = 5_000;
export const LAUNCHER_TURN_END_TIMEOUT_MS = 15_000;

export async function notifyLauncherTurn(
  descriptorPath: string,
  activity: LauncherTurnActivity,
  timeoutMs = activity.phase === "end"
    ? LAUNCHER_TURN_END_TIMEOUT_MS
    : activity.phase === "heartbeat"
      ? LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS
      : LAUNCHER_TURN_START_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<{
  surfaceId?: string;
  targetId?: string;
  reused?: boolean;
  connectorBound?: boolean;
  conversationId?: string;
  cancelledByUser?: boolean;
  authenticationRequired?: boolean;
}> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${descriptor.control.endpoint}/v1/turn/${activity.phase}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.control.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(activity),
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (response.status === 409 && body.code === "turn_cancelled") {
        throw new LauncherBrowserTurnCancelledError(
          typeof body.error === "string" ? body.error : `Browser turn ${activity.traceId} was cancelled by the user`,
        );
      }
      if (response.status === 409 && body.code === "retained_conversation_unavailable") {
        throw new LauncherRetainedConversationUnavailableError(
          typeof body.error === "string" ? body.error : "The retained ChatGPT conversation is no longer available",
        );
      }
      const detail = typeof body.error === "string" ? body.error : "";
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (activity.phase === "start") {
      if (typeof body.surfaceId !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(body.surfaceId)) {
        throw new Error("Launcher browser control channel returned an invalid turn surface id");
      }
      if (typeof body.reused !== "boolean") {
        throw new Error("Launcher browser control channel returned an invalid reuse state");
      }
      if (typeof body.connectorBound !== "boolean") {
        throw new Error("Launcher browser control channel returned an invalid connector state");
      }
      if (body.conversationId !== undefined
        && (typeof body.conversationId !== "string"
          || !/^[A-Za-z0-9_.:-]{4,256}$/.test(body.conversationId))) {
        throw new Error("Launcher browser control channel returned an invalid conversation id");
      }
      return {
        surfaceId: body.surfaceId,
        ...(typeof body.targetId === "string" && body.targetId.trim() ? { targetId: body.targetId.trim() } : {}),
        reused: body.reused,
        connectorBound: body.connectorBound,
        ...(typeof body.conversationId === "string" ? { conversationId: body.conversationId } : {}),
      };
    }
    if (activity.phase === "end") {
      if (typeof body.cancelledByUser !== "boolean") {
        throw new Error("Launcher browser control channel returned an invalid turn release result");
      }
      if (body.authenticationRequired !== undefined && typeof body.authenticationRequired !== "boolean") {
        throw new Error("Launcher browser control channel returned an invalid authentication state");
      }
      return {
        cancelledByUser: body.cancelledByUser,
        ...(body.authenticationRequired === true ? { authenticationRequired: true } : {}),
      };
    }
    return {};
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Launcher browser acquisition cancelled", "AbortError");
    if (controller.signal.aborted) throw new Error(`Launcher browser control ${activity.phase} timed out after ${timeoutMs}ms`);
    if (error instanceof LauncherBrowserTurnCancelledError
      || error instanceof LauncherRetainedConversationUnavailableError) throw error;
    throw new Error(`Launcher browser control channel failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function releaseLauncherRetainedConversation(
  descriptorPath: string,
  conversationKey: string,
  timeoutMs = LAUNCHER_TURN_END_TIMEOUT_MS,
): Promise<number> {
  if (!/^[a-f0-9]{64}$/.test(conversationKey)) {
    throw new Error("Launcher retained conversation key is invalid");
  }
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${descriptor.control.endpoint}/v1/turn/release`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.control.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ conversationKey }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || !Number.isSafeInteger(body.released) || Number(body.released) < 0) {
      const detail = typeof body.error === "string" ? `: ${body.error}` : "";
      throw new Error(`HTTP ${response.status}${detail}`);
    }
    return Number(body.released);
  } catch (error) {
    throw new Error(`Launcher retained conversation release failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}
