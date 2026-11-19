import type { Page } from "playwright-core";
import {
  hasActualPriorAssistantReply,
  type IncomingMeta,
  type RawTurnRequest,
  type RawTurnResult,
} from "../base";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import { buildWebConversationKey } from "./conversation/conversation-key";
import type { NormalizedImageAttachment } from "./normalization/canonical-types";
import { compileWebPrompt } from "./compile-prompt";
import { CodexPayloadNormalizer, CodexRawPayload } from "./normalization";
import { isStructuredJsonOutputTurn } from "./prompt";
import {
  parseStrictWebResponse,
  type StrictWebResponseResult,
} from "./protocol/strict-response-parser";
import { parseAndValidateJsonSchemaResponse } from "./protocol/json-schema-response";
import { validateWebProtocolResponse } from "./protocol/validate-response";
import { runWebProtocolRetry } from "./protocol/retry-response";
import { emitWebProtocolResponse } from "./protocol/emit-response";
import {
  conversationGuard,
  isAssistantFinalAnswer,
  TurnTraceRecorder,
  WebTurnLoopGuard,
} from "./execution";
import {
  activeWebTurnRegistry,
  resolveWebThreadId,
  resolveWebTurnTraceId,
} from "./turn-identity";
import type { LocalBrowserRuntime } from "./local-browser-runtime";
import type {
  WebProviderDefinition,
  WebTurnFinalStatus,
} from "./definition";
import type { ElectronSurfaceClient } from "./electron-surface-client";
import {
  acquireWebTurnSurface,
  releaseWebTurnSurface,
  type WebRuntimeLifecycleOps,
} from "./runtime-lifecycle";

/**
 * WebTurnEngine: Orchestrator duy nhất điều phối toàn bộ vòng đời một lượt tương tác (turn)
 * cho tất cả các Web Provider theo cấu hình WebProviderDefinition.
 */
export class WebTurnEngine {
  private readonly loopGuard = new WebTurnLoopGuard();
  private readonly traceRecorder: TurnTraceRecorder;

  constructor(
    private readonly definition: WebProviderDefinition,
    private readonly localBrowser?: LocalBrowserRuntime,
    private readonly lifecycleOps?: Partial<WebRuntimeLifecycleOps>,
    traceRecorder?: TurnTraceRecorder,
  ) {
    this.traceRecorder = traceRecorder ?? new TurnTraceRecorder();
  }

