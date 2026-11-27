import { createHash } from "node:crypto";
import { join } from "node:path";
import { AdapterRegistry, type ProviderAdapterFactory } from "../adapters/adapter-registry";
import type { ManagedTurnRequest } from "../adapters/base";
import { CodexPayloadNormalizer, CodexRawPayload } from "../adapters/web/normalization";
import { WebPromptSessionStore } from "../adapters/web/execution/web-prompt-session-store";
import {
  isApplyPatchVerificationError,
  isStructuredJsonOutputTurn,
  isToolResultError,
} from "../adapters/web/prompt/compiler";
import { parseAndValidateJsonSchemaResponse } from "../adapters/web/protocol/json-schema-response";
import type { StrictWebToolCall } from "../adapters/web/protocol/strict-response-parser";
import { validateWebProtocolResponse } from "../adapters/web/protocol/validate-response";
import {
  INTERNAL_TOOL_DESCRIBE_NAME,
  WebToolBridge,
  WebToolRegistry,
} from "../adapters/web/tools";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "../bridge";
import { getConfigDir } from "../config";
import type { NativeCodexTurnIdentity } from "../controllers/http-turn-counter";
import { AsyncEventQueue } from "../event-queue";
import { adapterFailureFromMessage } from "../lib/errors";
import type { BaseModelProvider } from "../models/base-model-provider";
import { ModelRegistry } from "../models/model-registry";
import type { ModelProviderId } from "../models/types";
import { parseRequest } from "../responses/parser";
import { expandPreviousResponseInput, rememberResponseState } from "../responses/state";
import { extractCodexTurnIdentityFromBody } from "../responses/turn-identity";
import { isCodexThreadTitleRequest, type ActiveTurnContext } from "../services/responses-service";
import { ThreadProviderBindingStore } from "../services/thread-provider-binding-store";
import { namespacedToolName, type AdapterEvent, type CodexParsedRequest } from "../types";
import { computeAccurateTurnUsage } from "../usage";
import { AssistantPromptCompiler } from "./assistant-prompt-compiler";
import {
  buildAssistantFormatRetryPrompt,
  buildAssistantRepeatedFailedToolPrompt,
} from "./assistant-prompt-templates";
import { AssistantResponseParser } from "./assistant-response-parser";
import { AssistantStreamGate } from "./assistant-stream-gate";
import { assistantToolCatalogRenderer } from "./assistant-tool-catalog-renderer";
import type { AssistantParsedResponse, AssistantTurnContext } from "./types";

const MAX_TOOL_DESCRIBE_ROUNDS = 2;
const MAX_FORMAT_RETRIES = 2;
const ACTIVE_TURN_CONTEXT_TTL_MS = 30 * 60_000;
const MAX_ACTIVE_TURN_CONTEXTS = 256;
const MAX_CONVERSATION_CACHE = 256;

const PROVIDER_ASSISTANT_NAMES: Record<string, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  "ai-studio": "Gemini",
  "m365-copilot": "M365",
};

export interface AssistantRequestOptions {
  rememberState?: boolean;
  onAdapterEvent?: (event: AdapterEvent) => void;
  onTurnIdentity?: (identity: NativeCodexTurnIdentity) => void;
}

export type AssistantProviderResolution =
  | { ok: true; provider: BaseModelProvider; requestedModel: string }
  | { ok: false; message: string };

function extractRequestedToolNames(calls: StrictWebToolCall[]): string[] {
  const names: string[] = [];
  for (const call of calls) {
    const rawArgs = call.arguments;
    const obj =
      rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
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
      if (cleaned && !names.includes(cleaned)) names.push(cleaned);
    }
  }
  return names;
}

/**
 * Tầng nghiệp vụ hoàn toàn độc lập cho `/clients/assistant/v1/responses` và `/compact`:
 * - Sở hữu riêng `ThreadProviderBindingStore` (`assistant-thread-bindings.json`),
 *   `WebPromptSessionStore`, `AssistantPromptCompiler`, `AssistantResponseParser` và `AssistantStreamGate`.
 * - Không đụng vào `ResponsesService`, `PersonalizationStore`, `SkillsStore` hay `~/.codex/config.toml` của VS Code Codex.
 * - Stream chữ trực tiếp về Telegram qua SSE, chỉ chặn khi AI gọi công cụ (`<tool_call>` / `apply_patch`).
 */
