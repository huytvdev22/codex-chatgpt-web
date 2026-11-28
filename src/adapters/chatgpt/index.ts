import { randomUUID } from "node:crypto";
import { hasActualPriorAssistantReply, type ProviderAdapter } from "../base";
import type { CodexParsedRequest } from "../../types";
import { computeAccurateTurnUsage } from "../../usage";
import { CodexPayloadNormalizer, CodexRawPayload } from "../web/normalization";
import { isStructuredJsonOutputTurn } from "../web/prompt";
import { WebProviderAdapter } from "../web/web-provider-adapter";
import type { WebAttachmentExtractContext } from "../web/definition";
import {
  ChatGptBrowserWorker,
  isChatGptGenerationRequest,
  type ChatGptBrowserRunOptions,
  type ChatGptTurnResult,
} from "./chatgpt-browser-worker";
import {
  ChatGptClipboardSalvage,
  normalizeCopiedChatGptSnippet,
  selectPreferredChatGptResponse,
} from "./chatgpt-clipboard-salvage";
import {
  ChatGptDomObserver,
  type ChatGptDomStatus,
  type ChatGptObserverRuntimeState,
  type ChatGptResponseBaseline,
  type ChatGptResponseObservation,
} from "./chatgpt-dom-observer";
import { ChatGptCapabilityPicker } from "./capability-picker";
import {
  ChatGptAttachments,
  chatGptImageFilePayloads,
  type ChatGptAttachmentOptions,
  type ChatGptAttachmentPayload,
} from "./attachments";
import { chatGptConversationKey } from "./conversation-key";
import {
  buildChatGptConversationUrl,
  CHATGPT_CONVERSATION_ID_WAIT_TIMEOUT_MS,
  CHATGPT_HOME_URL,
  CHATGPT_ORIGIN,
  isChatGptAuthUrl,
  normalizeChatGptConversationId,
  parseChatGptConversationId,
  waitForChatGptConversationId,
} from "./conversation-url";
import { ChatGptModelDiscovery } from "./model-discovery";
import {
  CHATGPT_USAGE_URL,
  ChatGptUsageLimitChecker,
} from "./usage-limit-checker";
import {
  CHATGPT_DEFAULT_MODEL_SLUG,
  ChatGptModelProvider,
  type ChatGptCapabilityTarget,
  type ChatGptModelRouteDefinition,
  type ChatGptThinkingEffort,
} from "./model-provider";
import { CHATGPT_SELECTORS } from "./selectors";

export {
  ChatGptBrowserWorker,
  isChatGptGenerationRequest,
  type ChatGptBrowserRunOptions,
  type ChatGptTurnResult,
};
export {
  ChatGptClipboardSalvage,
  normalizeCopiedChatGptSnippet,
  selectPreferredChatGptResponse,
};
export {
  ChatGptDomObserver,
  type ChatGptDomStatus,
  type ChatGptObserverRuntimeState,
  type ChatGptResponseBaseline,
  type ChatGptResponseObservation,
};
export { ChatGptCapabilityPicker };
export {
  ChatGptAttachments,
  chatGptImageFilePayloads,
  type ChatGptAttachmentOptions,
  type ChatGptAttachmentPayload,
};
export { chatGptConversationKey };
export {
  buildChatGptConversationUrl,
  CHATGPT_CONVERSATION_ID_WAIT_TIMEOUT_MS,
  CHATGPT_HOME_URL,
  CHATGPT_ORIGIN,
  isChatGptAuthUrl,
  normalizeChatGptConversationId,
  parseChatGptConversationId,
  waitForChatGptConversationId,
};
export {
  CHATGPT_DEFAULT_MODEL_SLUG,
  ChatGptModelProvider,
  type ChatGptCapabilityTarget,
  type ChatGptModelRouteDefinition,
  type ChatGptThinkingEffort,
};
export { CHATGPT_SELECTORS };
export {
  buildChatGptDiscoveredModels,
  ChatGptModelDiscovery,
  inferChatGptShortUiVersion,
  normalizeChatGptSlugFromLabel,
} from "./model-discovery";
export {
  CHATGPT_USAGE_SCOPE_NOTE,
  CHATGPT_USAGE_URL,
  ChatGptUsageLimitChecker,
  formatChatGptPlanName,
  formatDurationCompact,
  parseChatGptUsageDomSnapshot,
  parseChatGptWhamUsagePayload,
  type ChatGptUsageDomProgressItem,
  type ChatGptUsageDomSnapshot,
  type ChatGptWhamRateLimit,
  type ChatGptWhamRateWindow,
  type ChatGptWhamUsagePayload,
} from "./usage-limit-checker";

