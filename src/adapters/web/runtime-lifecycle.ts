import type { Page } from "playwright-core";
import type { LauncherBrowserConnection } from "../../launcher-browser-host";
import {
  closeLauncherBrowserTurn,
  endLauncherBrowserTurn,
  resolveLauncherDescriptorPath,
  startLauncherBrowserTurn,
} from "./launcher-runtime";
import type { LocalBrowserRuntime } from "./local-browser-runtime";
import type {
  WebProviderDefinition,
  WebTurnFinalStatus,
} from "./definition";

export interface AcquiredWebTurnSurface {
  descriptorPath?: string;
  launcherConnection: LauncherBrowserConnection | null;
  page: Page | null;
  surfaceId?: string;
  leaseConversationId?: string;
  launcherReused: boolean;
  leaseStarted: boolean;
}

export async function acquireWebTurnSurface(options: {
  definition: WebProviderDefinition;
  localBrowser?: LocalBrowserRuntime;
  turnTraceId: string;
  conversationKey?: string;
  abortSignal?: AbortSignal;
}): Promise<AcquiredWebTurnSurface> {
  const {
    definition,
    localBrowser,
    turnTraceId,
    conversationKey,
    abortSignal,
  } = options;

  const manageInEngine =
    definition.policies?.manageLauncherLeaseInEngine ?? true;
  if (!manageInEngine) {
    return {
      launcherConnection: null,
      page: null,
      launcherReused: false,
      leaseStarted: false,
    };
  }

  const descriptorPath = resolveLauncherDescriptorPath(
    definition.browser.descriptorPath,
    definition.browser.descriptorSubdirs,
  );
  let launcherConnection: LauncherBrowserConnection | null = null;
  let page: Page | null = null;
  let surfaceId: string | undefined;
  let leaseConversationId: string | undefined;
  let launcherReused = false;
  let leaseStarted = false;
  let launcherError: Error | null = null;

  if (descriptorPath) {
    try {
      const session = await startLauncherBrowserTurn({
        descriptorPath,
        activity: {
          phase: "start",
          traceId: turnTraceId,
          helperPid: process.pid,
          conversationKey,
          connectorIdentity: definition.browser.connectorIdentity,
          provider: definition.browser.launcherProviderId,
          requireRetainedConversation: false,
        },
        signal: abortSignal,
        resolveSurfaceId: definition.browser.resolveSurfaceId,
      });
      if (session) {
        leaseStarted = true;
        surfaceId = session.surfaceId;
        leaseConversationId = session.conversationId;
        launcherReused = session.reused;
        launcherConnection = session.connection;
        page = session.connection.page;
      }
    } catch (err) {
      launcherError = err instanceof Error ? err : new Error(String(err));
      if (definition.policies?.launcherFailureMode === "fallback-local") {
        console.warn(
          `[${definition.logPrefix}] Không thể kết nối Launcher qua CDP: ${launcherError.message}. Sẽ thử local Chrome.`,
        );
      } else {
        console.error(
          `[${definition.logPrefix}] Không thể kết nối Launcher qua CDP:`,
          err,
        );
      }
    }
  }

  if (!page) {
    const failureMode =
      definition.policies?.launcherFailureMode ?? "fail-closed";
    if (descriptorPath && failureMode === "fail-closed") {
      throw new Error(
        `[${definition.logPrefix}] Không thể kết nối với Launcher browser tab${launcherError ? `: ${launcherError.message}` : "."}`,
      );
    }
    if (!localBrowser) {
      throw new Error(
        `[${definition.logPrefix}] Không có LocalBrowserRuntime khả dụng để mở trình duyệt.`,
      );
    }
    page = await localBrowser.ensurePage();
  }

  return {
    descriptorPath: descriptorPath ?? undefined,
    launcherConnection,
    page,
    surfaceId,
    leaseConversationId,
    launcherReused,
    leaseStarted,
  };
}

export async function releaseWebTurnSurface(options: {
  definition: WebProviderDefinition;
  acquired: AcquiredWebTurnSurface;
  turnTraceId: string;
  finalStatus: WebTurnFinalStatus;
  activeConversationId?: string;
  conversationKey?: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const {
    definition,
    acquired,
    turnTraceId,
    finalStatus,
    activeConversationId,
    conversationKey,
    abortSignal,
  } = options;

  const manageInEngine =
    definition.policies?.manageLauncherLeaseInEngine ?? true;
  if (!manageInEngine) return;

  if (acquired.descriptorPath && acquired.leaseStarted) {
    const binding = definition.conversation.resolveEndTurnBinding
      ? definition.conversation.resolveEndTurnBinding({
          finalStatus,
          activeConversationId,
          conversationKey,
        })
      : {
          connectorBound: finalStatus === "completed",
          conversationId: activeConversationId,
        };

    await endLauncherBrowserTurn({
      descriptorPath: acquired.descriptorPath,
      activity: {
        phase: "end",
        traceId: turnTraceId,
        helperPid: process.pid,
        provider: definition.browser.launcherProviderId,
        status: finalStatus,
        retain: true,
        connectorBound: binding.connectorBound,
        ...(binding.conversationId
          ? { conversationId: binding.conversationId }
          : {}),
      },
      signal: abortSignal,
      onError: releaseErr => {
        console.warn(
          `[${definition.logPrefix}] Không thể gửi phase=end tới launcher:`,
          releaseErr,
        );
      },
    });
  }

  if (definition.policies?.closeLauncherConnectionOnEnd ?? true) {
    await closeLauncherBrowserTurn(acquired.launcherConnection);
  }
}
