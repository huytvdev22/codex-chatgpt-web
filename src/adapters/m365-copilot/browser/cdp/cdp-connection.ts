import { existsSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../../../../config";
import {
  connectLauncherBrowserHost,
  notifyLauncherTurn,
  readLauncherBrowserHostDescriptor,
  type LauncherBrowserConnection,
} from "../../../../launcher-browser-host";
import { logFunctionInput } from "../../debug-logger";

/**
 * Xác định đường dẫn file descriptor của Launcher Browser Host từ tham số hoặc thư mục cấu hình.
 */
export function resolveDescriptorPath(customPath?: string): string {
  logFunctionInput("browser:cdp:cdp-connection", "resolveDescriptorPath", { customPath });
  if (customPath && existsSync(customPath)) return customPath;
  const home = process.env.CODEX_CHATGPT_WEB_HOME || getConfigDir();
  return join(home, "runtime", "launcher-browser.json");
}

/**
 * Bọc một Promise với giới hạn thời gian chờ (timeout), trả về giá trị fallback nếu quá thời gian.
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  logFunctionInput("browser:cdp:cdp-connection", "withTimeout", { timeoutMs, fallback });
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Kết nối CDP tới surface được chỉ định của Launcher Browser Host.
 */
export async function connectCdpSurface(
  descriptorPath: string,
  preferredSurfaceId?: string,
  signal?: AbortSignal,
  timeoutMs = 20_000
): Promise<LauncherBrowserConnection> {
  logFunctionInput("browser:cdp:cdp-connection", "connectCdpSurface", { descriptorPath, preferredSurfaceId, timeoutMs });
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const targetSurfaceId = preferredSurfaceId
    || (descriptor as any).m365SurfaceId
    || descriptor.surfaceId;
  return connectLauncherBrowserHost(descriptorPath, timeoutMs, targetSurfaceId, signal);
}

/**
 * Thông báo khởi động turn tới Launcher và nhận thông tin lease cấp phát Tab.
 */
export async function notifyCdpTurnStart(
  descriptorPath: string,
  traceId: string,
  options: { conversationKey?: string; connectorIdentity?: string },
  signal?: AbortSignal
): Promise<{ surfaceId?: string; reused?: boolean; connectorBound?: boolean } | undefined> {
  logFunctionInput("browser:cdp:cdp-connection", "notifyCdpTurnStart", { descriptorPath, traceId, options });
  const result = await notifyLauncherTurn(
    descriptorPath,
    {
      phase: "start",
      traceId,
      helperPid: process.pid,
      conversationKey: options.conversationKey || "",
      connectorIdentity: options.connectorIdentity || "m365-copilot",
      requireRetainedConversation: false,
    },
    undefined,
    signal
  );
  return result;
}

/**
 * Gửi heartbeat duy trì phiên tới Launcher.
 */
export async function notifyCdpTurnHeartbeat(
  descriptorPath: string,
  traceId: string,
  signal?: AbortSignal
): Promise<void> {
  logFunctionInput("browser:cdp:cdp-connection", "notifyCdpTurnHeartbeat", { descriptorPath, traceId });
  await notifyLauncherTurn(
    descriptorPath,
    {
      phase: "heartbeat",
      traceId,
      helperPid: process.pid,
      refreshViewport: false,
    },
    undefined,
    signal
  );
}

/**
 * Thông báo kết thúc turn tới Launcher.
 */
export async function notifyCdpTurnEnd(
  descriptorPath: string,
  traceId: string,
  status: "completed" | "failed" | "aborted",
  options?: { retain?: boolean },
  signal?: AbortSignal
): Promise<void> {
  logFunctionInput("browser:cdp:cdp-connection", "notifyCdpTurnEnd", { descriptorPath, traceId, status, options });
  await notifyLauncherTurn(
    descriptorPath,
    {
      phase: "end",
      traceId,
      helperPid: process.pid,
      status,
      retain: options?.retain ?? true,
      connectorBound: options?.retain ?? true,
    },
    undefined,
    signal
  );
}
