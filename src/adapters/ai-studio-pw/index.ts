import { randomUUID } from "node:crypto";
import {
  hasActualPriorAssistantReply,
  type IncomingMeta,
  type ProviderAdapter,
  type SpeechTurnRequest,
  type SpeechTurnResult,
} from "../base";
import type { CodexParsedRequest } from "../../types";
import { CodexRawPayload } from "../web/normalization";
import { isStructuredJsonOutputTurn } from "../web/prompt";
import { WebProviderAdapter } from "../web/web-provider-adapter";
import { aiStudioConversationKey } from "../ai-studio/conversation-key";
import {
  AI_STUDIO_DEFAULT_MODEL_SLUG,
  buildAiStudioConversationUrl,
  buildAiStudioNewChatUrl,
} from "../ai-studio/conversation-url";
import { AI_STUDIO_DEFAULT_TTS_MODEL } from "../ai-studio/ai-studio-speech-worker";
import { AiStudioPlaywrightWorker } from "./ai-studio-pw-browser-worker";
import {
  AiStudioPlaywrightSpeechWorker,
  buildAiStudioPlaywrightSpeechUrl,
} from "./ai-studio-pw-speech-worker";

export {
  AiStudioPlaywrightWorker,
  isAiStudioGenerationRequest,
  type AiStudioPlaywrightRunOptions,
  type AiStudioPlaywrightTurnResult,
} from "./ai-studio-pw-browser-worker";
export {
  AiStudioPlaywrightSpeechWorker,
  buildAiStudioPlaywrightSpeechUrl,
} from "./ai-studio-pw-speech-worker";
export {
  AiStudioPlaywrightModelProvider,
  type AiStudioPlaywrightModelRouteDefinition,
} from "./model-provider";

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
    parsed.context?.messages?.some((m) => m.role === "toolResult") ??
    false;
  return isStructuredJsonOutputTurn(parsed, trailingTools) && !priorAssistant;
}

/**
 * Adapter Google AI Studio chạy qua Playwright CDP (`ai-studio-pw/...`)
 * dùng chung Launcher session với `ai-studio` để test A/B công bằng.
 */
export class AiStudioPlaywrightAdapter extends WebProviderAdapter {
  override readonly name = "ai-studio-pw";
  private readonly worker: AiStudioPlaywrightWorker;
  private readonly speechWorker = new AiStudioPlaywrightSpeechWorker();

  constructor() {
    const worker = new AiStudioPlaywrightWorker();
    super({
      id: "ai-studio-pw",
      assistantName: "Gemini",
      logPrefix: "ai-studio-pw-adapter",
      abortMessage: "AI Studio PW turn aborted before start",
      policies: {
        browserTransport: "playwright-cdp",
        launcherFailureMode: "fail-closed",
        enableEarlyExitOnFinalAnswer: true,
        enableToolLoopGuard: true,
        emitErrorEventOnFailure: true,
        errorMessagePrefix: "[AI Studio PW]",
        rethrowError: false,
        abortedTurnMessage: "AI Studio PW turn aborted",
        maxPromptChars: 95_000,
      },
      conversation: {
        resolveConversationKey: ({ parsed, incoming, turnTraceId }) => {
          if (isEphemeralStructuredTurn(parsed)) {
            return aiStudioConversationKey(
              parsed,
              `pw-ephemeral:${turnTraceId || randomUUID()}`,
            );
          }
          const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
          const rawKey =
            incoming.headers.get("x-codex-conversation-key") ||
            rawPayload.getThreadId() ||
            undefined;
          return `pw:${aiStudioConversationKey(parsed, rawKey)}`;
        },
        resolveState: ({
          leaseConversationId,
          launcherReused,
          hasPriorAssistantReply,
        }) => ({
          existingConversationId: leaseConversationId,
          isNewConversation:
            !launcherReused && !hasPriorAssistantReply && !leaseConversationId,
        }),
        onConversationUpdated: ({ conversationId }) => conversationId,
        resolveEndTurnBinding: ({
          finalStatus,
          activeConversationId,
          parsed,
          hasPriorAssistantReply,
          hasToolResults,
        }) => {
          if (
            isEphemeralStructuredTurn(
              parsed,
              hasPriorAssistantReply,
              hasToolResults,
            ) ||
            !activeConversationId
          ) {
            return { connectorBound: false, retain: false };
          }
          return {
            connectorBound: finalStatus === "completed",
            conversationId: activeConversationId,
            retain: true,
          };
        },
      },
      attachments: { maxInputImages: 3 },
      browser: {
        launcherProviderId: "ai-studio",
        connectorIdentity: "ai-studio-pw",
        resolveSurfaceId: (descriptor, leaseSurfaceId) =>
          leaseSurfaceId ||
          descriptor.providerSurfaceIds?.["ai-studio"] ||
          descriptor.surfaceId,
        resolveInitialUrl: ({ modelId, existingConversationId }) => {
          if (existingConversationId) {
            return buildAiStudioConversationUrl(existingConversationId);
          }
          const cleanModel =
            modelId.replace(/^ai-studio(?:-pw)?\//i, "").trim() ||
            AI_STUDIO_DEFAULT_MODEL_SLUG;
          return buildAiStudioNewChatUrl(cleanModel);
        },
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
              "[ai-studio-pw-adapter] Không có Playwright Page kết nối CDP tới Launcher.",
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
      },
      response: {
        createCallId: () =>
          `call_aistudiopw_${Math.random().toString(36).slice(2, 10)}`,
        includeDetailedDoneEvent: true,
        toolCallStopReason: "tool_use",
        toolCallEndTurn: false,
        computeUsage: ({ totalPromptChars, lastRaw }) => {
          const inputTokens = Math.ceil(totalPromptChars / 4);
          const outputTokens = Math.ceil((lastRaw.length || 10) / 4);
          return {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
          };
        },
      },
    });
    this.worker = worker;
  }

  /**
   * Thực thi tác vụ Text-to-Speech trên `/generate-speech` qua Playwright CDP.
   */
  async runSpeechTurn(
    request: SpeechTurnRequest,
    incoming: IncomingMeta,
  ): Promise<SpeechTurnResult> {
    const cleanModel =
      request.modelId.replace(/^ai-studio(?:-pw)?\//i, "").trim() ||
      AI_STUDIO_DEFAULT_TTS_MODEL;
    return await this.engine.runEphemeralSurfaceTask(
      incoming,
      async ({ page, launcherReused, signal, heartbeat }) => {
        if (!page) {
          throw new Error(
            "[ai-studio-pw-adapter] Không có Playwright Page kết nối CDP cho Generate Speech.",
          );
        }
        return await this.speechWorker.executeSpeech(page, {
          modelId: cleanModel,
          text: request.text,
          temperature: request.temperature,
          speakers: request.speakers,
          reusedSurface: launcherReused,
          signal,
          heartbeat,
        });
      },
      {
        initialUrl: buildAiStudioPlaywrightSpeechUrl(cleanModel),
        conversationKeySource: `speech-pw:${cleanModel}`,
        retainOnCompleted: true,
      },
    );
  }
}

export function createAiStudioPlaywrightAdapter(): ProviderAdapter {
  return new AiStudioPlaywrightAdapter();
}
