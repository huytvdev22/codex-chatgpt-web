import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../../config";
import {
  connectLauncherBrowserHost,
  notifyLauncherTurn,
  readLauncherBrowserHostDescriptor,
  type LauncherBrowserConnection,
  type LauncherBrowserHostDescriptor,
  type LauncherTurnActivity,
} from "../../launcher-browser-host";
import { processRunning } from "../../process";

/**
 * Resolves the shared Launcher browser-host descriptor without embedding
 * provider-specific ownership in each Web adapter.
 */
export function resolveLauncherDescriptorPath(
  customPath?: string,
  additionalHomeDirectories: readonly string[] = [],
): string | null {
  if (customPath && existsSync(customPath)) return customPath;

  const appHome = process.env.CODEX_CHATGPT_WEB_HOME || getConfigDir();
  const candidates = [
    join(appHome, "runtime", "launcher-browser.json"),
    ...additionalHomeDirectories.map(directory =>
      join(homedir(), directory, "runtime", "launcher-browser.json")
    ),
    join(homedir(), ".codex-m365-copilot", "runtime", "launcher-browser.json"),
    join(homedir(), ".codex-chatgpt-web", "runtime", "launcher-browser.json"),
  ];

  return candidates.find(existsSync) || null;
}

type LauncherStartActivity = Extract<
  LauncherTurnActivity,
  { phase: "start" }
>;
type LauncherEndActivity = Extract<
  LauncherTurnActivity,
  { phase: "end" }
>;
type LauncherHeartbeatActivity = Extract<
  LauncherTurnActivity,
  { phase: "heartbeat" }
>;

export interface StartLauncherBrowserTurnOps {
  readDescriptor?: typeof readLauncherBrowserHostDescriptor;
  isProcessRunning?: typeof processRunning;
  notifyTurn?: typeof notifyLauncherTurn;
  connectBrowserHost?: typeof connectLauncherBrowserHost;
}

export interface StartLauncherBrowserTurnOptions {
  descriptorPath: string;
  activity: LauncherStartActivity;
  signal?: AbortSignal;
  connectionTimeoutMs?: number;
  resolveSurfaceId?: (
    descriptor: LauncherBrowserHostDescriptor,
    leaseSurfaceId: string | undefined,
  ) => string | undefined;
  ops?: StartLauncherBrowserTurnOps;
}

export interface LauncherBrowserTurnSession {
  connection: LauncherBrowserConnection;
  surfaceId: string | undefined;
  conversationId: string | undefined;
  reused: boolean;
  connectorBound: boolean;
}

/**
 * Registers a Web adapter turn and connects Playwright to the leased Launcher
 * surface. A stopped Launcher returns null, while control/CDP failures remain
 * visible so each provider can retain its own fallback policy.
 */
export async function startLauncherBrowserTurn(
  options: StartLauncherBrowserTurnOptions,
): Promise<LauncherBrowserTurnSession | null> {
  const readDescriptor =
    options.ops?.readDescriptor ?? readLauncherBrowserHostDescriptor;
  const checkProcessRunning = options.ops?.isProcessRunning ?? processRunning;
  const notifyTurn = options.ops?.notifyTurn ?? notifyLauncherTurn;
  const connectBrowserHost =
    options.ops?.connectBrowserHost ?? connectLauncherBrowserHost;

  const descriptor = readDescriptor(options.descriptorPath);
  if (!checkProcessRunning(descriptor.pid)) return null;

  const lease = await notifyTurn(
    options.descriptorPath,
    options.activity,
    undefined,
    options.signal,
  );
  try {
    const surfaceId = options.resolveSurfaceId
      ? options.resolveSurfaceId(descriptor, lease.surfaceId)
      : lease.surfaceId || descriptor.surfaceId;
    const connection = await connectBrowserHost(
      options.descriptorPath,
      options.connectionTimeoutMs ?? 20_000,
      surfaceId,
      options.signal,
    );

    return {
      connection,
      surfaceId,
      conversationId: lease.conversationId,
      reused: lease.reused === true,
      connectorBound: lease.connectorBound === true,
    };
  } catch (error) {
    // Release the started Launcher turn lease on setup/CDP failure without
    // forwarding the caller signal so /v1/turn/end reaches Launcher cleanly.
    await notifyTurn(
      options.descriptorPath,
      {
        phase: "end",
        traceId: options.activity.traceId,
        helperPid: options.activity.helperPid,
        provider: options.activity.provider,
        status: options.signal?.aborted ? "aborted" : "failed",
        retain: false,
        connectorBound: false,
        conversationId: lease.conversationId,
      },
      undefined,
      undefined,
    ).catch(() => undefined);
    throw error;
  }
}

export async function closeLauncherBrowserTurn(
  connection: LauncherBrowserConnection | null,
): Promise<void> {
  if (!connection) return;
  await connection.browser.close().catch(() => {});
}

export interface EndLauncherBrowserTurnOptions {
  descriptorPath: string;
  activity: LauncherEndActivity;
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
}

/**
 * Releases a Launcher turn without allowing control-channel cleanup failures
 * to replace the provider turn's primary result.
 */
export async function endLauncherBrowserTurn(
  options: EndLauncherBrowserTurnOptions,
): Promise<void> {
  try {
    await notifyLauncherTurn(
      options.descriptorPath,
      options.activity,
      undefined,
      options.signal,
    );
  } catch (error) {
    options.onError?.(error);
  }
}

export interface HeartbeatLauncherBrowserTurnOptions {
  descriptorPath: string;
  activity: LauncherHeartbeatActivity;
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
}

/**
 * Gia hạn Launcher lease cho browser turn kéo dài mà không để provider worker
 * phụ thuộc trực tiếp vào control channel của Launcher.
 */
export async function heartbeatLauncherBrowserTurn(
  options: HeartbeatLauncherBrowserTurnOptions,
): Promise<void> {
  try {
    await notifyLauncherTurn(
      options.descriptorPath,
      options.activity,
      undefined,
      options.signal,
    );
  } catch (error) {
    options.onError?.(error);
  }
}
