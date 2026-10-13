import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { connectLauncherBrowserHost, notifyLauncherTurn } from "../../../../launcher-browser-host";
import { getConfigDir } from "../../../../config";

export interface LauncherTurnLease {
  surfaceId?: string;
  conversationId?: string;
  reused?: boolean;
}

export interface CdpBrowserConnection {
  browser: Browser;
  page: Page;
}

/**
 * Trình quản lý kết nối CDP và vòng đời lượt tương tác với Launcher Desktop Host.
 */
export class CdpLauncherConnector {
  public static resolveDescriptorPath(customPath?: string): string {
    if (customPath && existsSync(customPath)) return customPath;
    const home = process.env.CODEX_CHATGPT_WEB_HOME || getConfigDir();
    return join(home, "runtime", "launcher-browser.json");
  }

  public async acquireLease(
    descriptorPath: string,
    options: {
      traceId: string;
      conversationKey: string;
      connectorIdentity: string;
      provider: string;
      signal?: AbortSignal;
      requireRetainedConversation?: boolean;
    }
  ): Promise<LauncherTurnLease> {
    if (!existsSync(descriptorPath)) {
      throw new Error(
        `[CdpLauncherConnector] Không tìm thấy runtime descriptor của Launcher tại: ${descriptorPath}. Vui lòng mở Desktop Launcher!`
      );
    }

    const lease = await notifyLauncherTurn(
      descriptorPath,
      {
        phase: "start",
        traceId: options.traceId,
        helperPid: process.pid,
        conversationKey: options.conversationKey,
        connectorIdentity: options.connectorIdentity,
        provider: options.provider as "m365" | "chatgpt" | undefined,
        requireRetainedConversation: options.requireRetainedConversation ?? false,
      },
      undefined,
      options.signal
    );

    if (!lease.surfaceId) {
      throw new Error(`[CdpLauncherConnector] Launcher không cấp phát surface cho ${options.connectorIdentity}`);
    }

    return lease;
  }

  public async connect(
    descriptorPath: string,
    surfaceId: string,
    signal?: AbortSignal,
    timeoutMs = 20_000
  ): Promise<CdpBrowserConnection> {
    const connection = await connectLauncherBrowserHost(descriptorPath, timeoutMs, surfaceId, signal);
    return connection as unknown as CdpBrowserConnection;
  }

  public async sendHeartbeat(descriptorPath: string, traceId: string, signal?: AbortSignal): Promise<void> {
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
    ).catch(() => {});
  }

  public async releaseLease(
    descriptorPath: string,
    options: {
      traceId: string;
      status: "completed" | "failed" | "aborted";
      conversationId?: string;
      retain?: boolean;
    }
  ): Promise<void> {
    await notifyLauncherTurn(descriptorPath, {
      phase: "end",
      traceId: options.traceId,
      helperPid: process.pid,
      status: options.status,
      retain: options.retain ?? true,
      connectorBound: options.status === "completed" && Boolean(options.conversationId),
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    });
  }

  public async closeConnectionWithTimeout(browser: Browser, timeoutMs = 3000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(() => resolve(), timeoutMs);
    });
    await Promise.race([browser.close().catch(() => {}), timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  public static async acquireLeaseAndConnect(options: {
    descriptorPath?: string;
    conversationKey?: string;
    traceId?: string;
    signal?: AbortSignal;
    connectorIdentity: string;
    provider: string;
    requireRetainedConversation?: boolean;
  }): Promise<CdpBrowserConnection & { lease: LauncherTurnLease }> {
    const connector = new CdpLauncherConnector();
    const descriptorPath = CdpLauncherConnector.resolveDescriptorPath(options.descriptorPath);
    const traceId = options.traceId || Math.random().toString(36).slice(2);
    const conversationKey = options.conversationKey || "default-key";

    const lease = await connector.acquireLease(descriptorPath, {
      traceId,
      conversationKey,
      connectorIdentity: options.connectorIdentity,
      provider: options.provider,
      signal: options.signal,
      requireRetainedConversation: options.requireRetainedConversation,
    });

    const connection = await connector.connect(descriptorPath, lease.surfaceId!, options.signal);
    return Object.assign(connection, { lease });
  }
}
