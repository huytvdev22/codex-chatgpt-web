import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexParsedRequest } from "../../types";
import { ChatGptBrowserWorker } from "./chatgpt-browser-worker";
import {
  defaultChatGptConversationStore,
  chatGptConversationKey,
  isValidChatGptConversationId,
} from "./conversation-store";
import { compileWebPrompt } from "../web/compile-prompt";
import { LocalBrowserRuntime } from "../web/local-browser-runtime";
import { WebProviderAdapter } from "../web/web-provider-adapter";

export interface ChatGptAdapterOptions {
  userDataDir?: string;
  headless?: boolean;
  descriptorPath?: string;
  maxFormatRetries?: number;
}

export class ChatGptWebAdapter extends WebProviderAdapter {
  override readonly name = "chatgpt-web";
  private options: ChatGptAdapterOptions;
  private worker: ChatGptBrowserWorker;

  constructor(options?: ChatGptAdapterOptions) {
    const resolvedOptions: ChatGptAdapterOptions = {
      userDataDir:
        options?.userDataDir || join(homedir(), ".codex-chatgpt-web"),
      headless: options?.headless ?? false,
      maxFormatRetries: options?.maxFormatRetries ?? 2,
      ...options,
    };
    const localBrowser = new LocalBrowserRuntime({
      profileDir: resolvedOptions.userDataDir!,
      headless: resolvedOptions.headless,
      logPrefix: "chatgpt-adapter",
    });
    const worker = new ChatGptBrowserWorker();

    super(
      {
        id: "chatgpt-web",
        assistantName: "ChatGPT",
        logPrefix: "chatgpt-adapter",
        abortMessage: "ChatGpt turn aborted before start",
        compilePrompt: (parsed, isNewConversation) =>
          this.compilePrompt(parsed, isNewConversation),
        policies: {
          launcherFailureMode: "fail-closed",
          emitErrorEventOnFailure: true,
          rethrowError: true,
          maxFormatRetries: resolvedOptions.maxFormatRetries ?? 2,
        },
        conversation: {
          resolveConversationKey: ({ parsed, threadId }) =>
            chatGptConversationKey(parsed, threadId),
          resolveState: ({
            threadId,
            leaseConversationId,
            hasPriorAssistantReply,
          }) => {
            const storedConvId =
              defaultChatGptConversationStore.getConversationId(threadId);
            const rawExistingConvId = leaseConversationId || storedConvId;
            const existingConversationId = isValidChatGptConversationId(
              rawExistingConvId,
            )
              ? rawExistingConvId
              : undefined;
            const isNewConversation =
              !hasPriorAssistantReply && !existingConversationId;
            return { existingConversationId, isNewConversation };
          },
          onConversationUpdated: ({ threadId, conversationId }) => {
            if (isValidChatGptConversationId(conversationId)) {
              defaultChatGptConversationStore.setConversationId(
                threadId,
                conversationId,
              );
              console.log(
                `[chatgpt-adapter] Đã ghi nhận conversationId: "${conversationId}" (threadId="${threadId || "active"}")`,
              );
              return conversationId;
            }
            return undefined;
          },
          resolveEndTurnBinding: ({ finalStatus, activeConversationId }) => {
            const isConvValid =
              isValidChatGptConversationId(activeConversationId);
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
          launcherProviderId: "chatgpt",
          connectorIdentity: "chatgpt-web",
          resolveSurfaceId: (descriptor, leaseSurfaceId) =>
            leaseSurfaceId ||
            descriptor.chatGptSurfaceId ||
            descriptor.surfaceId,
          executeTurn: async ({
            page,
            prompt,
            attempt,
            incoming,
            heartbeat,
            existingConversationId,
            isNewConversation,
          }) => {
            if (!page) {
              throw new Error(
                "[chatgpt-adapter] Không có trình duyệt khả dụng để thực thi lượt.",
              );
            }
            const maxRetries = resolvedOptions.maxFormatRetries ?? 2;
            console.log(
              `[chatgpt-adapter] Thực thi lượt (lần thử ${attempt + 1}/${maxRetries + 1})...`,
            );
            return worker.executeTurn(page, {
              prompt,
              signal: incoming.abortSignal,
              heartbeat,
              conversationId: existingConversationId,
              isNewConversation,
              onChunk: () => {},
            });
          },
        },
        response: {
          createCallId: () =>
            `call_chatgpt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        },
      },
      localBrowser,
    );

    this.options = resolvedOptions;
    this.worker = worker;
  }

  /**
   * Compatibility wrapper retained for existing adapter contract tests and
   * callers that inspect ChatGPT prompt compilation directly.
   */
  private compilePrompt(
    parsed: CodexParsedRequest,
    isNewConversation: boolean,
  ): string {
    return compileWebPrompt(parsed, {
      assistantName: "ChatGPT",
      isNewConversation,
    }).finalPrompt;
  }
}

export function createChatGptWebAdapter(
  options?: ChatGptAdapterOptions,
): ChatGptWebAdapter {
  return new ChatGptWebAdapter(options);
}

export * from "./selectors";
export * from "./chatgpt-browser-worker";
export * from "./conversation-store";
