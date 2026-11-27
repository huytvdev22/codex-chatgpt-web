import type { Page } from "playwright-core";
import {
  hasActualPriorAssistantReply,
  resolveRequestedProfileId,
  type IncomingMeta,
  type ManagedTurnRequest,
  type ManagedTurnResult,
  type RawTurnRequest,
  type RawTurnResult,
  type UsageLimitCheckRequest,
} from "../base";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import {
  ProfileFailoverCoordinator,
  type ProviderLimitCheckResult,
} from "../../limits";
import type { DiscoveredModelEntry } from "../../models/types";
import { adapterFailureFromMessage } from "../../lib/errors";
import {
  personalizationPromptBuilder,
  personalizationStore,
} from "../../personalization";
import {
  skillPromptBuilder,
  skillsStore,
} from "../../skills";
import {
  computeAccurateTurnUsage,
  UsageFooterFormatter,
  usageHistoryStore,
  usageSettingsStore,
  type ProviderReportedTokens,
} from "../../usage";
import { buildWebConversationKey } from "./conversation/conversation-key";
import type { NormalizedImageAttachment } from "./normalization/canonical-types";
import { compileWebPrompt } from "./compile-prompt";
import { CodexPayloadNormalizer, CodexRawPayload } from "./normalization";
import {
  buildFormatRetryPrompt,
  buildRepeatedFailedToolRecoveryPrompt,
  isApplyPatchVerificationError,
  isImplementingPlanRequest,
  isStructuredJsonOutputTurn,
  isToolResultError,
  mcpToolCatalogRenderer,
  SHORT_OUTPUT_FORMAT_ANCHOR,
} from "./prompt";
import {
  hasStandaloneProposedPlanTag,
  parseStrictWebResponse,
  stripStandaloneProposedPlanTags,
  type StrictWebResponseResult,
  type StrictWebToolCall,
} from "./protocol/strict-response-parser";
import { parseAndValidateJsonSchemaResponse } from "./protocol/json-schema-response";
import { validateWebProtocolResponse } from "./protocol/validate-response";
import { runWebProtocolRetry } from "./protocol/retry-response";
import { emitWebProtocolResponse } from "./protocol/emit-response";
import {
  conversationGuard,
  isAssistantFinalAnswer,
  TurnTraceRecorder,
  webPromptSessionStore,
  WebPromptSessionStore,
  WebTurnLoopGuard,
} from "./execution";
import { INTERNAL_TOOL_DESCRIBE_NAME, WebToolRegistry } from "./tools";
import {
  activeWebTurnRegistry,
  resolveWebThreadId,
  resolveWebTurnTraceId,
} from "./turn-identity";
import type { LocalBrowserRuntime } from "./local-browser-runtime";
import { resolveLauncherDescriptorPath } from "./launcher-runtime";
import type {
  WebProviderDefinition,
  WebTurnFinalStatus,
} from "./definition";
import {
  acquireWebTurnSurface,
  releaseWebTurnSurface,
  type WebRuntimeLifecycleOps,
} from "./runtime-lifecycle";

const MAX_TOOL_DESCRIBE_ROUNDS = 2;
const inFlightDiscoveries = new Set<string>();
const inFlightLimitChecks = new Set<string>();

/**
 * Lỗi đánh dấu provider đang bận chạy turn hoặc đang refresh danh mục model.
 */
export class ProviderBusyError extends Error {
  public readonly statusCode = 409;

  constructor(
    public readonly providerId: string,
    message = `Provider '${providerId}' is currently busy. Wait for the active turn to finish before refreshing models.`,
  ) {
    super(message);
    this.name = "ProviderBusyError";
  }
}

function extractRequestedToolNames(calls: StrictWebToolCall[]): string[] {
  const names: string[] = [];
  for (const call of calls) {
    const rawArgs = call.arguments;
    let obj: Record<string, unknown> = {};
    if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
      obj = rawArgs as Record<string, unknown>;
    } else if (typeof rawArgs === "string") {
      try {
        const parsed = JSON.parse(rawArgs);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          obj = parsed as Record<string, unknown>;
        }
      } catch {
        // Bỏ qua JSON không hợp lệ
      }
    }

    const candidates = Array.isArray(obj.names)
      ? obj.names
      : Array.isArray(obj.tools)
        ? obj.tools
        : typeof obj.name === "string"
          ? [obj.name]
          : typeof obj.tool === "string"
            ? [obj.tool]
            : typeof obj.names === "string"
              ? obj.names.split(",")
              : [];

    for (const item of candidates) {
      const cleaned = String(item || "").trim();
      if (cleaned && !names.includes(cleaned)) {
        names.push(cleaned);
      }
    }
  }
  return names;
}

/**
 * WebTurnEngine: Orchestrator duy nhất điều phối toàn bộ vòng đời một lượt tương tác (turn)
 * cho tất cả các Web Provider theo cấu hình WebProviderDefinition.
 */
export class WebTurnEngine {
  private readonly loopGuard = new WebTurnLoopGuard();
  private readonly traceRecorder: TurnTraceRecorder;
  private readonly sessionStore: WebPromptSessionStore;
  private readonly failoverCoordinator: ProfileFailoverCoordinator;

  constructor(
    private readonly definition: WebProviderDefinition,
    private readonly localBrowser?: LocalBrowserRuntime,
    private readonly lifecycleOps?: Partial<WebRuntimeLifecycleOps>,
    traceRecorder?: TurnTraceRecorder,
    sessionStore?: WebPromptSessionStore,
    failoverCoordinator?: ProfileFailoverCoordinator,
  ) {
    this.traceRecorder = traceRecorder ?? new TurnTraceRecorder();
    this.sessionStore = sessionStore ?? webPromptSessionStore;
    this.failoverCoordinator =
      failoverCoordinator ?? ProfileFailoverCoordinator.getInstance();
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
      this.definition.id,
    );
    const turnIncoming: IncomingMeta = {
      ...incoming,
      abortSignal: turnRegistration.signal,
    };

