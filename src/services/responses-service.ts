import { createHash } from "node:crypto";
import { AdapterRegistry, type ProviderAdapterFactory } from "../adapters/adapter-registry";
import { extractCodexTurnIdentityFromBody } from "../responses/turn-identity";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "../bridge";
import { AsyncEventQueue } from "../event-queue";
import type { BaseModelProvider } from "../models/base-model-provider";
import { ModelRegistry } from "../models/model-registry";
import { parseRequest } from "../responses/parser";
import { expandPreviousResponseInput, rememberResponseState } from "../responses/state";
import { namespacedToolName, type AdapterEvent, type CodexParsedRequest } from "../types";
import type { NativeCodexTurnIdentity } from "../controllers/http-turn-counter";

export interface ResponseRequestOptions {
  /** DEV and other in-process harnesses can keep continuation state in their own canonical store. */
  rememberState?: boolean;
  /** Observe the exact production adapter stream when invoking the handler in-process. */
  onAdapterEvent?: (event: AdapterEvent) => void;
  /** Bind the physical HTTP stream to the exact native Codex turn that owns it. */
  onTurnIdentity?: (identity: NativeCodexTurnIdentity) => void;
}

export type ProviderResolutionResult =
  | { ok: true; provider: BaseModelProvider; requestedModel: string }
  | { ok: false; message: string };

/**
 * Tầng nghiệp vụ điều phối các lượt `/v1/responses` và `/v1/responses/compact`:
 * phân giải model qua `ModelRegistry`, khởi tạo `ProviderAdapter` qua `AdapterRegistry`,
 * chạy turn và chuyển đổi sự kiện sang SSE hoặc JSON Responses API.
 */
export class ResponsesService {
  constructor(
    private readonly modelRegistry: ModelRegistry = ModelRegistry.getInstance(),
    private readonly adapterRegistry: AdapterRegistry = AdapterRegistry.getInstance(),
  ) {}

  /**
   * Tìm `BaseModelProvider` sở hữu `requestedModel`; trả thông báo lỗi động theo các provider đang bật.
   */
  public resolveProvider(requestedModel: unknown): ProviderResolutionResult {
    if (typeof requestedModel !== "string" || requestedModel.trim().length === 0) {
      return { ok: false, message: "Missing or invalid model parameter" };
    }

    const provider = this.modelRegistry.findProvider(requestedModel);
    if (provider) {
      return { ok: true, provider, requestedModel };
    }

    const enabledProviders = this.modelRegistry.listProviders().map(item => item.id);
    const suffix = enabledProviders.length > 0
      ? `Enabled providers: ${enabledProviders.join(", ")}.`
      : "No model providers are enabled.";
    return {
      ok: false,
      message: `Unsupported model '${requestedModel}'. ${suffix}`,
    };
  }

  /**
   * Trích xuất và gắn `NativeCodexTurnIdentity` (nếu payload có đủ `threadId` và `turnId`).
   */
  public bindTurnIdentity(raw: unknown, options: ResponseRequestOptions): void {
    const identity = extractCodexTurnIdentityFromBody(raw);
    if (identity.threadId && identity.turnId) {
      options.onTurnIdentity?.({ threadId: identity.threadId, turnId: identity.turnId });
    }
  }

