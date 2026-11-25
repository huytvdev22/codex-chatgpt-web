import { randomUUID } from "node:crypto";
import { hasActualPriorAssistantReply, type ProviderAdapter } from "../base";
import type { CodexParsedRequest } from "../../types";
import { computeAccurateTurnUsage } from "../../usage";
import { CodexPayloadNormalizer, CodexRawPayload } from "../web/normalization";
import { isStructuredJsonOutputTurn } from "../web/prompt";
import { WebProviderAdapter } from "../web/web-provider-adapter";
import {
  GeminiAttachments,
  geminiImageFilePayloads,
  type GeminiAttachmentPayload,
} from "./attachments";
import { GeminiCapabilityPicker } from "./capability-picker";
import { geminiConversationKey } from "./conversation-key";
import {
  buildGeminiConversationUrl,
  GEMINI_CONVERSATION_ID_WAIT_TIMEOUT_MS,
  GEMINI_HOME_URL,
  GEMINI_ORIGIN,
  isGeminiAuthUrl,
  normalizeGeminiConversationId,
  parseGeminiConversationId,
  waitForGeminiConversationId,
} from "./conversation-url";
import {
  GeminiBrowserWorker,
  type GeminiBrowserRunOptions,
  type GeminiTurnResult,
} from "./gemini-browser-worker";
import {
  GeminiClipboardSalvage,
  normalizeCopiedGeminiSnippet,
  selectPreferredGeminiResponse,
} from "./gemini-clipboard-salvage";
import {
  GeminiDomObserver,
  type GeminiDomStatus,
  type GeminiObserverRuntimeState,
  type GeminiResponseBaseline,
  type GeminiResponseObservation,
} from "./gemini-dom-observer";
import {
  buildGeminiDiscoveredModels,
  GeminiModelDiscovery,
  normalizeGeminiSlugFromLabel,
} from "./model-discovery";
import {
  GEMINI_DEFAULT_MODEL_SLUG,
  GeminiModelProvider,
  type GeminiCapabilityTarget,
  type GeminiModelRouteDefinition,
  type GeminiThinkingEffort,
} from "./model-provider";
import { GEMINI_SELECTORS } from "./selectors";

export {
  GeminiBrowserWorker,
  type GeminiBrowserRunOptions,
  type GeminiTurnResult,
};
export {
  GeminiClipboardSalvage,
  normalizeCopiedGeminiSnippet,
  selectPreferredGeminiResponse,
};
export {
  GeminiDomObserver,
  type GeminiDomStatus,
  type GeminiObserverRuntimeState,
  type GeminiResponseBaseline,
  type GeminiResponseObservation,
};
export { GeminiCapabilityPicker };
export {
  GeminiAttachments,
  geminiImageFilePayloads,
  type GeminiAttachmentPayload,
};
export { geminiConversationKey };
export {
  buildGeminiConversationUrl,
  GEMINI_CONVERSATION_ID_WAIT_TIMEOUT_MS,
  GEMINI_HOME_URL,
  GEMINI_ORIGIN,
  isGeminiAuthUrl,
  normalizeGeminiConversationId,
  parseGeminiConversationId,
  waitForGeminiConversationId,
};
export {
  GEMINI_DEFAULT_MODEL_SLUG,
  GeminiModelProvider,
  type GeminiCapabilityTarget,
  type GeminiModelRouteDefinition,
  type GeminiThinkingEffort,
};
export { GEMINI_SELECTORS };
export {
  buildGeminiDiscoveredModels,
  GeminiModelDiscovery,
  normalizeGeminiSlugFromLabel,
};

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
 * Adapter Gemini Web (`gemini.google.com`) điều phối qua `WebTurnEngine`
 * và thực thi trực tiếp qua Playwright CDP trên tab Launcher.
 */
export class GeminiAdapter extends WebProviderAdapter {
  override readonly name = "gemini";
  private readonly worker: GeminiBrowserWorker;

  constructor() {
    const worker = new GeminiBrowserWorker();
    const modelDiscovery = new GeminiModelDiscovery();
    super({
      id: "gemini",
      assistantName: "Gemini",
      logPrefix: "gemini-adapter",
      abortMessage: "Gemini turn aborted before start",
      policies: {
        launcherFailureMode: "fail-closed",
        enableEarlyExitOnFinalAnswer: true,
        enableToolLoopGuard: true,
        emitErrorEventOnFailure: true,
        errorMessagePrefix: "[Gemini]",
        rethrowError: false,
        abortedTurnMessage: "Gemini turn aborted",
        maxPromptChars: 120_000,
      },
      conversation: {
        resolveConversationKey: ({ parsed, incoming, turnTraceId }) => {
          if (isEphemeralStructuredTurn(parsed)) {
            return geminiConversationKey(
              parsed,
              `ephemeral:${turnTraceId || randomUUID()}`,
            );
          }
          const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
          const rawConversationKey =
            incoming.headers.get("x-codex-conversation-key") ||
            rawPayload.getThreadId() ||
            undefined;
          return geminiConversationKey(parsed, rawConversationKey);
        },
        resolveState: ({
          leaseConversationId,
          launcherReused,
          hasPriorAssistantReply,
        }) => {
          const existingConversationId =
            normalizeGeminiConversationId(leaseConversationId);
          return {
            existingConversationId,
            isNewConversation:
              !launcherReused &&
              !hasPriorAssistantReply &&
              !existingConversationId,
          };
        },
        onConversationUpdated: ({ conversationId }) =>
          normalizeGeminiConversationId(conversationId),
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
            normalizeGeminiConversationId(activeConversationId);
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
        extractAttachments: ({ parsed, attempt, normalized }) => {
          if (attempt !== 0) return [];
          if (normalized) return normalized.images ?? [];
          const payload = CodexRawPayload.from(parsed._rawBody || parsed);
          return (
            CodexPayloadNormalizer.normalize(payload, { maxImages: 3 })
              .images ?? []
          );
        },
      },
      browser: {
        launcherProviderId: "gemini",
        connectorIdentity: "gemini",
        resolveSurfaceId: (descriptor, leaseSurfaceId) =>
          leaseSurfaceId ||
          descriptor.providerSurfaceIds?.gemini ||
          descriptor.surfaceId,
        resolveInitialUrl: ({ existingConversationId }) =>
          existingConversationId
            ? buildGeminiConversationUrl(existingConversationId)
            : GEMINI_HOME_URL,
        executeTurn: async ({
          page,
          prompt,
          attempt,
          parsed,
          incoming,
          conversationKey,
          existingConversationId,
          launcherReused,
          isNewConversation,
          retain,
          attachments,
          heartbeat,
        }) => {
          if (!page) {
            throw new Error(
              "[gemini-adapter] Không có Playwright Page kết nối CDP tới Launcher.",
            );
          }
          return worker.executeTurn(page, {
            prompt,
            onChunk: () => {},
            signal: incoming.abortSignal,
            conversationKey,
            existingConversationId,
            launcherReused,
            isNewConversation: attempt === 0 ? isNewConversation : false,
            retain,
            heartbeat,
            modelSlug: parsed.modelId,
            reasoning: parsed.options.reasoning,
            images: attachments,
          });
        },
        discoverModels: async ({ page }) => await modelDiscovery.discoverModels(page),
      },
      response: {
        createCallId: () =>
          `call_gemini_${Math.random().toString(36).slice(2, 10)}`,
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
 * Factory khởi tạo đối tượng `GeminiAdapter`.
 */
export function createGeminiAdapter(): ProviderAdapter {
  return new GeminiAdapter();
}
