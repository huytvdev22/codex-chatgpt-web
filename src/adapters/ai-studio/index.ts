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
import { AiStudioBrowserWorker } from "./ai-studio-browser-worker";
import { AiStudioSpeechWorker } from "./ai-studio-speech-worker";
import { aiStudioConversationKey } from "./conversation-key";

export {
  AiStudioBrowserWorker,
  type AiStudioBrowserRunOptions,
  type AiStudioTurnResult,
} from "./ai-studio-browser-worker";
export {
  AiStudioSpeechWorker,
  AI_STUDIO_DEFAULT_TTS_MODEL,
  buildAiStudioSpeechUrl,
  parseGeminiSpeechScript,
  type AiStudioSpeechResult,
  type AiStudioSpeechRunOptions,
  type ParsedSpeechScript,
  type SpeechSpeakerConfig,
} from "./ai-studio-speech-worker";
export {
  AiStudioModelProvider,
  type AiStudioModelRouteDefinition,
  type AiStudioThinkingLevel,
} from "./model-provider";
export { aiStudioConversationKey } from "./conversation-key";
export {
  AI_STUDIO_DEFAULT_MODEL_SLUG,
  AI_STUDIO_NEW_CHAT_URL,
  AI_STUDIO_ORIGIN,
  buildAiStudioConversationUrl,
  buildAiStudioNewChatUrl,
  normalizeAiStudioConversationId,
  parseAiStudioConversationId,
  waitForAiStudioConversationId,
} from "./conversation-url";

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
    parsed.context?.messages?.some(message => message.role === "toolResult") ??
    false;
  return isStructuredJsonOutputTurn(parsed, trailingTools) && !priorAssistant;
}

/**
 * Adapter Google AI Studio Web (`aistudio.google.com`) điều phối qua `WebTurnEngine`.
 */
export class AiStudioAdapter extends WebProviderAdapter {
  override readonly name = "ai-studio";
  private readonly worker: AiStudioBrowserWorker;
  private readonly speechWorker = new AiStudioSpeechWorker();

  constructor() {
    const worker = new AiStudioBrowserWorker();
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
        maxPromptChars: 95_000,
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
          hasPriorAssistantReply,
        }) => ({
          existingConversationId: leaseConversationId,
          isNewConversation:
            !launcherReused &&
            !hasPriorAssistantReply &&
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
            connectorBound:
              finalStatus === "completed" && Boolean(activeConversationId),
            conversationId: activeConversationId,
            retain: true,
          };
        },
      },
      attachments: {
        maxInputImages: 3,
      },
      browser: {
        launcherProviderId: "ai-studio",
        connectorIdentity: "ai-studio",
        resolveSurfaceId: (descriptor, leaseSurfaceId) =>
          leaseSurfaceId || descriptor.providerSurfaceIds?.["ai-studio"] || descriptor.surfaceId,
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
              "[ai-studio-adapter] Không có trình duyệt khả dụng để thực thi lượt.",
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
        createCallId: () => `call_aistudio_${Math.random().toString(36).slice(2, 10)}`,
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
   * Thực thi tác vụ Text-to-Speech / Podcast trên giao diện `/generate-speech`
   * qua tab Launcher tạm thời và trả về audio base64 chuẩn Gemini `inlineData`.
   */
  async runSpeechTurn(
    request: SpeechTurnRequest,
    incoming: IncomingMeta,
  ): Promise<SpeechTurnResult> {
    return await this.engine.runEphemeralSurfaceTask(incoming, async ({ page, signal, heartbeat }) => {
      return await this.speechWorker.executeSpeech(page, {
        modelId: request.modelId,
        text: request.text,
        temperature: request.temperature,
        speakers: request.speakers,
        signal,
        heartbeat,
      });
    });
  }
}

/**
 * Factory khởi tạo đối tượng `AiStudioAdapter`.
 */
export function createAiStudioAdapter(): ProviderAdapter {
  return new AiStudioAdapter();
}