  async runTurn(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void,
  ): Promise<void> {
    if (incoming.abortSignal?.aborted) {
      throw new DOMException(
        this.definition.abortMessage ||
          `${this.definition.assistantName} turn aborted before start`,
        "AbortError",
      );
    }

    const turnTraceId = resolveWebTurnTraceId({
      headers: incoming.headers,
      ...this.definition.policies?.traceIdOptions,
    });

    const threadId = this.definition.conversation.resolveThreadId
      ? this.definition.conversation.resolveThreadId(parsed, incoming)
      : resolveWebThreadId(parsed._rawBody, parsed, incoming.headers);

    const conversationKey =
      this.definition.conversation.resolveConversationKey({
        parsed,
        incoming,
        threadId,
        turnTraceId,
      });

    const hasPriorAssistantReply = hasActualPriorAssistantReply(
      parsed.context.messages,
    );

    if (this.definition.policies?.enableEarlyExitOnFinalAnswer) {
      const allMsgs = parsed.context.messages || [];
      const lastMsg = allMsgs[allMsgs.length - 1];
      if (isAssistantFinalAnswer(lastMsg)) {
        console.log(
          `[${this.definition.logPrefix}] Cuộc hội thoại đã kết thúc bằng phản hồi của trợ lý và không có pending tool call hoặc input mới. Hoàn tất lượt.`,
        );
        if (conversationKey) {
          conversationGuard.delete(conversationKey);
        }
        emit({
          type: "done",
          stopReason: "stop",
          endTurn: true,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        return;
      }
    }

    const turnRegistration = activeWebTurnRegistry.register(
      turnTraceId,
      incoming.abortSignal,
    );
    const turnIncoming: IncomingMeta = {
      ...incoming,
      abortSignal: turnRegistration.signal,
    };

    try {
      const initialUrl = this.definition.browser.resolveInitialUrl?.({
        modelId: parsed.modelId,
      });
      const acquired = await acquireWebTurnSurface({
        definition: this.definition,
        localBrowser: this.localBrowser,
        turnTraceId,
        conversationKey,
        ...(initialUrl ? { initialUrl } : {}),
        abortSignal: turnRegistration.signal,
        ops: this.lifecycleOps,
      });

      const stateResolution = this.definition.conversation.resolveState
        ? this.definition.conversation.resolveState({
            parsed,
            incoming: turnIncoming,
            threadId,
            conversationKey,
            leaseConversationId: acquired.leaseConversationId,
            launcherReused: acquired.launcherReused,
            hasPriorAssistantReply,
          })
        : {
            existingConversationId: acquired.leaseConversationId,
            isNewConversation: !hasPriorAssistantReply,
          };

      const { existingConversationId, isNewConversation } = stateResolution;
      let activeConversationId = existingConversationId;

      const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
      const normalized = CodexPayloadNormalizer.normalize(rawPayload, {
        maxImages: this.definition.attachments?.maxInputImages,
      });
      const hasToolResults = normalized.trailingToolResults.length > 0;
      const structuredOutputFormat = isStructuredJsonOutputTurn(parsed, hasToolResults)
        ? parsed.options.outputFormat
        : undefined;
      const retainTurn = this.definition.conversation.resolveEndTurnBinding
        ? (this.definition.conversation.resolveEndTurnBinding({
            finalStatus: "completed",
            activeConversationId,
            conversationKey,
            parsed,
            hasPriorAssistantReply,
            hasToolResults,
          }).retain ?? true)
        : true;

      const compileResult = this.definition.compilePrompt
        ? undefined
        : compileWebPrompt(parsed, {
            assistantName: this.definition.assistantName,
            isNewConversation,
            maxPromptChars: this.definition.policies?.maxPromptChars,
            maxInputImages: this.definition.attachments?.maxInputImages,
            normalized,
          });
      const initialPrompt = this.definition.compilePrompt
        ? this.definition.compilePrompt(parsed, isNewConversation, normalized)
        : compileResult!.finalPrompt;

      const traceSession = this.traceRecorder.beginTurn({
        providerId: this.definition.id,
        assistantName: this.definition.assistantName,
        modelId: parsed.modelId,
        threadId,
        turnId: normalized.turnId,
        turnTraceId,
        conversationKey,
        existingConversationId,
        launcherReused: acquired.launcherReused,
        isNewConversation,
        usedCustomCompilePrompt: Boolean(this.definition.compilePrompt),
        parsed,
        normalized,
        compileResult,
      });

      const reasoningEffort = this.definition.capability?.resolveReasoningEffort
        ? this.definition.capability.resolveReasoningEffort(parsed)
        : parsed.options.reasoning;

      let finalStatus: WebTurnFinalStatus = "failed";
      let totalPromptChars = 0;
      let lastRaw = "";
      let traceError: unknown;

      try {
        const configuredMaxRetries = this.definition.policies?.maxFormatRetries;
        const maxRetries =
          typeof configuredMaxRetries === "function"
            ? configuredMaxRetries()
            : (configuredMaxRetries ?? 2);
        const protocolResult = await runWebProtocolRetry({
          initialPrompt,
          maxRetries,
          providerName: this.definition.assistantName,
          outputFormat: structuredOutputFormat,
          abortSignal: turnRegistration.signal,
          execute: async ({ attempt, prompt, isRetry }) => {
            totalPromptChars += prompt.length;
            traceSession?.recordAttemptPrompt({ attempt, isRetry, prompt });
            let rawWebResponseForTrace: string | undefined;
            try {
              const attachments = this.definition.attachments?.extractAttachments
                ? this.definition.attachments.extractAttachments({
                    parsed,
                    attempt,
                    normalized,
                  })
                : attempt === 0
                  ? (normalized.images ?? [])
                  : [];

              const result = await this.definition.browser.executeTurn({
                page: acquired.page,
                electronClient: acquired.electronClient,
                prompt,
                attempt,
                parsed,
                incoming: turnIncoming,
                reasoningEffort,
                conversationKey,
                existingConversationId: activeConversationId,
                launcherReused: acquired.launcherReused,
                isNewConversation: attempt === 0 ? isNewConversation : false,
                retain: retainTurn,
                attachments,
                turnTraceId,
                heartbeat: acquired.heartbeat,
              });
              rawWebResponseForTrace = result.rawResponse;

              if (this.definition.conversation.onConversationUpdated) {
                const updatedId =
                  this.definition.conversation.onConversationUpdated({
                    threadId,
                    conversationKey,
                    conversationId: result.conversationId,
                  });
                if (updatedId) {
                  activeConversationId = updatedId;
                }
              } else if (result.conversationId) {
                activeConversationId = result.conversationId;
              }

              lastRaw = this.definition.response?.sanitizeRawResponse
                ? this.definition.response.sanitizeRawResponse(result.rawResponse)
                : result.rawResponse;

              if (structuredOutputFormat) {
                const jsonResult = parseAndValidateJsonSchemaResponse(
                  lastRaw,
                  structuredOutputFormat,
                );
                traceSession?.recordAttemptOutcome({
                  rawWebResponse: rawWebResponseForTrace,
                  sanitizedWebResponse: lastRaw,
                  parsedProtocolResult: jsonResult,
                });
                return jsonResult;
              }

              let parsedProtocol: StrictWebResponseResult =
                parseStrictWebResponse(lastRaw);

              if (
                parsedProtocol.kind === "protocol_error" &&
                this.definition.response?.tolerantNaturalTextFallback
              ) {
                const isWrapperError =
                  parsedProtocol.code === "MISSING_TRANSPORT_FENCE" ||
                  parsedProtocol.code === "MISSING_RESPONSE_ENVELOPE";
                const hasActionMarkers =
                  lastRaw.includes("<tool_call>") ||
                  lastRaw.includes("<custom_tool_call") ||
                  lastRaw.includes("*** Begin Patch");

                if (
                  isWrapperError &&
                  !hasActionMarkers &&
                  lastRaw.trim().length > 0
                ) {
                  parsedProtocol = {
                    kind: "final_answer",
                    content: lastRaw.replace(/<\/?webResponse>/gi, "").trim(),
                    rawResponse: lastRaw,
                  };
                }
              }

              const validatedResult = validateWebProtocolResponse(
                parsedProtocol,
                parsed.context.tools || [],
                this.definition.response?.classifyValidationFailure
                  ? {
                      classifyFailure:
                        this.definition.response.classifyValidationFailure,
                    }
                  : undefined,
              );
              traceSession?.recordAttemptOutcome({
                rawWebResponse: rawWebResponseForTrace,
                sanitizedWebResponse: lastRaw,
                parsedProtocolResult: validatedResult,
              });
              return validatedResult;
            } catch (attemptError) {
              traceSession?.recordAttemptOutcome({
                rawWebResponse: rawWebResponseForTrace,
                sanitizedWebResponse: lastRaw || undefined,
                error: attemptError,
              });
              throw attemptError;
            }
          },
          onProtocolError: result => {
            console.warn(
              `[${this.definition.logPrefix}] [Format Error] Lỗi giao thức (${result.code}): ${result.message}`,
            );
          },
        });

        const usage = this.definition.response?.computeUsage
          ? this.definition.response.computeUsage({
              initialPrompt,
              totalPromptChars,
              lastRaw,
            })
          : undefined;

        if (
          this.definition.policies?.enableToolLoopGuard &&
          this.loopGuard.evaluate({
            protocolResult,
            clientTools: parsed.context.tools || [],
            conversationKey,
            logPrefix: this.definition.logPrefix,
            emit,
            usage,
          })
        ) {
          finalStatus = "completed";
          return;
        }

        emitWebProtocolResponse({
          result: protocolResult,
          clientTools: parsed.context.tools || [],
          emit,
          createCallId:
            this.definition.response?.createCallId ??
            (() =>
              `call_${this.definition.browser.launcherProviderId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`),
          usage,
          includeDetailedDoneEvent:
            this.definition.response?.includeDetailedDoneEvent,
          toolCallStopReason: this.definition.response?.toolCallStopReason,
          toolCallEndTurn: this.definition.response?.toolCallEndTurn,
        });

        finalStatus = "completed";
      } catch (error) {
        traceError = error;
        if (this.definition.policies?.enableToolLoopGuard && conversationKey) {
          conversationGuard.delete(conversationKey);
        }
        finalStatus = turnRegistration.signal.aborted ? "aborted" : "failed";

        if (
          turnRegistration.signal.aborted &&
          !(this.definition.policies?.rethrowError ?? true)
        ) {
          throw new DOMException(
            this.definition.policies?.abortedTurnMessage ||
              `${this.definition.assistantName} turn aborted`,
            "AbortError",
          );
        }

        if (this.definition.policies?.emitErrorEventOnFailure ?? true) {
          const rawMsg = error instanceof Error ? error.message : String(error);
          const prefix = this.definition.policies?.errorMessagePrefix;
          emit({
            type: "error",
            message: prefix ? `${prefix} ${rawMsg}` : rawMsg,
          });
        }

        if (this.definition.policies?.rethrowError ?? true) {
          throw error;
        }
      } finally {
        traceSession?.finalize(finalStatus, activeConversationId, traceError);
        await releaseWebTurnSurface({
          definition: this.definition,
          acquired,
          turnTraceId,
          finalStatus,
          activeConversationId,
          conversationKey,
          parsed,
          hasPriorAssistantReply,
          hasToolResults,
          abortSignal: turnRegistration.signal,
          ops: this.lifecycleOps,
        });
      }
    } finally {
      turnRegistration.finish();
    }
  }

  /**
   * Thực thi lượt Raw Passthrough cho `/v2/responses`:
   * gửi nguyên văn `prompt` tới Web UI và trả về nguyên bản câu trả lời,
   * bỏ qua toàn bộ prompt compiler, retry định dạng và strict response parser.
   */
  async runRawTurn(
    request: RawTurnRequest,
    incoming: IncomingMeta,
  ): Promise<RawTurnResult> {
    if (incoming.abortSignal?.aborted) {
      throw new DOMException(
        this.definition.abortMessage ||
          `${this.definition.assistantName} turn aborted before start`,
        "AbortError",
      );
    }

    const turnTraceId = resolveWebTurnTraceId({
      headers: incoming.headers,
      ...this.definition.policies?.traceIdOptions,
    });
    const conversationKey = buildWebConversationKey({
      provider: this.definition.id,
      source: request.conversationKey ? `v2:${request.conversationKey}` : `v2:${turnTraceId}`,
      modelId: "raw-v2",
    });

    const turnRegistration = activeWebTurnRegistry.register(
      turnTraceId,
      incoming.abortSignal,
    );
    const turnIncoming: IncomingMeta = {
      ...incoming,
      abortSignal: turnRegistration.signal,
    };

    try {
      const initialUrl = this.definition.browser.resolveInitialUrl?.({
        modelId: request.modelId,
        existingConversationId: request.existingConversationId,
      });
      const acquired = await acquireWebTurnSurface({
        definition: this.definition,
        localBrowser: this.localBrowser,
        turnTraceId,
        conversationKey,
        ...(initialUrl ? { initialUrl } : {}),
        abortSignal: turnRegistration.signal,
        ops: this.lifecycleOps,
      });

      let activeConversationId =
        request.existingConversationId || acquired.leaseConversationId;
      const isNewConversation =
        !acquired.launcherReused && !activeConversationId;
      const syntheticParsed: CodexParsedRequest = {
        modelId: request.modelId,
        stream: false,
        context: { messages: [], tools: [] },
        options: {
          ...(request.reasoning ? { reasoning: request.reasoning } : {}),
        },
      };
      const maxImages = this.definition.attachments?.maxInputImages ?? 3;
      const attachments: NormalizedImageAttachment[] = (request.images ?? [])
        .slice(0, maxImages)
        .map((image, index) => ({
          ref: `v2-img-${index}`,
          name: image.name || `image-${index + 1}.png`,
          mimeType: image.mimeType,
          dataUrl: image.dataUrl,
          buffer: image.buffer,
        }));

      let finalStatus: WebTurnFinalStatus = "failed";
      try {
        const result = await this.definition.browser.executeTurn({
          page: acquired.page,
          electronClient: acquired.electronClient,
          prompt: request.prompt,
          attempt: 0,
          parsed: syntheticParsed,
          incoming: turnIncoming,
          reasoningEffort: request.reasoning,
          conversationKey,
          existingConversationId: activeConversationId,
          launcherReused: acquired.launcherReused,
          isNewConversation,
          retain: true,
          attachments,
          turnTraceId,
          heartbeat: acquired.heartbeat,
        });

        if (this.definition.conversation.onConversationUpdated) {
          const updatedId = this.definition.conversation.onConversationUpdated({
            conversationKey,
            conversationId: result.conversationId,
          });
          if (updatedId) {
            activeConversationId = updatedId;
          }
        } else if (result.conversationId) {
          activeConversationId = result.conversationId;
        }

        const outputText = this.definition.response?.sanitizeRawResponse
          ? this.definition.response.sanitizeRawResponse(result.rawResponse)
          : result.rawResponse;

        finalStatus = "completed";
        return {
          outputText,
          ...(activeConversationId ? { conversationId: activeConversationId } : {}),
        };
      } catch (error) {
        finalStatus = turnRegistration.signal.aborted ? "aborted" : "failed";
        throw error;
      } finally {
        await releaseWebTurnSurface({
          definition: this.definition,
          acquired,
          turnTraceId,
          finalStatus,
          activeConversationId,
          conversationKey,
          parsed: syntheticParsed,
          hasPriorAssistantReply: !isNewConversation,
          hasToolResults: false,
          abortSignal: turnRegistration.signal,
          ops: this.lifecycleOps,
        });
      }
    } finally {
      turnRegistration.finish();
    }
  }

  /**
   * Cấp phát một tab Launcher cho tác vụ chuyên biệt (ví dụ Google AI Studio Speech Generation)
   * với tùy chọn tái sử dụng tab theo `conversationKeySource` khi lượt trước thành công.
   */
  async runEphemeralSurfaceTask<T>(
    incoming: IncomingMeta,
    task: (context: {
      page: Page | null;
      electronClient?: ElectronSurfaceClient;
      launcherReused: boolean;
      signal: AbortSignal;
      heartbeat?: () => Promise<void>;
    }) => Promise<T>,
    options?: {
      initialUrl?: string;
      conversationKeySource?: string;
      retainOnCompleted?: boolean;
      omitConnectorIdentity?: boolean;
    },
  ): Promise<T> {
    if (incoming.abortSignal?.aborted) {
      throw new DOMException(
        this.definition.abortMessage ||
          `${this.definition.assistantName} task aborted before start`,
        "AbortError",
      );
    }

    const turnTraceId = resolveWebTurnTraceId({
      headers: incoming.headers,
      ...this.definition.policies?.traceIdOptions,
    });
    const conversationKey = buildWebConversationKey({
      provider: this.definition.id,
      source: options?.conversationKeySource || `ephemeral:${turnTraceId}`,
      modelId: options?.conversationKeySource ? "surface" : "ephemeral",
    });

    const turnRegistration = activeWebTurnRegistry.register(
      turnTraceId,
      incoming.abortSignal,
    );
    const turnSignal = turnRegistration.signal;

    try {
      const acquired = await acquireWebTurnSurface({
        definition: this.definition,
        localBrowser: this.localBrowser,
        turnTraceId,
        conversationKey,
        omitConnectorIdentity: options?.omitConnectorIdentity,
        initialUrl: options?.initialUrl,
        abortSignal: turnSignal,
        ops: this.lifecycleOps,
      });

      if (!acquired.page && !acquired.electronClient) {
        throw new Error(
          `[${this.definition.logPrefix}] Không có trình duyệt khả dụng để thực thi tác vụ.`,
        );
      }

      let finalStatus: WebTurnFinalStatus = "failed";
      try {
        const result = await task({
          page: acquired.page,
          electronClient: acquired.electronClient,
          launcherReused: acquired.launcherReused,
          signal: turnSignal,
          heartbeat: acquired.heartbeat,
        });
        finalStatus = "completed";
        return result;
      } catch (error) {
        finalStatus = turnSignal.aborted ? "aborted" : "failed";
        throw error;
      } finally {
        await releaseWebTurnSurface({
          definition: this.definition,
          acquired,
          turnTraceId,
          finalStatus,
          conversationKey,
          retainOverride:
            options?.retainOnCompleted && finalStatus === "completed",
          abortSignal: turnSignal,
          ops: this.lifecycleOps,
        });
      }
    } finally {
      turnRegistration.finish();
    }
  }
}