function shouldIncludeChatGptAttachments(
  context: WebAttachmentExtractContext,
): boolean {
  if (
    context.isPostSubmitRetry === true ||
    context.retryKind === "format" ||
    context.retryKind === "tool_describe" ||
    context.retryKind === "tool_recovery"
  ) {
    return false;
  }

  if (
    context.originalMessageSubmitted === true &&
    context.isNewConversation !== true
  ) {
    return false;
  }

  if (
    context.isNewConversation === true ||
    context.retryKind === "initial" ||
    context.retryKind === "pre_submit" ||
    context.retryKind === "transport" ||
    context.retryKind === "failover" ||
    context.originalMessageSubmitted === false
  ) {
    return true;
  }

  return context.attempt === 0;
}

function isEphemeralStructuredTurn(
  parsed?: CodexParsedRequest,
  hasPriorAssistantReply?: boolean,
  hasToolResults?: boolean,
): boolean {
  if (!parsed) return false;
  const priorAssistant =
    hasPriorAssistantReply ??
    hasActualPriorAssistantReply(parsed.context?.messages);
  const trailingTools =
    hasToolResults ??
    parsed.context?.messages?.some((message) => message.role === "toolResult") ??
    false;
  return isStructuredJsonOutputTurn(parsed, trailingTools) && !priorAssistant;
}

/**
 * Adapter ChatGPT Web (`chatgpt.com`) điều phối qua `WebTurnEngine`
 * và thực thi trực tiếp qua Playwright CDP trên tab Launcher.
 */
export class ChatGptAdapter extends WebProviderAdapter {
  override readonly name = "chatgpt";
  private readonly worker: ChatGptBrowserWorker;