    try {
      const resolvedDescriptorPath =
        (this.lifecycleOps?.resolveDescriptorPath ?? resolveLauncherDescriptorPath)(
          this.definition.browser.descriptorPath,
          this.definition.browser.descriptorSubdirs,
        ) ?? undefined;
      const initialProfile = this.failoverCoordinator.resolveInitialProfile({
        providerId: this.definition.id,
        modelId: parsed.modelId,
        threadId,
        explicitProfileId: resolveRequestedProfileId(incoming.headers),
        descriptorPath: resolvedDescriptorPath,
      });
      let currentProfileId = initialProfile.profileId;
      let forceNewConversation = initialProfile.switchedFromStickyOrActive;
      const attemptedProfileIds = new Set<string>();
      if (currentProfileId) {
        attemptedProfileIds.add(currentProfileId);
      }

      for (let failoverAttempt = 0; ; failoverAttempt += 1) {
        const initialUrl = this.definition.browser.resolveInitialUrl?.({
          modelId: parsed.modelId,
        });
        const acquired = await acquireWebTurnSurface({
          definition: this.definition,
          localBrowser: this.localBrowser,
          turnTraceId,
          conversationKey,
          ...(initialUrl ? { initialUrl } : {}),
          ...(currentProfileId ? { profileId: currentProfileId } : {}),
          abortSignal: turnRegistration.signal,
          ops: this.lifecycleOps,
        });

        const baseStateResolution = this.definition.conversation.resolveState
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

        const existingConversationId = forceNewConversation
          ? undefined
          : baseStateResolution.existingConversationId;
        const isNewConversation = forceNewConversation
          ? true
          : baseStateResolution.isNewConversation;
        let activeConversationId = existingConversationId;
        let hasEmittedOutput = false;
        const trackedEmit = (event: AdapterEvent): void => {
          if (
            event.type === "text_delta" ||
            event.type === "thinking_delta" ||
            event.type === "reasoning_raw_delta" ||
            event.type === "tool_call_start" ||
            event.type === "tool_call_delta" ||
            event.type === "tool_call_end" ||
            event.type === "done" ||
            event.type === "incomplete"
          ) {
            hasEmittedOutput = true;
          }
          emit(event);
        };

      const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
      const normalized = CodexPayloadNormalizer.normalize(rawPayload, {
        maxImages: this.definition.attachments?.maxInputImages,
        parsed,
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

      const sessionKey = conversationKey || threadId;
      const useCompiledPrompt = !structuredOutputFormat && !this.definition.compilePrompt;
      const personalizationSnapshot = useCompiledPrompt
        ? personalizationStore.getSnapshot()
        : undefined;
      const skillsSnapshot = useCompiledPrompt
        ? skillsStore.getSnapshot()
        : undefined;
      if (normalized.availableSkills && normalized.availableSkills.length > 0) {
        skillsStore.recordDiscoveredSkills(normalized.availableSkills);
      }
      const directorySkills =
        useCompiledPrompt && skillsSnapshot
          ? skillsStore.getDirectorySkills(skillsSnapshot.settings)
          : [];
      const mergedSkills =
        useCompiledPrompt && skillsSnapshot
          ? skillPromptBuilder.mergeSkills(normalized.availableSkills, directorySkills)
          : [];
      const filteredHostSkills =
        useCompiledPrompt && skillsSnapshot
          ? skillPromptBuilder.filterHostSkills(mergedSkills, skillsSnapshot.settings)
          : [];
      const resolvedSelectedSkills =
        useCompiledPrompt && skillsSnapshot
          ? skillPromptBuilder.resolveExplicitSkillMentions(
              normalized.latestUserInstruction,
              mergedSkills,
              normalized.selectedSkills,
              skillsSnapshot.settings,
            )
          : [];
      const availableSkillsDigest =
        useCompiledPrompt && skillsSnapshot
          ? skillPromptBuilder.computeAvailableSkillsDigest(
              filteredHostSkills,
              skillsSnapshot.settings,
            )
          : undefined;
      const selectedSkillsDigest =
        useCompiledPrompt && skillsSnapshot
          ? skillPromptBuilder.computeSelectedSkillsDigest(
              resolvedSelectedSkills,
              skillsSnapshot.settings,
            )
          : undefined;

      const directives = useCompiledPrompt
        ? this.sessionStore.resolveTurnDirectives(sessionKey, {
            isNewConversation,
            normalized,
            personalizationDigest: personalizationSnapshot?.digest,
            availableSkillsDigest,
            selectedSkillsDigest,
          })
        : undefined;

      const personalizationText =
        useCompiledPrompt && directives?.includePersonalization && personalizationSnapshot
          ? personalizationPromptBuilder.buildGlobalSection(personalizationSnapshot.settings)
          : "";
      const workspaceMemoryHintText =
        useCompiledPrompt && personalizationSnapshot
          ? personalizationPromptBuilder.buildWorkspaceMemoryHint(
              normalized.workspaceCwd,
              personalizationSnapshot.settings.enabled &&
                personalizationSnapshot.settings.workspaceMemoryEnabled,
            )
          : "";
      const availableSkillsText =
        useCompiledPrompt && directives?.includeAvailableSkills
          ? skillPromptBuilder.buildAvailableSkillsSection(filteredHostSkills)
          : "";
      const selectedSkillsText =
        useCompiledPrompt && directives?.includeSelectedSkills && skillsSnapshot
          ? skillPromptBuilder.buildSelectedSkillsSection(
              resolvedSelectedSkills,
              skillsSnapshot.settings,
            )
          : "";

      const compileResult = this.definition.compilePrompt
        ? undefined
        : compileWebPrompt(parsed, {
            assistantName: this.definition.assistantName,
            isNewConversation,
            maxPromptChars: this.definition.policies?.maxPromptChars,
            maxInputImages: this.definition.attachments?.maxInputImages,
            normalized,
            toolDelta: directives?.toolDelta,
            includeEnvironment: directives?.includeEnvironment,
            includeUserInstruction: directives?.includeUserInstruction,
            includePersonalization: !structuredOutputFormat,
            personalizationText,
            workspaceMemoryHintText,
            includeSkills: !structuredOutputFormat,
            availableSkillsText,
            selectedSkillsText,
          });
      const initialPrompt = this.definition.compilePrompt
        ? this.definition.compilePrompt(parsed, isNewConversation, normalized)
        : compileResult!.finalPrompt;
      const isImplementingPlan =
        compileResult?.isImplementingPlan ?? isImplementingPlanRequest(parsed);
      const isPlanMode =
        compileResult?.isPlanMode ??
        (!isImplementingPlan && normalized.collaborationMode === "plan");

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

      const turnStartedAt = Date.now();
      let finalStatus: WebTurnFinalStatus = "failed";
      let totalPromptChars = 0;
      const attemptPrompts: string[] = [];
      const attemptOutputs: string[] = [];
      let firstBeforeContextTokens: number | undefined;
      let latestAfterContextTokens: number | undefined;
      let latestReportedSource: ProviderReportedTokens["source"] | undefined;
      let lastRaw = "";
      let traceError: unknown;
      const describedToolNames: string[] = [];
      let lastFailedToolName: string | undefined;
      let lastProtocolError: { code: string; message: string } | undefined;

      let retryNextProfileId: string | undefined;
      try {
        const configuredMaxRetries = this.definition.policies?.maxFormatRetries;
        const maxRetries =
          typeof configuredMaxRetries === "function"
            ? configuredMaxRetries()
            : (configuredMaxRetries ?? 2);

        let roundPrompt = initialPrompt;
        let isInitialRound = true;
        let describeRoundsUsed = 0;
        const failedToolResults =
          normalized.trailingToolResults.filter(isToolResultError);
        const previousToolFailed = failedToolResults.length > 0;
        const previousApplyPatchFailed = failedToolResults.some(
          isApplyPatchVerificationError,
        );
        const previousErrorSnippet = failedToolResults[0]?.output
          ?.trim()
          .slice(0, 400);
        let didRepeatedFailedToolNudge = false;
        let protocolResult!: Exclude<StrictWebResponseResult, { kind: "protocol_error" }>;

        for (let describeRound = 0; ; describeRound += 1) {
          let pendingDescribeCalls: StrictWebToolCall[] | undefined;
          let pendingExternalCallsCount = 0;

          protocolResult = await runWebProtocolRetry({
            initialPrompt: roundPrompt,
            maxRetries,
            providerName: this.definition.assistantName,
            outputFormat: structuredOutputFormat,
            abortSignal: turnRegistration.signal,
            execute: async ({ attempt, prompt, isRetry }) => {
              pendingDescribeCalls = undefined;
              pendingExternalCallsCount = 0;
              totalPromptChars += prompt.length;
              attemptPrompts.push(prompt);
              traceSession?.recordAttemptPrompt({
                attempt: describeRound * (maxRetries + 1) + attempt,
                isRetry: isRetry || !isInitialRound,
                prompt,
              });
              let rawWebResponseForTrace: string | undefined;
              try {
                const isFirstExternalAttempt = isInitialRound && attempt === 0;
                const attachments = this.definition.attachments?.extractAttachments
                  ? this.definition.attachments.extractAttachments({
                      parsed,
                      attempt: isFirstExternalAttempt ? 0 : attempt + describeRound,
                      normalized,
                    })
                  : isFirstExternalAttempt
                    ? (normalized.images ?? [])
                    : [];

                const result = await this.definition.browser.executeTurn({
                  page: acquired.page!,
                  prompt,
                  attempt: isFirstExternalAttempt ? 0 : Math.max(1, attempt + describeRound),
                  parsed,
                  incoming: turnIncoming,
                  reasoningEffort,
                  conversationKey,
                  existingConversationId: activeConversationId,
                  launcherReused: acquired.launcherReused,
                  isNewConversation: isFirstExternalAttempt ? isNewConversation : false,
                  retain: retainTurn,
                  attachments,
                  turnTraceId,
                  heartbeat: acquired.heartbeat,
                });
                rawWebResponseForTrace = result.rawResponse;
                attemptOutputs.push(result.rawResponse);
                if (result.providerReportedTokens) {
                  latestReportedSource = result.providerReportedTokens.source;
                  if (
                    firstBeforeContextTokens === undefined &&
                    result.providerReportedTokens.beforeContextTokens !== undefined
                  ) {
                    firstBeforeContextTokens =
                      result.providerReportedTokens.beforeContextTokens;
                  }
                  if (result.providerReportedTokens.contextTokens !== undefined) {
                    latestAfterContextTokens =
                      result.providerReportedTokens.contextTokens;
                  }
                }

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

                if (parsedProtocol.kind === "tool_calls") {
                  lastFailedToolName = parsedProtocol.calls[0]?.name;
                  const describeCalls = parsedProtocol.calls.filter(call =>
                    WebToolRegistry.isInternalDescribeTool(call.name),
                  );
                  if (describeCalls.length > 0) {
                    if (describeRoundsUsed >= MAX_TOOL_DESCRIBE_ROUNDS) {
                      const limitError: Extract<StrictWebResponseResult, { kind: "protocol_error" }> = {
                        kind: "protocol_error",
                        code: "INVALID_TOOL_CALL",
                        message:
                          "Đã đạt giới hạn số lần gọi tools.describe trong lượt này. Hãy gọi trực tiếp tool thực thi hoặc xuất câu trả lời cuối cùng.",
                        rawResponse: lastRaw,
                      };
                      traceSession?.recordAttemptOutcome({
                        rawWebResponse: rawWebResponseForTrace,
                        sanitizedWebResponse: lastRaw,
                        parsedProtocolResult: limitError,
                      });
                      return limitError;
                    }

                    pendingDescribeCalls = describeCalls;
                    pendingExternalCallsCount = parsedProtocol.calls.length - describeCalls.length;
                    traceSession?.recordAttemptOutcome({
                      rawWebResponse: rawWebResponseForTrace,
                      sanitizedWebResponse: lastRaw,
                      parsedProtocolResult: {
                        kind: "internal_tool_describe",
                        requestedNames: extractRequestedToolNames(describeCalls),
                      },
                    });
                    return parsedProtocol;
                  }
                }

                let validatedResult = validateWebProtocolResponse(
                  parsedProtocol,
                  parsed.context.tools || [],
                  this.definition.response?.classifyValidationFailure
                    ? {
                        classifyFailure:
                          this.definition.response.classifyValidationFailure,
                      }
                    : undefined,
                );
                if (
                  validatedResult.kind === "final_answer" &&
                  !isPlanMode &&
                  hasStandaloneProposedPlanTag(validatedResult.content)
                ) {
                  if (isImplementingPlan) {
                    validatedResult = {
                      kind: "protocol_error",
                      code: "UNEXPECTED_PROPOSED_PLAN",
                      message:
                        'Kế hoạch đã được duyệt. Không xuất lại thẻ <proposed_plan>; hãy gọi <custom_tool_call name="apply_patch"> hoặc <tool_call> để triển khai.',
                      rawResponse: validatedResult.rawResponse,
                    };
                  } else {
                    const cleanedContent = stripStandaloneProposedPlanTags(
                      validatedResult.content,
                    );
                    validatedResult = cleanedContent
                      ? { ...validatedResult, content: cleanedContent }
                      : {
                          kind: "protocol_error",
                          code: "EMPTY_RESPONSE",
                          message:
                            "Phản hồi không còn nội dung hợp lệ sau khi loại bỏ thẻ <proposed_plan> ở Default Mode.",
                          rawResponse: validatedResult.rawResponse,
                        };
                  }
                }
                if (validatedResult.kind !== "protocol_error") {
                  lastFailedToolName = undefined;
                  lastProtocolError = undefined;
                }
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
              lastProtocolError = { code: result.code, message: result.message };
              console.warn(
                `[${this.definition.logPrefix}] [Format Error] Lỗi giao thức (${result.code}): ${result.message}`,
              );
            },
            resolveRetryPrompt: result => {
              if (structuredOutputFormat) return undefined;
              if (
                result.code !== "UNKNOWN_TOOL" &&
                result.code !== "INVALID_TOOL_CALL" &&
                result.code !== "INVALID_TOOL_SHAPE"
              ) {
                return undefined;
              }
              const detailCode =
                /^(UNKNOWN_TOOL|MISSING_ARGUMENT|INVALID_ARGUMENT):/.exec(result.message)?.[1] ||
                result.code;
              const schemaHint = mcpToolCatalogRenderer.renderToolDelta({
                currentTools: normalized.activeCodingTools,
                failedToolName: lastFailedToolName,
                failedErrorCode: detailCode,
                failedErrorMessage: result.message,
              });
              const baseRetry = buildFormatRetryPrompt({
                code: result.code,
                message: result.message,
                outputFormat: structuredOutputFormat,
              });
              return schemaHint ? `${baseRetry}\n\n${schemaHint}` : baseRetry;
            },
          });

          if (!pendingDescribeCalls || pendingDescribeCalls.length === 0) {
            if (
              this.definition.policies?.enableToolLoopGuard &&
              previousToolFailed &&
              !didRepeatedFailedToolNudge &&
              this.loopGuard.wouldRepeatPreviousToolCall({
                protocolResult,
                clientTools: parsed.context.tools || [],
                conversationKey,
              })
            ) {
              didRepeatedFailedToolNudge = true;
              const repeatedToolName =
                protocolResult.kind === "tool_calls"
                  ? protocolResult.calls[0]?.name || "unknown"
                  : "unknown";
              console.warn(
                `[${this.definition.logPrefix}] Phát hiện model lặp lại công cụ vừa lỗi (${repeatedToolName}); gửi nhắc sửa hướng nội bộ trước khi forward.`,
              );
              roundPrompt = buildRepeatedFailedToolRecoveryPrompt({
                toolName: repeatedToolName,
                isApplyPatch:
                  previousApplyPatchFailed || repeatedToolName === "apply_patch",
                errorSnippet: previousErrorSnippet,
              });
              isInitialRound = false;
              continue;
            }
            break;
          }

          describeRoundsUsed += 1;

          const requestedNames = extractRequestedToolNames(pendingDescribeCalls);
          const lookupResult = WebToolRegistry.describeTools(
            requestedNames,
            normalized.activeCodingTools,
          );
          for (const item of lookupResult.found) {
            if (!describedToolNames.includes(item.name)) {
              describedToolNames.push(item.name);
            }
          }

          const mixedNotice =
            pendingExternalCallsCount > 0
              ? "Các `<tool_call>` thực thi khác trong cùng tin nhắn vừa rồi chưa chạy — hãy gọi lại chúng sau khi xem schema dưới đây.\n\n"
              : "";
          roundPrompt = [
            `<tool_result name="${INTERNAL_TOOL_DESCRIBE_NAME}">`,
            "```json",
            JSON.stringify(lookupResult),
            "```",
            "</tool_result>",
            ...(mixedNotice ? [mixedNotice.trim()] : []),
            SHORT_OUTPUT_FORMAT_ANCHOR,
          ].join("\n\n");
          isInitialRound = false;
        }

        const aggregatedReportedTokens: ProviderReportedTokens | undefined =
          latestReportedSource && latestAfterContextTokens !== undefined && latestAfterContextTokens > 0
            ? {
                ...(firstBeforeContextTokens !== undefined
                  ? { beforeContextTokens: firstBeforeContextTokens }
                  : {}),
                contextTokens: latestAfterContextTokens,
                ...(firstBeforeContextTokens !== undefined &&
                latestAfterContextTokens > firstBeforeContextTokens
                  ? {
                      turnDeltaTokens:
                        latestAfterContextTokens - firstBeforeContextTokens,
                    }
                  : firstBeforeContextTokens === undefined
                    ? { turnDeltaTokens: latestAfterContextTokens }
                    : {}),
                source: latestReportedSource,
              }
            : undefined;

        const accurateUsage = computeAccurateTurnUsage({
          prompts: attemptPrompts.length > 0 ? attemptPrompts : [initialPrompt],
          rawOutputs: attemptOutputs.length > 0 ? attemptOutputs : [lastRaw],
          providerReportedTokens: aggregatedReportedTokens,
          modelId: parsed.modelId,
        });

        const usage = this.definition.response?.computeUsage
          ? this.definition.response.computeUsage({
              initialPrompt,
              totalPromptChars,
              lastRaw,
              prompts: attemptPrompts,
              rawOutputs: attemptOutputs,
              providerReportedTokens: aggregatedReportedTokens,
            })
          : undefined;
        const trackedUsage = usage ?? accurateUsage.usage;

        const turnDurationMs = Math.max(0, Date.now() - turnStartedAt);
        const totalTokensForRecord =
          trackedUsage.totalTokens ?? trackedUsage.inputTokens + trackedUsage.outputTokens;
        const { sessionContextTokens, taskUsage } = !structuredOutputFormat
          ? this.sessionStore.previewTaskUsage(sessionKey, normalized, {
              inputTokens: trackedUsage.inputTokens,
              outputTokens: trackedUsage.outputTokens,
              totalTokens: totalTokensForRecord,
              contextTokens: accurateUsage.contextTokens,
              turnStartedAt,
            })
          : {
              sessionContextTokens: accurateUsage.contextTokens ?? totalTokensForRecord,
              taskUsage: undefined,
            };

        const codexWindowUsage = usage
          ? (!structuredOutputFormat && sessionContextTokens > totalTokensForRecord
              ? {
                  inputTokens: Math.max(
                    trackedUsage.inputTokens,
                    sessionContextTokens - trackedUsage.outputTokens,
                  ),
                  outputTokens: trackedUsage.outputTokens,
                  totalTokens: Math.max(totalTokensForRecord, sessionContextTokens),
                }
              : usage)
          : undefined;

        const recordTurnUsage = () => {
          usageHistoryStore.append({
            id: turnTraceId,
            timestamp: new Date().toISOString(),
            providerId: this.definition.id,
            modelId: parsed.modelId,
            threadId,
            conversationKey,
            scenario: compileResult?.scenario,
            status: "completed",
            inputTokens: trackedUsage.inputTokens,
            outputTokens: trackedUsage.outputTokens,
            totalTokens: totalTokensForRecord,
            contextTokens: sessionContextTokens,
            tokenSource: accurateUsage.tokenSource,
            durationMs: turnDurationMs,
            attempts: Math.max(1, attemptPrompts.length),
            ...(compileResult
              ? {
                  breakdown: {
                    toolDeclarationChars: compileResult.metrics.toolDeclaration,
                    developerChars: compileResult.metrics.developerInstructions,
                    historyChars: compileResult.metrics.history,
                    toolResultsChars: compileResult.metrics.toolResults,
                    environmentChars: compileResult.metrics.environment,
                    userRequestChars: compileResult.metrics.userRequest,
                    finalPromptChars: compileResult.metrics.finalPrompt,
                  },
                }
              : {}),
          });
        };

          if (
          this.definition.policies?.enableToolLoopGuard &&
          this.loopGuard.evaluate({
            protocolResult,
            clientTools: parsed.context.tools || [],
            conversationKey,
            logPrefix: this.definition.logPrefix,
            emit: trackedEmit,
            usage: codexWindowUsage,
            previousToolFailed,
            nudgedRepeatedFailure: didRepeatedFailedToolNudge,
          })
        ) {
          if (!structuredOutputFormat) {
            this.sessionStore.commitTurnPrompt(
              sessionKey,
              normalized,
              describedToolNames,
              personalizationSnapshot?.digest,
              {
                availableSkillsDigest,
                selectedSkillsDigest,
              },
              {
                sessionContextTokens,
                activeTaskUsage: taskUsage,
              },
            );
          }
          recordTurnUsage();
          this.failoverCoordinator.recordTurnSuccess({
            providerId: this.definition.id,
            modelId: parsed.modelId,
            profileId: currentProfileId,
            threadId,
          });
          finalStatus = "completed";
          return;
        }

        const usageSettings = usageSettingsStore.getSnapshot().settings;
        const resultToEmit =
          !structuredOutputFormat &&
          usageSettings.showChatFooter &&
          protocolResult.kind === "final_answer"
            ? {
                ...protocolResult,
                content: UsageFooterFormatter.appendFooter(protocolResult.content, {
                  modelId: parsed.modelId,
                  stepsCount: taskUsage?.stepsCount ?? 1,
                  inputTokens: taskUsage?.inputTokens ?? trackedUsage.inputTokens,
                  outputTokens: taskUsage?.outputTokens ?? trackedUsage.outputTokens,
                  totalTokens: taskUsage?.totalTokens ?? totalTokensForRecord,
                  contextTokens: sessionContextTokens,
                  tokenSource: accurateUsage.tokenSource,
                  durationMs: taskUsage
                    ? Math.max(turnDurationMs, Date.now() - taskUsage.startedAt)
                    : turnDurationMs,
                }),
              }
            : protocolResult;

        emitWebProtocolResponse({
          result: resultToEmit,
          clientTools: parsed.context.tools || [],
          emit: trackedEmit,
          createCallId:
            this.definition.response?.createCallId ??
            (() =>
              `call_${this.definition.browser.launcherProviderId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`),
          usage: codexWindowUsage,
          includeDetailedDoneEvent:
            this.definition.response?.includeDetailedDoneEvent,
          toolCallStopReason: this.definition.response?.toolCallStopReason,
          toolCallEndTurn: this.definition.response?.toolCallEndTurn,
        });

        if (!structuredOutputFormat) {
          this.sessionStore.commitTurnPrompt(
            sessionKey,
            normalized,
            describedToolNames,
            personalizationSnapshot?.digest,
            {
              availableSkillsDigest,
              selectedSkillsDigest,
            },
            {
              sessionContextTokens,
              activeTaskUsage: taskUsage,
            },
          );
        }

        recordTurnUsage();
        this.failoverCoordinator.recordTurnSuccess({
          providerId: this.definition.id,
          modelId: parsed.modelId,
          profileId: currentProfileId,
          threadId,
        });
        finalStatus = "completed";
      } catch (error) {
        if (!structuredOutputFormat && lastProtocolError && lastFailedToolName) {
          this.sessionStore.recordValidationFailure(sessionKey, {
            toolName: lastFailedToolName,
            code: lastProtocolError.code,
            message: lastProtocolError.message,
          });
        }
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

        const rawMsg = error instanceof Error ? error.message : String(error);
        const classified = adapterFailureFromMessage(rawMsg);
        if (
          !turnRegistration.signal.aborted &&
          classified.error.code === "insufficient_quota"
        ) {
          const failover = this.failoverCoordinator.handleQuotaFailure({
            providerId: this.definition.id,
            modelId: parsed.modelId,
            profileId: currentProfileId,
            threadId,
            errorMessage: rawMsg,
            pinnedByCaller: initialProfile.pinnedByCaller,
            attemptedProfileIds,
            hasEmittedOutput,
            descriptorPath: resolvedDescriptorPath,
          });
          if (failover.shouldFailover && failover.nextProfileId) {
            retryNextProfileId = failover.nextProfileId;
          }
        }

        if (!retryNextProfileId) {
          if (this.definition.policies?.emitErrorEventOnFailure ?? true) {
            const prefix = this.definition.policies?.errorMessagePrefix;
            emit({
              type: "error",
              message: prefix ? `${prefix} ${rawMsg}` : rawMsg,
              ...(classified.error.code === "insufficient_quota"
                ? { retryable: false }
                : {}),
            });
          }

          if (this.definition.policies?.rethrowError ?? true) {
            throw error;
          }
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
          ...(retryNextProfileId ? { retainOverride: false } : {}),
          abortSignal: turnRegistration.signal,
          ops: this.lifecycleOps,
        });
      }

      if (retryNextProfileId) {
        console.warn(
          `[${this.definition.logPrefix}] Profile '${currentProfileId || "default"}' hết hạn mức model '${parsed.modelId}'; tự động chuyển sang profile '${retryNextProfileId}' (attempt=${failoverAttempt + 1}).`,
        );
        currentProfileId = retryNextProfileId;
        attemptedProfileIds.add(retryNextProfileId);
        forceNewConversation = true;
        continue;
      }
      break;
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
      this.definition.id,
    );
    const turnIncoming: IncomingMeta = {
      ...incoming,
      abortSignal: turnRegistration.signal,
    };

    try {
      const resolvedDescriptorPath =
        (this.lifecycleOps?.resolveDescriptorPath ?? resolveLauncherDescriptorPath)(
          this.definition.browser.descriptorPath,
          this.definition.browser.descriptorSubdirs,
        ) ?? undefined;
      const explicitProfile =
        request.profileId?.trim().toLowerCase() ||
        resolveRequestedProfileId(incoming.headers);
      const initialProfile = this.failoverCoordinator.resolveInitialProfile({
        providerId: this.definition.id,
        modelId: request.modelId,
        threadId: request.conversationKey,
        explicitProfileId: explicitProfile,
        descriptorPath: resolvedDescriptorPath,
      });
      let currentProfileId = initialProfile.profileId;
      let forceNewConversation = initialProfile.switchedFromStickyOrActive;
      const attemptedProfileIds = new Set<string>();
      if (currentProfileId) {
        attemptedProfileIds.add(currentProfileId);
      }

      for (let failoverAttempt = 0; ; failoverAttempt += 1) {
        const effectiveExistingId = forceNewConversation
          ? undefined
          : request.existingConversationId;
        const initialUrl = this.definition.browser.resolveInitialUrl?.({
          modelId: request.modelId,
          existingConversationId: effectiveExistingId,
        });
        const acquired = await acquireWebTurnSurface({
          definition: this.definition,
          localBrowser: this.localBrowser,
          turnTraceId,
          conversationKey,
          ...(initialUrl ? { initialUrl } : {}),
          ...(currentProfileId ? { profileId: currentProfileId } : {}),
          abortSignal: turnRegistration.signal,
          ops: this.lifecycleOps,
        });

        let activeConversationId = forceNewConversation
          ? undefined
          : effectiveExistingId || acquired.leaseConversationId;
        const isNewConversation =
          forceNewConversation ||
          (!acquired.launcherReused && !activeConversationId);
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
        let retryNextProfileId: string | undefined;
        try {
          const result = await this.definition.browser.executeTurn({
            page: acquired.page!,
            prompt: request.prompt,
            attempt: failoverAttempt,
            parsed: syntheticParsed,
            incoming: turnIncoming,
            reasoningEffort: request.reasoning,
            conversationKey,
            existingConversationId: activeConversationId,
            launcherReused: forceNewConversation ? false : acquired.launcherReused,
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

          this.failoverCoordinator.recordTurnSuccess({
            providerId: this.definition.id,
            modelId: request.modelId,
            profileId: currentProfileId,
            threadId: request.conversationKey,
          });
          finalStatus = "completed";
          return {
            outputText,
            ...(activeConversationId ? { conversationId: activeConversationId } : {}),
          };
        } catch (error) {
          finalStatus = turnRegistration.signal.aborted ? "aborted" : "failed";
          const rawMsg = error instanceof Error ? error.message : String(error);
          const classified = adapterFailureFromMessage(rawMsg);
          if (
            !turnRegistration.signal.aborted &&
            classified.error.code === "insufficient_quota"
          ) {
            const failover = this.failoverCoordinator.handleQuotaFailure({
              providerId: this.definition.id,
              modelId: request.modelId,
              profileId: currentProfileId,
              threadId: request.conversationKey,
              errorMessage: rawMsg,
              // Nếu đã có conversationId trên profile cũ, /v2/responses không giữ full history để tự dựng lại
              pinnedByCaller:
                initialProfile.pinnedByCaller || Boolean(activeConversationId),
              attemptedProfileIds,
              hasEmittedOutput: false,
              descriptorPath: resolvedDescriptorPath,
            });
            if (failover.shouldFailover && failover.nextProfileId) {
              retryNextProfileId = failover.nextProfileId;
            }
          }
          if (!retryNextProfileId) {
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
            parsed: syntheticParsed,
            hasPriorAssistantReply: !isNewConversation,
            hasToolResults: false,
            ...(retryNextProfileId ? { retainOverride: false } : {}),
            abortSignal: turnRegistration.signal,
            ops: this.lifecycleOps,
          });
        }

        if (retryNextProfileId) {
          currentProfileId = retryNextProfileId;
          attemptedProfileIds.add(retryNextProfileId);
          forceNewConversation = true;
          continue;
        }
        throw new Error(`[${this.definition.logPrefix}] Raw turn exited unexpectedly without result`);
      }
    } finally {
      turnRegistration.finish();
    }
  }

  /**
   * Tầng transport độc lập cho các client ngoài Codex IDE (như module `src/assistant/`):
   * chỉ quản lý vòng đời tab Launcher, abort, heartbeat và streaming snapshot opt-in;
   * không chạy prompt compiler, personalization, skills store hay usage footer của Codex IDE.
   */
  async runManagedTurn(
    request: ManagedTurnRequest,
    incoming: IncomingMeta,
  ): Promise<ManagedTurnResult> {
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
    const conversationKey = request.conversationKey;

    const turnRegistration = activeWebTurnRegistry.register(
      turnTraceId,
      incoming.abortSignal,
      this.definition.id,
    );
    const turnIncoming: IncomingMeta = {
      ...incoming,
      abortSignal: turnRegistration.signal,
    };

    try {
      const resolvedDescriptorPath =
        (this.lifecycleOps?.resolveDescriptorPath ?? resolveLauncherDescriptorPath)(
          this.definition.browser.descriptorPath,
          this.definition.browser.descriptorSubdirs,
        ) ?? undefined;
      const initialProfile = this.failoverCoordinator.resolveInitialProfile({
        providerId: this.definition.id,
        modelId: request.modelId,
        threadId: request.conversationKey,
        explicitProfileId: request.profileId,
        descriptorPath: resolvedDescriptorPath,
      });
      let currentProfileId = initialProfile.profileId;
      let forceNewConversation = initialProfile.switchedFromStickyOrActive;
      const attemptedProfileIds = new Set<string>();
      if (currentProfileId) {
        attemptedProfileIds.add(currentProfileId);
      }

      for (let failoverAttempt = 0; ; failoverAttempt += 1) {
        const effectiveExistingId = forceNewConversation
          ? undefined
          : request.existingConversationId;
        const initialUrl = this.definition.browser.resolveInitialUrl?.({
          modelId: request.modelId,
          existingConversationId: effectiveExistingId,
        });
        const acquired = await acquireWebTurnSurface({
          definition: this.definition,
          localBrowser: this.localBrowser,
          turnTraceId,
          conversationKey,
          ...(request.connectorIdentity ? { connectorIdentity: request.connectorIdentity } : {}),
          ...(initialUrl ? { initialUrl } : {}),
          ...(currentProfileId ? { profileId: currentProfileId } : {}),
          abortSignal: turnRegistration.signal,
          ops: this.lifecycleOps,
        });

        let activeConversationId = forceNewConversation
          ? undefined
          : effectiveExistingId || acquired.leaseConversationId;
        const isNewConversation = forceNewConversation
          ? true
          : request.isNewConversation !== undefined
            ? request.isNewConversation && !acquired.launcherReused && !activeConversationId
            : !acquired.launcherReused && !activeConversationId;
        const retain = request.retain ?? true;
        const syntheticParsed: CodexParsedRequest = {
          modelId: request.modelId,
          stream: request.streamIncremental === true,
          context: { messages: [], tools: [] },
          options: {
            ...(request.reasoning ? { reasoning: request.reasoning } : {}),
          },
        };
        const maxImages = this.definition.attachments?.maxInputImages ?? 3;
        const attachments: NormalizedImageAttachment[] = (request.images ?? [])
          .slice(0, maxImages)
          .map((image, index) => ({
            ref: `managed-img-${index}`,
            name: image.name || `image-${index + 1}.png`,
            mimeType: image.mimeType,
            dataUrl: image.dataUrl,
            buffer: image.buffer,
          }));

        let hasEmittedOutput = false;
        let finalStatus: WebTurnFinalStatus = "failed";
        let retryNextProfileId: string | undefined;
        try {
          const result = await this.definition.browser.executeTurn({
            page: acquired.page!,
            prompt: request.prompt,
            attempt: failoverAttempt > 0 ? failoverAttempt : (request.attempt ?? 0),
            parsed: syntheticParsed,
            incoming: turnIncoming,
            reasoningEffort: request.reasoning,
            conversationKey,
            existingConversationId: activeConversationId,
            launcherReused: forceNewConversation ? false : acquired.launcherReused,
            isNewConversation,
            retain,
            attachments,
            turnTraceId,
            streamIncremental: request.streamIncremental === true,
            onChunk: request.onChunk
              ? (chunk: string) => {
                  if (chunk) hasEmittedOutput = true;
                  request.onChunk?.(chunk);
                }
              : undefined,
            onTextSnapshot: request.onTextSnapshot
              ? (snapshot: string) => {
                  if (snapshot) hasEmittedOutput = true;
                  request.onTextSnapshot?.(snapshot);
                }
              : undefined,
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

          const rawResponse = this.definition.response?.sanitizeRawResponse
            ? this.definition.response.sanitizeRawResponse(result.rawResponse)
            : result.rawResponse;

          this.failoverCoordinator.recordTurnSuccess({
            providerId: this.definition.id,
            modelId: request.modelId,
            profileId: currentProfileId,
            threadId: request.conversationKey,
          });
          finalStatus = "completed";
          return {
            rawResponse,
            launcherReused: forceNewConversation ? false : acquired.launcherReused,
            ...(activeConversationId ? { conversationId: activeConversationId } : {}),
            ...(result.providerReportedTokens
              ? { providerReportedTokens: result.providerReportedTokens }
              : {}),
          };
        } catch (error) {
          finalStatus = turnRegistration.signal.aborted ? "aborted" : "failed";
          const rawMsg = error instanceof Error ? error.message : String(error);
          const classified = adapterFailureFromMessage(rawMsg);
          if (
            !turnRegistration.signal.aborted &&
            classified.error.code === "insufficient_quota"
          ) {
            const failover = this.failoverCoordinator.handleQuotaFailure({
              providerId: this.definition.id,
              modelId: request.modelId,
              profileId: currentProfileId,
              threadId: request.conversationKey,
              errorMessage: rawMsg,
              pinnedByCaller:
                initialProfile.pinnedByCaller || Boolean(activeConversationId),
              attemptedProfileIds,
              hasEmittedOutput,
              descriptorPath: resolvedDescriptorPath,
            });
            if (failover.shouldFailover && failover.nextProfileId) {
              retryNextProfileId = failover.nextProfileId;
            }
          }
          if (!retryNextProfileId) {
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
            parsed: syntheticParsed,
            hasPriorAssistantReply: !isNewConversation,
            hasToolResults: false,
            retainOverride: retryNextProfileId ? false : retain ? undefined : false,
            abortSignal: turnRegistration.signal,
            ops: this.lifecycleOps,
          });
        }

        if (retryNextProfileId) {
          currentProfileId = retryNextProfileId;
          attemptedProfileIds.add(retryNextProfileId);
          forceNewConversation = true;
          continue;
        }
        throw new Error(`[${this.definition.logPrefix}] Raw turn exited unexpectedly without result`);
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
      page: Page;
      launcherReused: boolean;
      signal: AbortSignal;
      heartbeat?: () => Promise<void>;
    }) => Promise<T>,
    options?: {
      initialUrl?: string;
      profileId?: string;
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
      this.definition.id,
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
        profileId: options?.profileId,
        abortSignal: turnSignal,
        ops: this.lifecycleOps,
      });

      if (!acquired.page) {
        throw new Error(
          `[${this.definition.logPrefix}] Không có trình duyệt khả dụng để thực thi tác vụ.`,
        );
      }

      let finalStatus: WebTurnFinalStatus = "failed";
      try {
        const result = await task({
          page: acquired.page,
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

  /**
   * Quét danh sách model khả dụng trực tiếp trên Web UI của provider thông qua một tab Launcher tạm,
   * đảm bảo không chen ngang lượt đang chạy (`ProviderBusyError`) và tự đóng tab sau khi quét xong.
   */
  async discoverModels(
    incoming: IncomingMeta = { headers: new Headers() },
  ): Promise<DiscoveredModelEntry[]> {
    const discover = this.definition.browser.discoverModels;
    if (typeof discover !== "function") {
      throw new Error(
        `[${this.definition.logPrefix}] Provider '${this.definition.id}' chưa cài đặt logic quét model.`,
      );
    }

    if (
      activeWebTurnRegistry.hasActiveTurnForProvider(this.definition.id) ||
      inFlightDiscoveries.has(this.definition.id)
    ) {
      throw new ProviderBusyError(this.definition.id);
    }

    inFlightDiscoveries.add(this.definition.id);
    try {
      const initialUrl = this.definition.browser.resolveInitialUrl?.({ modelId: "" });
      return await this.runEphemeralSurfaceTask(
        incoming,
        async ({ page, signal, heartbeat }) => {
          await heartbeat?.().catch(() => {});
          return await discover({ page, abortSignal: signal });
        },
        {
          ...(initialUrl ? { initialUrl } : {}),
          retainOnCompleted: false,
          omitConnectorIdentity: true,
        },
      );
    } finally {
      inFlightDiscoveries.delete(this.definition.id);
    }
  }

  /**
   * Kiểm tra hạn mức sử dụng trực tiếp trên Web UI / API nội bộ của provider cho một profile cụ thể
   * thông qua tab Launcher tạm (không chen ngang lượt đang chạy, không đổi activeProfileId).
   */
  async checkUsageLimit(
    request: UsageLimitCheckRequest = {},
    incoming: IncomingMeta = { headers: new Headers() },
  ): Promise<ProviderLimitCheckResult> {
    const checker = this.definition.browser.checkUsageLimit;
    if (typeof checker !== "function") {
      throw new Error(
        `[${this.definition.logPrefix}] Provider '${this.definition.id}' chưa hỗ trợ kiểm tra limit trực tiếp.`,
      );
    }

    const profileId = request.profileId?.trim().toLowerCase() || "default";
    const lockKey = `${this.definition.id}::${profileId}`;
    if (
      activeWebTurnRegistry.hasActiveTurnForProvider(this.definition.id) ||
      inFlightLimitChecks.has(lockKey)
    ) {
      throw new ProviderBusyError(this.definition.id);
    }

    inFlightLimitChecks.add(lockKey);
    try {
      const initialUrl =
        this.definition.browser.usageLimitUrl ??
        this.definition.browser.resolveInitialUrl?.({ modelId: "" });
      return await this.runEphemeralSurfaceTask(
        incoming,
        async ({ page, signal, heartbeat }) => {
          await heartbeat?.().catch(() => {});
          return await checker({ page, abortSignal: signal });
        },
        {
          ...(initialUrl ? { initialUrl } : {}),
          profileId,
          retainOnCompleted: false,
          omitConnectorIdentity: true,
        },
      );
    } finally {
      inFlightLimitChecks.delete(lockKey);
    }
  }
}
