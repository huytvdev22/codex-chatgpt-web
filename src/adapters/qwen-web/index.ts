import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../base";
import { QwenBrowserWorker } from "./qwen-browser-worker";
import { isValidQwenConversationId, QWEN_SELECTORS } from "./selectors";
import {
  defaultQwenConversationStore,
  qwenConversationKey,
} from "./conversation-store";
import { LocalBrowserRuntime } from "../web/local-browser-runtime";
import { WebProviderAdapter } from "../web/web-provider-adapter";

export interface QwenAdapterOptions {
  userDataDir?: string;
  headless?: boolean;
  descriptorPath?: string;
  maxFormatRetries?: number;
}

export class QwenWebAdapter extends WebProviderAdapter {
  override readonly name = "qwen-web";
  private options: QwenAdapterOptions;
  private worker: QwenBrowserWorker;

  constructor(options?: QwenAdapterOptions) {
    const resolvedOptions: QwenAdapterOptions = {
      userDataDir: options?.userDataDir || join(homedir(), ".codex-qwen-web"),
      headless: options?.headless ?? false,
      maxFormatRetries: options?.maxFormatRetries ?? 2,
      ...options,
    };
    const localBrowser = new LocalBrowserRuntime({
      profileDir: resolvedOptions.userDataDir!,
      headless: resolvedOptions.headless,
      logPrefix: "qwen-adapter",
    });
    const worker = new QwenBrowserWorker();

    super(
      {
        id: "qwen-web",
        assistantName: "Qwen",
        logPrefix: "qwen-adapter",
        abortMessage: "Qwen turn aborted before start",
        policies: {
          launcherFailureMode: "fail-closed",
          emitErrorEventOnFailure: false,
          rethrowError: true,
          maxFormatRetries: resolvedOptions.maxFormatRetries ?? 2,
        },
        conversation: {
          resolveConversationKey: ({ parsed, threadId }) =>qwenConversationKey(parsed, threadId),
          resolveState: ({
            threadId,
            leaseConversationId,
            hasPriorAssistantReply,
          }) => {
            const storedConvId =
              defaultQwenConversationStore.getConversationId(threadId);
            const rawExistingConvId = leaseConversationId || storedConvId;
            const existingConversationId = isValidQwenConversationId(
              rawExistingConvId || "",
            )
              ? rawExistingConvId
              : undefined;
            const isNewConversation =
              !hasPriorAssistantReply && !existingConversationId;
            return { existingConversationId, isNewConversation };
          },
          onConversationUpdated: ({ threadId, conversationId }) => {
            if (isValidQwenConversationId(conversationId || "")) {
              defaultQwenConversationStore.setConversationId(
                threadId,
                conversationId!,
              );
              console.log(
                `[qwen-adapter] Đã ghi nhận conversationId: "${conversationId}" (threadId="${threadId || "active"}")`,
              );
              return conversationId;
            }
            return undefined;
          },
          resolveEndTurnBinding: ({ finalStatus, activeConversationId }) => {
            const isConvValid = isValidQwenConversationId(
              activeConversationId || "",
            );
            return {
              connectorBound: finalStatus === "completed" && isConvValid,
              conversationId: isConvValid ? activeConversationId : undefined,
            };
          },
        },
        capability: {
          resolveReasoningEffort: parsed => parsed.options.reasoning || "low",
        },
        browser: {
          descriptorPath: resolvedOptions.descriptorPath,
          launcherProviderId: "qwen",
          connectorIdentity: "qwen-web",
          resolveSurfaceId: (descriptor, leaseSurfaceId) =>
            leaseSurfaceId || descriptor.qwenSurfaceId || descriptor.surfaceId,
          executeTurn: async ({
            page,
            prompt,
            attempt,
            incoming,
            heartbeat,
            reasoningEffort,
            existingConversationId,
            isNewConversation,
          }) => {
            if (!page) {
              throw new Error(
                "[qwen-adapter] Không có trình duyệt khả dụng để thực thi lượt.",
              );
            }
            const maxRetries = resolvedOptions.maxFormatRetries ?? 2;
            console.log(
              `[qwen-adapter] Thực thi lượt (lần thử ${attempt + 1}/${maxRetries + 1})...`,
            );
            return worker.executeTurn(page, {
              prompt,
              signal: incoming.abortSignal,
              heartbeat,
              reasoningEffort: (reasoningEffort || "low") as
                | "low"
                | "medium"
                | "high",
              conversationId: existingConversationId,
              isNewConversation,
              onChunk: () => {},
            });
          },
        },
        response: {
          createCallId: () =>
            `call_qwen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        },
      },
      localBrowser,
    );

    this.options = resolvedOptions;
    this.worker = worker;
  }

  async abortTurn(): Promise<void> {
    const activePage = this.localBrowser?.getActivePage();
    if (activePage) {
      await activePage
        .locator(QWEN_SELECTORS.stopButton)
        .first()
        .click()
        .catch(() => {});
    }
  }

  async cleanup(): Promise<void> {
    await this.localBrowser?.closeSafely();
  }
}

export function createQwenWebAdapter(
  options?: QwenAdapterOptions,
): ProviderAdapter {
  return new QwenWebAdapter(options);
}