  constructor() {
    const worker = new ChatGptBrowserWorker();
    const modelDiscovery = new ChatGptModelDiscovery();
    const usageLimitChecker = new ChatGptUsageLimitChecker();
    super({
      id: "chatgpt",
      assistantName: "ChatGPT",
      logPrefix: "chatgpt-adapter",
      abortMessage: "ChatGPT turn aborted before start",
      policies: {
        launcherFailureMode: "fail-closed",
        enableEarlyExitOnFinalAnswer: true,
        enableToolLoopGuard: true,
        emitErrorEventOnFailure: true,
        errorMessagePrefix: "[ChatGPT]",
        rethrowError: false,
        abortedTurnMessage: "ChatGPT turn aborted",
        maxPromptChars: 120_000,
      },
      conversation: {
        resolveConversationKey: ({ parsed, incoming, turnTraceId }) => {
          if (isEphemeralStructuredTurn(parsed)) {
            return chatGptConversationKey(
              parsed,
              `ephemeral:${turnTraceId || randomUUID()}`,
            );
          }
          const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
          const rawConversationKey =
            incoming.headers.get("x-codex-conversation-key") ||
            rawPayload.getThreadId() ||
            undefined;
          return chatGptConversationKey(parsed, rawConversationKey);
        },
        resolveState: ({
          leaseConversationId,
          launcherReused,
        }) => {
          const existingConversationId =
            normalizeChatGptConversationId(leaseConversationId);
          return {
            existingConversationId,
            isNewConversation:
              !launcherReused &&
              !existingConversationId,
          };
        },
        onConversationUpdated: ({ conversationId }) =>
          normalizeChatGptConversationId(conversationId),
        resolveEndTurnBinding: ({
          finalStatus,
          activeConversationId,
          parsed,
          hasPriorAssistantReply,
          hasToolResults,
        }) => {
          if (
            finalStatus !== "completed" ||
            isEphemeralStructuredTurn(
              parsed,
              hasPriorAssistantReply,
              hasToolResults,
            )
          ) {
            return {
              connectorBound: false,
              retain: false,
            };
          }
          const normalizedId =
            normalizeChatGptConversationId(activeConversationId);
          return {
            connectorBound: Boolean(normalizedId),
            ...(normalizedId ? { conversationId: normalizedId } : {}),
            retain: true,
          };
        },
      },
      capability: {
        resolveReasoningEffort: (parsed) => parsed.options.reasoning || "medium",
      },
      attachments: {
        maxInputImages: 3,
        extractAttachments: (context) => {
          if (!shouldIncludeChatGptAttachments(context)) return [];
          const { parsed, normalized } = context;
          if (normalized) return (normalized.images ?? []).slice(0, 3);
          const payload = CodexRawPayload.from(parsed._rawBody || parsed);
          return (
            CodexPayloadNormalizer.normalize(payload, { maxImages: 3 })
              .images ?? []
          );
        },
      },
      browser: {
        launcherProviderId: "chatgpt",
        connectorIdentity: "chatgpt",
        resolveSurfaceId: (descriptor, leaseSurfaceId) =>
          leaseSurfaceId ||
          descriptor.providerSurfaceIds?.chatgpt ||
          descriptor.surfaceId,
        resolveInitialUrl: ({ existingConversationId }) =>
          existingConversationId
            ? buildChatGptConversationUrl(existingConversationId)
            : CHATGPT_HOME_URL,
        executeTurn: async ({
          page,
          prompt,
          parsed,
          incoming,
          conversationKey,
          existingConversationId,
          launcherReused,
          isNewConversation,
          retain,
          attachments,
          streamIncremental,
          onChunk,
          onTextSnapshot,
          heartbeat,
        }) => {
          if (!page) {
            throw new Error(
              "[chatgpt-adapter] Không có Playwright Page kết nối CDP tới Launcher.",
            );
          }
          return worker.executeTurn(page, {
            prompt,
            onChunk: onChunk ?? (() => {}),
            onTextSnapshot,
            streamIncremental: streamIncremental === true,
            signal: incoming.abortSignal,
            conversationKey,
            existingConversationId,
            launcherReused,
            isNewConversation,
            retain,
            heartbeat,
            modelSlug: parsed.modelId,
            reasoning: parsed.options.reasoning,
            images: attachments,
          });
        },
        discoverModels: async ({ page }) => await modelDiscovery.discoverModels(page),
        usageLimitUrl: CHATGPT_USAGE_URL,
        checkUsageLimit: async ({ page, abortSignal }) =>
          await usageLimitChecker.check(page, abortSignal),
      },
      response: {
        createCallId: () =>
          `call_chatgpt_${Math.random().toString(36).slice(2, 10)}`,
        includeDetailedDoneEvent: true,
        toolCallStopReason: "tool_use",
        toolCallEndTurn: false,
        computeUsage: ({
          initialPrompt,
          lastRaw,
          prompts,
          rawOutputs,
          providerReportedTokens,
        }) =>
          computeAccurateTurnUsage({
            prompts: prompts ?? [initialPrompt],
            rawOutputs: rawOutputs ?? [lastRaw],
            providerReportedTokens,
          }).usage,
      },
    });
    this.worker = worker;
  }
}

/**
 * Factory khởi tạo đối tượng `ChatGptAdapter`.
 */
export function createChatGptAdapter(): ProviderAdapter {
  return new ChatGptAdapter();
}