export class AssistantResponsesService {
  private recentPrimaryContext: (AssistantTurnContext & { recordedAt: number }) | null = null;
  private readonly turnContextsByThread = new Map<
    string,
    AssistantTurnContext & { recordedAt: number }
  >();
  private readonly conversationIdByKey = new Map<string, string>();
  private readonly lastToolCallSignatureByKey = new Map<string, string>();
  private readonly sessionStore = new WebPromptSessionStore();

  constructor(
    private readonly modelRegistry: ModelRegistry = ModelRegistry.getInstance(),
    private readonly adapterRegistry: AdapterRegistry = AdapterRegistry.getInstance(),
    private readonly threadBindingStore: ThreadProviderBindingStore = new ThreadProviderBindingStore({
      filePath: join(getConfigDir(), "assistant-thread-bindings.json"),
    }),
    private readonly promptCompiler: AssistantPromptCompiler = new AssistantPromptCompiler(),
    private readonly responseParser: AssistantResponseParser = new AssistantResponseParser(),
  ) {}

  public resolveProvider(requestedModel: unknown): AssistantProviderResolution {
    const access = this.modelRegistry.resolveProviderAccess(requestedModel);
    if (!access.ok) return access;
    return {
      ok: true,
      provider: access.provider,
      requestedModel: access.requestedModel,
    };
  }

  public bindTurnIdentity(raw: unknown, options: AssistantRequestOptions): void {
    const identity = extractCodexTurnIdentityFromBody(raw);
    if (identity.threadId && identity.turnId) {
      options.onTurnIdentity?.({ threadId: identity.threadId, turnId: identity.turnId });
    }
  }

  public resolveThreadTurnContext(threadId?: string): ActiveTurnContext | undefined {
    const cleanId = threadId?.trim();
    if (!cleanId) return undefined;
    const entry = this.turnContextsByThread.get(cleanId);
    if (!entry || Date.now() - entry.recordedAt > ACTIVE_TURN_CONTEXT_TTL_MS) {
      return undefined;
    }
    return {
      providerId: entry.providerId,
      modelId: entry.modelId,
      ...(entry.reasoning ? { reasoning: entry.reasoning } : {}),
    };
  }

  public resolveActiveTurnContext(identity?: {
    threadId?: string;
    turnId?: string;
  }): ActiveTurnContext | undefined {
    const byThread = this.resolveThreadTurnContext(identity?.threadId);
    if (byThread) return byThread;
    const recent = this.recentPrimaryContext;
    if (recent && Date.now() - recent.recordedAt <= ACTIVE_TURN_CONTEXT_TTL_MS) {
      return {
        providerId: recent.providerId,
        modelId: recent.modelId,
        ...(recent.reasoning ? { reasoning: recent.reasoning } : {}),
      };
    }
    return undefined;
  }

