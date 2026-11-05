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

export interface StartLauncherBrowserTurnOptions {
  descriptorPath: string;
  activity: LauncherStartActivity;
  signal?: AbortSignal;
  connectionTimeoutMs?: number;
  resolveSurfaceId?: (
    descriptor: LauncherBrowserHostDescriptor,
    leaseSurfaceId: string | undefined,
  ) => string | undefined;
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
  const descriptor = readLauncherBrowserHostDescriptor(options.descriptorPath);
  if (!processRunning(descriptor.pid)) return null;

  const lease = await notifyLauncherTurn(
    options.descriptorPath,
    options.activity,
    undefined,
    options.signal,
  );
  const surfaceId = options.resolveSurfaceId
    ? options.resolveSurfaceId(descriptor, lease.surfaceId)
    : lease.surfaceId || descriptor.surfaceId;
  const connection = await connectLauncherBrowserHost(
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
}

export async function closeLauncherBrowserTurn(
  connection: LauncherBrowserConnection | null,
): Promise<void> {
  if (!connection) return;
  await connection.browser.close().catch(() => {});
}
