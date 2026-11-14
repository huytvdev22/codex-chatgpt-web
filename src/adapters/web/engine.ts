import { hasActualPriorAssistantReply, type IncomingMeta } from "../base";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import { compileWebPrompt } from "./compile-prompt";
import { CodexPayloadNormalizer, CodexRawPayload } from "./normalization";
import {
  parseStrictWebResponse,
  type StrictWebResponseResult,
} from "./protocol/strict-response-parser";
import { validateWebProtocolResponse } from "./protocol/validate-response";
import { runWebProtocolRetry } from "./protocol/retry-response";
import { emitWebProtocolResponse } from "./protocol/emit-response";
import {
  conversationGuard,
  isAssistantFinalAnswer,
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

  constructor(
    private readonly definition: WebProviderDefinition,
    private readonly localBrowser?: LocalBrowserRuntime,
    private readonly lifecycleOps?: Partial<WebRuntimeLifecycleOps>,
  ) {}

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

    const threadId = this.definition.conversation.resolveThreadId
      ? this.definition.conversation.resolveThreadId(parsed, incoming)
      : resolveWebThreadId(parsed._rawBody, parsed, incoming.headers);

    const conversationKey =
      this.definition.conversation.resolveConversationKey({
        parsed,
        incoming,
        threadId,
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

    const turnTraceId = resolveWebTurnTraceId({
      headers: incoming.headers,
      ...this.definition.policies?.traceIdOptions,
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
      const acquired = await acquireWebTurnSurface({
        definition: this.definition,
        localBrowser: this.localBrowser,
        turnTraceId,
        conversationKey,
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

      const initialPrompt = this.definition.compilePrompt
        ? this.definition.compilePrompt(parsed, isNewConversation, normalized)
        : compileWebPrompt(parsed, {
            assistantName: this.definition.assistantName,
            isNewConversation,
            maxPromptChars: this.definition.policies?.maxPromptChars,
            maxInputImages: this.definition.attachments?.maxInputImages,
            normalized,
          }).finalPrompt;

      const reasoningEffort = this.definition.capability?.resolveReasoningEffort
        ? this.definition.capability.resolveReasoningEffort(parsed)
        : parsed.options.reasoning;

      let finalStatus: WebTurnFinalStatus = "failed";
      let totalPromptChars = 0;
      let lastRaw = "";

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
          abortSignal: turnRegistration.signal,
          execute: async ({ attempt, prompt }) => {
            totalPromptChars += prompt.length;
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
              prompt,
              attempt,
              parsed,
              incoming: turnIncoming,
              reasoningEffort,
              conversationKey,
              existingConversationId: activeConversationId,
              launcherReused: acquired.launcherReused,
              isNewConversation: attempt === 0 ? isNewConversation : false,
              attachments,
              turnTraceId,
              heartbeat: acquired.heartbeat,
            });

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

            return validateWebProtocolResponse(
              parsedProtocol,
              parsed.context.tools || [],
              this.definition.response?.classifyValidationFailure
                ? {
                    classifyFailure:
                      this.definition.response.classifyValidationFailure,
                  }
                : undefined,
            );
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
        await releaseWebTurnSurface({
          definition: this.definition,
          acquired,
          turnTraceId,
          finalStatus,
          activeConversationId,
          conversationKey,
          abortSignal: turnRegistration.signal,
          ops: this.lifecycleOps,
        });
      }
    } finally {
      turnRegistration.finish();
    }
  }
}