  /**
   * Chuẩn hóa payload & headers cho yêu cầu `/v1/responses/compact` trước khi chuyển tiếp vào luồng responses.
   */
  public prepareCompactionRequest(
    req: Request,
    raw: Record<string, unknown>,
  ): { request: Request; payload: Record<string, unknown> } {
    let payload = raw;
    const headerTurnMetadata = req.headers.get("x-codex-turn-metadata");
    if (headerTurnMetadata) {
      const existingMetadata = raw.client_metadata;
      const clientMetadata = existingMetadata && typeof existingMetadata === "object" && !Array.isArray(existingMetadata)
        ? existingMetadata as Record<string, unknown>
        : {};
      payload = {
        ...raw,
        client_metadata: {
          ...clientMetadata,
          // `/responses/compact` carries native turn authority in this canonical Codex header,
          // unlike ordinary `/responses` payloads where the same value also appears in the body.
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

    const request = new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify(compactionPayload),
      signal: req.signal,
    });

    return { request, payload: compactionPayload };
  }

  /**
   * Thực thi một lượt Responses API hoàn chỉnh cho bất kỳ `ProviderAdapter` nào.
   */
  public async executeTurn(params: {
    req: Request;
    raw: unknown;
    requestedModel: string;
    providerId: string;
    options?: ResponseRequestOptions;
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

    const requestedPreviousResponseId = raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as { previous_response_id?: unknown }).previous_response_id
      : undefined;
    const rawObj = (raw && typeof raw === "object" && !Array.isArray(raw))
      ? (raw as Record<string, unknown>)
      : {};
    const requestId = typeof rawObj.id === "string"
      ? rawObj.id
      : `req_${createHash("sha256").update(JSON.stringify(raw)).digest("hex").slice(0, 12)}`;

    const expanded = expandPreviousResponseInput(raw);
    if (typeof requestedPreviousResponseId === "string" && expanded === raw) {
      return formatErrorResponse(
        409,
        "invalid_request_error",
        `Local continuation state for previous_response_id is unavailable; refusing to run provider '${providerId}' with partial Codex context. Compact the Codex task or start a new task before retrying.`,
      );
    }

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
    const conversationId = identity.threadId || (req.headers.get("x-codex-conversation-key") ?? "default");
    const turnTag = `[${providerId}-turn]`;
    const streamTag = `[${providerId}-stream]`;

    console.log(`${turnTag} [start] requestId=${requestId} conversationId=${conversationId} turnId=${identity.turnId ?? "none"} model=${requestedModel}`);

    const adapter = adapterFactory
      ? adapterFactory()
      : this.adapterRegistry.createAdapter(providerId);
    const queue = new AsyncEventQueue<AdapterEvent>();
    const abort = new AbortController();
    if (req.signal.aborted) abort.abort();
    else req.signal.addEventListener("abort", () => abort.abort(), { once: true });

    const run = async () => {
      console.log(`${turnTag} [busy] requestId=${requestId} conversationId=${conversationId} queueSize=${queue.size()}`);
      try {
        await adapter.runTurn(parsed, { headers: req.headers, abortSignal: abort.signal }, event => {
          options.onAdapterEvent?.(event);
          queue.push(event);
        });
        console.log(`${turnTag} [completed] requestId=${requestId} conversationId=${conversationId} queueSize=${queue.size()}`);
      } catch (error) {
        console.error(`${turnTag} [error] requestId=${requestId} conversationId=${conversationId} error=${error instanceof Error ? error.message : String(error)}`);
        const event: AdapterEvent = { type: "error", message: error instanceof Error ? error.message : String(error) };
        options.onAdapterEvent?.(event);
        queue.push(event);
      } finally {
        queue.close();
        console.log(`${turnTag} [idle] requestId=${requestId} conversationId=${conversationId} queueSize=${queue.size()} closed=true`);
      }
    };

    const maps = this.buildToolBridgeMaps(parsed);
    const rememberCompletedResponse = (response: Record<string, unknown>): void => {
      if (options.rememberState !== false) {
        rememberResponseState(parsed._rawBody, response, { force: true });
      }
    };

    if (parsed.stream) {
      console.log(`${streamTag} [open] requestId=${requestId} conversationId=${conversationId}`);
      void run();
      const stream = bridgeToResponsesSSE(
        queue,
        requestedModel,
        maps.toolNsMap,
        maps.freeformToolNames,
        maps.toolSearchToolNames,
        () => {
          console.log(`${streamTag} [abort] requestId=${requestId} conversationId=${conversationId}`);
          abort.abort();
        },
        2_000,
        {
          hideThinkingSummary: parsed.options.hideThinkingSummary,
          onCompletedResponse: rememberCompletedResponse,
          onTerminal: status => {
            console.log(`${streamTag} [terminal] requestId=${requestId} conversationId=${conversationId} status=${status}`);
          },
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
    });
    rememberCompletedResponse(json);
    return Response.json(json);
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