  public prepareCompactionRequest(
    req: Request,
    raw: Record<string, unknown>,
  ): { request: Request; payload: Record<string, unknown> } {
    let payload = raw;
    const headerTurnMetadata = req.headers.get("x-codex-turn-metadata");
    if (headerTurnMetadata) {
      const existingMetadata = raw.client_metadata;
      const clientMetadata =
        existingMetadata && typeof existingMetadata === "object" && !Array.isArray(existingMetadata)
          ? (existingMetadata as Record<string, unknown>)
          : {};
      payload = {
        ...raw,
        client_metadata: {
          ...clientMetadata,
          "x-codex-turn-metadata": headerTurnMetadata,
        },
      };
    }

    const input = Array.isArray(payload.input) ? payload.input : [];
    const headers = new Headers(req.headers);
    headers.set("content-type", "application/json");
    const compactionPayload: Record<string, unknown> = {
      ...payload,
      stream: false,
      input: [...input, { type: "compaction_trigger" }],
    };

    const request = new Request("http://127.0.0.1/clients/assistant/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify(compactionPayload),
      signal: req.signal,
    });
    return { request, payload: compactionPayload };
  }

  public async executeTurn(params: {
    req: Request;
    raw: unknown;
    requestedModel: string;
    providerId: string;
    options?: AssistantRequestOptions;
    adapterFactory?: ProviderAdapterFactory;
  }): Promise<Response> {
    const {
      req,
      raw,
      requestedModel,
      providerId,
      options = {},
      adapterFactory,
    } = params;

    const effectiveTarget = this.resolveEffectiveTurnTarget(raw, requestedModel, providerId);
    const effectiveModel = effectiveTarget.modelId;
    const effectiveProviderId = effectiveTarget.providerId;

    const rawObj =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const requestedPreviousResponseId = rawObj.previous_response_id;
    const requestId =
      typeof rawObj.id === "string"
        ? rawObj.id
        : `asst_${createHash("sha256").update(JSON.stringify(raw)).digest("hex").slice(0, 12)}`;

    const expandedRaw = expandPreviousResponseInput(raw);
    if (typeof requestedPreviousResponseId === "string" && expandedRaw === raw) {
      return formatErrorResponse(
        409,
        "invalid_request_error",
        `Local continuation state for previous_response_id is unavailable for assistant provider '${effectiveProviderId}'.`,
      );
    }

    const expanded =
      effectiveModel !== requestedModel &&
      expandedRaw &&
      typeof expandedRaw === "object" &&
      !Array.isArray(expandedRaw)
        ? { ...(expandedRaw as Record<string, unknown>), model: effectiveModel }
        : expandedRaw;

    let parsed: CodexParsedRequest;
    try {
      parsed = parseRequest(expanded);
      this.bindTurnIdentity(expanded, options);
    } catch (error) {
      return formatErrorResponse(
        400,
        "invalid_request_error",
        error instanceof Error ? error.message : String(error),
      );
    }

    const identity = extractCodexTurnIdentityFromBody(expanded);
    const headerConversationKey = req.headers.get("x-codex-conversation-key")?.trim();
    const persistentThreadId =
      identity.threadId && identity.threadId !== "default"
        ? identity.threadId
        : headerConversationKey && headerConversationKey !== "default"
          ? headerConversationKey
          : undefined;
    const isTitleRequest = isCodexThreadTitleRequest(raw);

    if (!isTitleRequest && persistentThreadId) {
      const existingBinding = this.threadBindingStore.get(persistentThreadId);
      if (existingBinding && existingBinding.providerId !== effectiveProviderId) {
        const sameProviderModels = this.modelRegistry
          .listEnabledRoutes(existingBinding.providerId as ModelProviderId)
          .map((route) => route.slug);
        const allowedText =
          sameProviderModels.length > 0
            ? `các model hợp lệ cùng provider: ${sameProviderModels.join(", ")}`
            : `hãy chọn model thuộc provider '${existingBinding.providerId}'`;
        return formatErrorResponse(
          400,
          "invalid_request_error",
          `Không thể đổi sang provider '${effectiveProviderId}' trong luồng trợ lý đang gắn với '${existingBinding.providerId}' (${allowedText}). Hãy dùng /new để tạo phiên mới.`,
        );
      }
    }

    if (!isTitleRequest) {
      this.rememberActiveTurnContext(persistentThreadId, {
        providerId: effectiveProviderId,
        modelId: effectiveModel,
        ...(parsed.options.reasoning ? { reasoning: parsed.options.reasoning } : {}),
      });
    }

    const adapter = adapterFactory
      ? adapterFactory()
      : this.adapterRegistry.createAdapter(effectiveProviderId);
    if (typeof adapter.runManagedTurn !== "function") {
      return formatErrorResponse(
        400,
        "invalid_request_error",
        `Provider '${effectiveProviderId}' does not support managed assistant turns.`,
      );
    }

    const queue = new AsyncEventQueue<AdapterEvent>();
    const abort = new AbortController();
    if (req.signal.aborted) abort.abort();
    else req.signal.addEventListener("abort", () => abort.abort(), { once: true });

    const requestedProfileId = req.headers.get("x-gateway-profile-id")?.trim() || undefined;
    const emitEvent = (event: AdapterEvent): void => {
      options.onAdapterEvent?.(event);
      queue.push(event);
    };

    const run = async () => {
      try {
        await this.runAssistantManagedTurn({
          adapter,
          parsed,
          reqHeaders: req.headers,
          abortSignal: abort.signal,
          effectiveModel,
          effectiveProviderId,
          persistentThreadId,
          requestId,
          isTitleRequest,
          profileId: requestedProfileId,
          emit: emitEvent,
        });
      } catch (error) {
        const rawMsg = error instanceof Error ? error.message : String(error);
        const classified = adapterFailureFromMessage(rawMsg);
        emitEvent({
          type: "error",
          message: `[Assistant/${effectiveProviderId}] ${rawMsg}`,
          ...(classified.error.code === "insufficient_quota" ? { retryable: false } : {}),
        });
      } finally {
        queue.close();
      }
    };

    const maps = this.buildToolBridgeMaps(parsed);
    const rememberCompletedResponse = (response: Record<string, unknown>): void => {
      if (response.status === "completed" && !isTitleRequest && persistentThreadId) {
        this.threadBindingStore.bind(persistentThreadId, {
          providerId: effectiveProviderId,
          modelId: effectiveModel,
          ...(parsed.options.reasoning ? { reasoning: parsed.options.reasoning } : {}),
        });
      }
      if (options.rememberState !== false) {
        rememberResponseState(parsed._rawBody, response, { force: true });
      }
    };

    if (parsed.stream) {
      void run();
      const stream = bridgeToResponsesSSE(
        queue,
        requestedModel,
        maps.toolNsMap,
        maps.freeformToolNames,
        maps.toolSearchToolNames,
        () => abort.abort(),
        2_000,
        {
          hideThinkingSummary: parsed.options.hideThinkingSummary,
          compaction: parsed._compactionRequest === true && parsed._compactionResponseFormat !== "message",
          onCompletedResponse: rememberCompletedResponse,
        },
      );
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    await run();
    const events = await queue.collect();
    const json = buildResponseJSON(events, requestedModel, {
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      toolNsMap: maps.toolNsMap,
      freeformToolNames: maps.freeformToolNames,
      toolSearchToolNames: maps.toolSearchToolNames,
      compaction: parsed._compactionRequest === true && parsed._compactionResponseFormat !== "message",
    });
    rememberCompletedResponse(json);
    return Response.json(json);
  }

  private async runAssistantManagedTurn(params: {
    adapter: { runManagedTurn?: (req: ManagedTurnRequest, meta: { headers: Headers; abortSignal?: AbortSignal }) => Promise<{ rawResponse: string; conversationId?: string; launcherReused: boolean; providerReportedTokens?: { beforeContextTokens?: number; contextTokens?: number; turnDeltaTokens?: number; source: "ai-studio-dom" | "tiktoken" | "char-estimate" } }> };
    parsed: CodexParsedRequest;
    reqHeaders: Headers;
    abortSignal: AbortSignal;
    effectiveModel: string;
    effectiveProviderId: string;
    persistentThreadId?: string;
    requestId: string;
    isTitleRequest: boolean;
    profileId?: string;
    emit: (event: AdapterEvent) => void;
  }): Promise<void> {
    const {
      adapter,
      parsed,
      reqHeaders,
      abortSignal,
      effectiveModel,
      effectiveProviderId,
      persistentThreadId,
      requestId,
      isTitleRequest,
      profileId,
      emit,
    } = params;

    const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
    const normalized = CodexPayloadNormalizer.normalize(rawPayload, {
      maxImages: 3,
      parsed,
    });
    const hasToolResults = normalized.trailingToolResults.length > 0;
    const structuredFormat = isStructuredJsonOutputTurn(parsed, hasToolResults)
      ? parsed.options.outputFormat
      : undefined;
    const isEphemeral =
      isTitleRequest || (Boolean(structuredFormat) && !persistentThreadId);

    const conversationKeySeed = isEphemeral
      ? `assistant:ephemeral:${effectiveProviderId}:${requestId}`
      : `assistant:${effectiveProviderId}:${persistentThreadId || requestId}`;
    // Control-server Launcher bắt buộc conversationKey là 64 ký tự hex SHA-256.
    const conversationKey = createHash("sha256").update(conversationKeySeed).digest("hex");
    const connectorIdentity = `${effectiveProviderId}:assistant`;
    const existingConversationId = isEphemeral
      ? undefined
      : this.conversationIdByKey.get(conversationKey);
    const hasKnownSession = !isEphemeral && Boolean(this.sessionStore.get(conversationKey));
    const isNewConversation = isEphemeral || (!existingConversationId && !hasKnownSession);

    const skillInfo = this.promptCompiler.computeSkillsDigests(normalized);
    const directives = !structuredFormat
      ? this.sessionStore.resolveTurnDirectives(isEphemeral ? undefined : conversationKey, {
          isNewConversation,
          normalized,
          availableSkillsDigest: skillInfo.availableSkillsDigest,
          selectedSkillsDigest: skillInfo.selectedSkillsDigest,
        })
      : undefined;

    const compileResult = this.promptCompiler.compile({
      normalized,
      parsed,
      assistantName: PROVIDER_ASSISTANT_NAMES[effectiveProviderId] || "trợ lý",
      isNewConversation,
      toolDelta: directives?.toolDelta,
      includeEnvironment: directives?.includeEnvironment,
      includeUserInstruction: directives?.includeUserInstruction,
      includeAvailableSkills: directives?.includeAvailableSkills,
      includeSelectedSkills: directives?.includeSelectedSkills,
    });

    const allowLiveStreaming =
      parsed.stream === true &&
      !structuredFormat &&
      parsed._compactionRequest !== true;

    const failedToolResults = normalized.trailingToolResults.filter(isToolResultError);
    const previousToolFailed = failedToolResults.length > 0;
    const previousErrorSnippet = failedToolResults[0]?.output?.trim().slice(0, 300);

    const attemptPrompts: string[] = [];
    const attemptOutputs: string[] = [];
    const describedToolNames: string[] = [];

    let roundPrompt = compileResult.finalPrompt;
    let activeConversationId = existingConversationId;
    let isFirstExternalAttempt = true;
    let describeRoundsUsed = 0;
    let didRepeatedFailedToolNudge = false;
    let finalGate: AssistantStreamGate | null = null;
    let finalParsed!: Exclude<AssistantParsedResponse, { kind: "protocol_error" }>;

    for (;;) {
      let formatRetryCount = 0;
      let attemptPrompt = roundPrompt;
      let pendingDescribeCalls: StrictWebToolCall[] | undefined;

      while (true) {
        const streamGate = allowLiveStreaming
          ? new AssistantStreamGate((delta) => {
              emit({ type: "text_delta", text: delta });
            })
          : null;
        finalGate = streamGate;

        attemptPrompts.push(attemptPrompt);
        const turnResult = await adapter.runManagedTurn!(
          {
            modelId: effectiveModel,
            prompt: attemptPrompt,
            reasoning: parsed.options.reasoning,
            images: isFirstExternalAttempt ? (normalized.images ?? []) : [],
            conversationKey,
            connectorIdentity,
            existingConversationId: activeConversationId,
            isNewConversation: isFirstExternalAttempt ? isNewConversation : false,
            retain: !isEphemeral,
            ...(profileId ? { profileId } : {}),
            attempt: attemptPrompts.length - 1,
            streamIncremental: allowLiveStreaming,
            ...(streamGate
              ? {
                  onTextSnapshot: (snapshot: string) => {
                    streamGate.pushSnapshot(snapshot);
                  },
                }
              : {}),
          },
          { headers: reqHeaders, abortSignal },
        );

        isFirstExternalAttempt = false;
        if (turnResult.conversationId && !isEphemeral) {
          activeConversationId = turnResult.conversationId;
          this.rememberConversationId(conversationKey, turnResult.conversationId);
        }
        attemptOutputs.push(turnResult.rawResponse);

        if (structuredFormat) {
          const jsonRes = parseAndValidateJsonSchemaResponse(
            turnResult.rawResponse,
            structuredFormat,
          );
          if (jsonRes.kind === "protocol_error") {
            if (formatRetryCount < MAX_FORMAT_RETRIES) {
              formatRetryCount += 1;
              attemptPrompt = buildAssistantFormatRetryPrompt({
                code: jsonRes.code,
                message: jsonRes.message,
                outputFormat: structuredFormat,
              });
              continue;
            }
            throw new Error(`Assistant structured output error: ${jsonRes.message}`);
          }
          finalParsed = {
            kind: "final_answer",
            content: jsonRes.kind === "final_answer" ? jsonRes.content : turnResult.rawResponse,
            rawResponse: turnResult.rawResponse,
          };
          break;
        }

        const parsedResp = this.responseParser.parse(turnResult.rawResponse);
        if (parsedResp.kind === "tool_calls") {
          const describeCalls = parsedResp.calls.filter((call) =>
            WebToolRegistry.isInternalDescribeTool(call.name),
          );
          if (describeCalls.length > 0 && describeRoundsUsed < MAX_TOOL_DESCRIBE_ROUNDS) {
            pendingDescribeCalls = describeCalls;
            finalParsed = parsedResp;
            break;
          }

          const validated = validateWebProtocolResponse(
            { kind: "tool_calls", calls: parsedResp.calls, rawResponse: parsedResp.rawResponse },
            parsed.context.tools || [],
          );
          if (validated.kind === "protocol_error") {
            if (!streamGate?.hasStreamedText() && formatRetryCount < MAX_FORMAT_RETRIES) {
              formatRetryCount += 1;
              const failedName = parsedResp.calls[0]?.name;
              const schemaHint = assistantToolCatalogRenderer.renderToolDelta({
                currentTools: normalized.activeCodingTools,
                failedToolName: failedName,
                failedErrorCode: validated.code,
                failedErrorMessage: validated.message,
              });
              attemptPrompt = buildAssistantFormatRetryPrompt({
                code: validated.code,
                message: validated.message,
                schemaHint,
              });
              continue;
            }
            // Nếu đã lỡ stream phần mở đầu hoặc hết retry: trả lỗi gọn thay vì hỏng SSE stream.
            finalParsed = {
              kind: "final_answer",
              content:
                streamGate?.hasStreamedText()
                  ? `${streamGate.getEmittedText()}\n\n_(Không thể gọi công cụ: ${validated.message})_`
                  : `Xin lỗi, lời gọi công cụ gặp lỗi định dạng: ${validated.message}`,
              rawResponse: turnResult.rawResponse,
            };
            break;
          }

          finalParsed = {
            kind: "tool_calls",
            calls: validated.kind === "tool_calls" ? validated.calls : parsedResp.calls,
            commentaryText: parsedResp.commentaryText,
            rawResponse: parsedResp.rawResponse,
          };
          break;
        }

        if (parsedResp.kind === "protocol_error") {
          if (!streamGate?.hasStreamedText() && formatRetryCount < MAX_FORMAT_RETRIES) {
            formatRetryCount += 1;
            attemptPrompt = buildAssistantFormatRetryPrompt({
              code: parsedResp.code,
              message: parsedResp.message,
            });
            continue;
          }
          throw new Error(`Assistant protocol error (${parsedResp.code}): ${parsedResp.message}`);
        }

        finalParsed = parsedResp;
        break;
      }

      if (pendingDescribeCalls && pendingDescribeCalls.length > 0) {
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
        roundPrompt = [
          `<tool_result name="${INTERNAL_TOOL_DESCRIBE_NAME}">`,
          "```json",
          JSON.stringify(lookupResult),
          "```",
          "</tool_result>",
          "Hãy xuất `<tool_call>` thực thi với schema trên bọc trong 4-backtick + `<webResponse>...</webResponse>` hoặc trả lời trực tiếp bằng Markdown tự nhiên.",
        ].join("\n\n");
        continue;
      }

      // Chống lặp y hệt 1 lệnh vừa thất bại
      if (
        finalParsed.kind === "tool_calls" &&
        previousToolFailed &&
        !didRepeatedFailedToolNudge &&
        !finalGate?.hasStreamedText()
      ) {
        const sig = JSON.stringify(finalParsed.calls.map((c) => ({ n: c.name, a: c.arguments })));
        if (this.lastToolCallSignatureByKey.get(conversationKey) === sig) {
          didRepeatedFailedToolNudge = true;
          roundPrompt = buildAssistantRepeatedFailedToolPrompt({
            toolName: finalParsed.calls[0]?.name || "tool",
            errorSnippet: previousErrorSnippet,
          });
          continue;
        }
      }

      break;
    }

    const usage = computeAccurateTurnUsage({
      prompts: attemptPrompts,
      rawOutputs: attemptOutputs,
      modelId: effectiveModel,
    }).usage;

    if (finalParsed.kind === "final_answer") {
      this.lastToolCallSignatureByKey.delete(conversationKey);
      if (finalGate) {
        finalGate.finalizeAsFinalAnswer(finalParsed.content);
      } else {
        emit({ type: "text_delta", text: finalParsed.content });
      }
      emit({
        type: "done",
        stopReason: "stop",
        endTurn: true,
        finalText: finalParsed.content,
        usage,
      });
    } else {
      const sig = JSON.stringify(finalParsed.calls.map((c) => ({ n: c.name, a: c.arguments })));
      this.lastToolCallSignatureByKey.set(conversationKey, sig);
      for (const rawCall of finalParsed.calls) {
        const mapped = WebToolBridge.mapToolCall(rawCall, parsed.context.tools || []);
        const callId =
          rawCall.id ||
          `call_asst_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const serializedArgs =
          typeof mapped.arguments === "string"
            ? mapped.arguments
            : JSON.stringify(mapped.arguments ?? {});
        emit({ type: "tool_call_start", id: callId, name: mapped.name });
        emit({ type: "tool_call_delta", arguments: serializedArgs });
        emit({ type: "tool_call_end" });
      }
      emit({
        type: "done",
        stopReason: "tool_use",
        endTurn: false,
        usage,
      });
    }

    if (!structuredFormat && !isEphemeral) {
      this.sessionStore.commitTurnPrompt(
        conversationKey,
        normalized,
        describedToolNames,
        undefined,
        {
          availableSkillsDigest: skillInfo.availableSkillsDigest,
          selectedSkillsDigest: skillInfo.selectedSkillsDigest,
        },
      );
    }
  }

  private rememberActiveTurnContext(
    threadId: string | undefined,
    context: AssistantTurnContext,
  ): void {
    const entry = { ...context, recordedAt: Date.now() };
    this.recentPrimaryContext = entry;
    if (!threadId || threadId === "default") return;
    this.turnContextsByThread.delete(threadId);
    this.turnContextsByThread.set(threadId, entry);
    while (this.turnContextsByThread.size > MAX_ACTIVE_TURN_CONTEXTS) {
      const oldest = this.turnContextsByThread.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.turnContextsByThread.delete(oldest);
    }
  }

  private rememberConversationId(conversationKey: string, conversationId: string): void {
    this.conversationIdByKey.delete(conversationKey);
    this.conversationIdByKey.set(conversationKey, conversationId);
    while (this.conversationIdByKey.size > MAX_CONVERSATION_CACHE) {
      const oldest = this.conversationIdByKey.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.conversationIdByKey.delete(oldest);
    }
  }

  private resolveEffectiveTurnTarget(
    raw: unknown,
    requestedModel: string,
    providerId: string,
  ): { modelId: string; providerId: string } {
    if (!isCodexThreadTitleRequest(raw)) {
      return { modelId: requestedModel, providerId };
    }
    const recent = this.recentPrimaryContext;
    if (!recent || Date.now() - recent.recordedAt > 60_000) {
      return { modelId: requestedModel, providerId };
    }
    const status = this.modelRegistry.getModelStatus(recent.modelId);
    if (status.status !== "enabled" || !status.providerId) {
      return { modelId: requestedModel, providerId };
    }
    const targetProvider = this.modelRegistry.getProvider(status.providerId);
    if (!targetProvider) {
      return { modelId: requestedModel, providerId };
    }
    return { modelId: recent.modelId, providerId: targetProvider.id };
  }

  private buildToolBridgeMaps(parsed: CodexParsedRequest): {
    toolNsMap: Map<string, { namespace: string; name: string }>;
    freeformToolNames: Set<string>;
    toolSearchToolNames: Set<string>;
  } {
    const toolNsMap = new Map<string, { namespace: string; name: string }>();
    const freeformToolNames = new Set<string>();
    const toolSearchToolNames = new Set<string>();
    for (const tool of parsed.context.tools ?? []) {
      if (tool.namespace) {
        toolNsMap.set(namespacedToolName(tool.namespace, tool.name), {
          namespace: tool.namespace,
          name: tool.name,
        });
      }
      if (tool.freeform) freeformToolNames.add(tool.name);
      if (tool.toolSearch) toolSearchToolNames.add(tool.name);
    }
    return { toolNsMap, freeformToolNames, toolSearchToolNames };
  }
}
