import { randomUUID } from "node:crypto";
import {
  hasActualPriorAssistantReply,
  type IncomingMeta,
  type ProviderAdapter,
  type SpeechTurnRequest,
  type SpeechTurnResult,
} from "../base";
import type { CodexParsedRequest } from "../../types";
import { computeAccurateTurnUsage } from "../../usage";
import { CodexRawPayload } from "../web/normalization";
import { isStructuredJsonOutputTurn } from "../web/prompt";
import { WebProviderAdapter } from "../web/web-provider-adapter";
import { AiStudioModelDiscovery } from "./model-discovery";
import { AiStudioBrowserWorker } from "./ai-studio-browser-worker";
import {
  AI_STUDIO_DEFAULT_TTS_MODEL,
  AiStudioSpeechWorker,
  buildAiStudioSpeechUrl,
} from "./ai-studio-speech-worker";
import { aiStudioConversationKey } from "./conversation-key";
import {
  AI_STUDIO_DEFAULT_MODEL_SLUG,
  buildAiStudioConversationUrl,
  buildAiStudioNewChatUrl,
} from "./conversation-url";

export {
  AiStudioBrowserWorker,
  isAiStudioGenerationRequest,
  selectPreferredAiStudioResponse,
  type AiStudioBrowserRunOptions,
  type AiStudioTurnResult,
} from "./ai-studio-browser-worker";
export {
  AiStudioSpeechWorker,
  AI_STUDIO_DEFAULT_TTS_MODEL,
  buildAiStudioSpeechUrl,
  orderSpeakersByTranscript,
  parseGeminiSpeechScript,
  type AiStudioSpeechResult,
  type AiStudioSpeechRunOptions,
  type ParsedSpeechScript,
  type SpeechSpeakerConfig,
} from "./ai-studio-speech-worker";
export {
  AiStudioCapabilityPicker,
  type AiStudioCapabilityResult,
  type AiStudioCapabilityTarget,
} from "./capability-picker";
export {
  AiStudioModelProvider,
  type AiStudioModelRouteDefinition,
  type AiStudioThinkingLevel,
} from "./model-provider";
export { aiStudioConversationKey } from "./conversation-key";
export {
  AI_STUDIO_CONVERSATION_ID_WAIT_TIMEOUT_MS,
  AI_STUDIO_DEFAULT_MODEL_SLUG,
  AI_STUDIO_NEW_CHAT_URL,
  AI_STUDIO_ORIGIN,
  buildAiStudioConversationUrl,
  buildAiStudioNewChatUrl,
  normalizeAiStudioConversationId,
  parseAiStudioConversationId,
  waitForAiStudioConversationId,
} from "./conversation-url";
export {
  AiStudioModelDiscovery,
  buildAiStudioDiscoveredModels,
  normalizeAiStudioRemoteModelId,
  parseAiStudioContextWindow,
} from "./model-discovery";

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
 * Adapter Google AI Studio Web (`aistudio.google.com`) điều phối qua `WebTurnEngine`
 * và thực thi trực tiếp qua Playwright CDP trên tab Launcher.
 */
export class AiStudioAdapter extends WebProviderAdapter {
  override readonly name = "ai-studio";
  private readonly worker: AiStudioBrowserWorker;
  private readonly speechWorker = new AiStudioSpeechWorker();

  constructor() {
    const worker = new AiStudioBrowserWorker();
    const modelDiscovery = new AiStudioModelDiscovery();
    super({
      id: "ai-studio",
      assistantName: "Gemini",
      logPrefix: "ai-studio-adapter",
      abortMessage: "AI Studio turn aborted before start",
      policies: {
        launcherFailureMode: "fail-closed",
        enableEarlyExitOnFinalAnswer: true,
        enableToolLoopGuard: true,
        emitErrorEventOnFailure: true,
        errorMessagePrefix: "[AI Studio]",
        rethrowError: false,
        abortedTurnMessage: "AI Studio turn aborted",
        maxPromptChars: 350_000,
      },
      conversation: {
        resolveConversationKey: ({ parsed, incoming, turnTraceId }) => {
          if (isEphemeralStructuredTurn(parsed)) {
            return aiStudioConversationKey(
              parsed,
              `ephemeral:${turnTraceId || randomUUID()}`,
            );
          }
          const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
          const rawConversationKey =
            incoming.headers.get("x-codex-conversation-key") ||
            rawPayload.getThreadId() ||
            undefined;
          return aiStudioConversationKey(parsed, rawConversationKey);
        },
        resolveState: ({
          leaseConversationId,
          launcherReused,
        }) => ({
          existingConversationId: leaseConversationId,
          isNewConversation:
            !launcherReused &&
            !leaseConversationId,
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
          return {
            connectorBound: Boolean(activeConversationId),
            ...(activeConversationId ? { conversationId: activeConversationId } : {}),
            retain: true,
          };
        },
      },
      attachments: {
        maxInputImages: 3,
      },
      browser: {
        launcherProviderId: "ai-studio",
        resolveSurfaceId: (descriptor, leaseSurfaceId) =>
          leaseSurfaceId || descriptor.providerSurfaceIds?.["ai-studio"] || descriptor.surfaceId,
        resolveInitialUrl: ({ modelId, existingConversationId }) => {
          if (existingConversationId) {
            return buildAiStudioConversationUrl(existingConversationId);
          }
          const cleanModel =
            modelId.replace(/^ai-studio\//i, "").trim() ||
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
              "[ai-studio-adapter] Không có Playwright Page kết nối CDP tới Launcher.",
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
        createCallId: () => `call_aistudio_${Math.random().toString(36).slice(2, 10)}`,
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

  /**
   * Thực thi tác vụ Text-to-Speech / Podcast trên giao diện `/generate-speech`,
   * tái sử dụng tab Launcher đã giữ lại theo model khi lượt trước thành công
   * và đóng bỏ tab nếu gặp lỗi để lượt sau mở tab sạch mới.
   */
  async runSpeechTurn(
    request: SpeechTurnRequest,
    incoming: IncomingMeta,
  ): Promise<SpeechTurnResult> {
    const cleanModel =
      request.modelId.replace(/^ai-studio\//i, "").trim() ||
      AI_STUDIO_DEFAULT_TTS_MODEL;
    return await this.engine.runEphemeralSurfaceTask(
      incoming,
      async ({ page, launcherReused, signal, heartbeat }) => {
        if (!page) {
          throw new Error(
            "[ai-studio-adapter] Không có Playwright Page kết nối CDP cho Generate Speech.",
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
        initialUrl: buildAiStudioSpeechUrl(cleanModel),
        conversationKeySource: `speech:${cleanModel}`,
        retainOnCompleted: true,
        omitConnectorIdentity: true,
      },
    );
  }
}

/**
 * Factory khởi tạo đối tượng `AiStudioAdapter`.
 */
export function createAiStudioAdapter(): ProviderAdapter {
  return new AiStudioAdapter();
}
