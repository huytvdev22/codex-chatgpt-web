import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes } from "node:crypto";
import type { TraceContext } from "./types";
import { extractCodexTurnIdentityFromBody } from "../adapters/chatgpt-web/environment";

/**
 * Định danh phiên tiến trình runtime hiện tại.
 * Thay đổi mỗi khi daemon restart.
 */
export const PROCESS_INSTANCE_ID = `proc_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;

let sequenceCounter = 0;

/**
 * Số thứ tự tự tăng, đơn điệu trong phạm vi processInstanceId hiện tại.
 */
export function nextSequence(): number {
  sequenceCounter += 1;
  return sequenceCounter;
}

/**
 * Khóa bí mật tiến trình dùng để hash HMAC các tool command ngắn (chống dictionary attack).
 * Lưu ý: Fingerprint HMAC này CHỈ ỔN ĐỊNH TRONG CÙNG processInstanceId,
 * không dùng để tương quan hay so khớp sau khi daemon restart.
 */
const PROCESS_HMAC_SECRET = randomBytes(32);

function stableSortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") {
      return value.replace(/\\/g, "/").trim();
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stableSortValue);
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = stableSortValue(obj[key]);
  }
  return sorted;
}

/**
 * Tạo fingerprint an toàn cho lệnh/công cụ sử dụng HMAC.
 * Tự động sắp xếp key để bảo đảm deterministic bất kể thứ tự trường.
 */
export function secureToolFingerprint(toolName: string, args: unknown): string {
  try {
    let parsed = args;
    if (typeof args === "string") {
      try {
        parsed = JSON.parse(args);
      } catch {
        parsed = args.trim();
      }
    }
    const normalized = stableSortValue(parsed);
    const raw = JSON.stringify(normalized);
    return createHmac("sha256", PROCESS_HMAC_SECRET)
      .update(`${toolName.trim()}:${raw}`)
      .digest("hex")
      .slice(0, 16);
  } catch {
    return createHmac("sha256", PROCESS_HMAC_SECRET)
      .update(toolName.trim())
      .digest("hex")
      .slice(0, 16);
  }
}

/**
 * AsyncLocalStorage lưu trữ TraceContext xuyên suốt luồng bất đồng bộ của request.
 */
export const traceStorage = new AsyncLocalStorage<TraceContext>();

/**
 * Lấy TraceContext hiện tại từ AsyncLocalStorage (nếu có).
 */
export function currentTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

/**
 * Sinh ID cho Trace mới do Server sở hữu.
 */
export function generateServerTraceId(): string {
  return `tr_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

/**
 * Sinh ID cho Span mới theo quy ước phân cấp.
 */
export function createSpanId(kind: "http" | "prov" | "tool" | "sse" | "root" = "http"): string {
  return `span_${kind}_${randomBytes(4).toString("hex")}`;
}

export const generateSpanId = createSpanId;

export interface StoredResponseTraceState {
  traceId?: string;
  rootSpanId?: string;
  turnId?: string;
  conversationId?: string;
  providerCallIndex?: number;
  toolIteration?: number;
}

export interface ResolveTraceContextParams {
  rawBody: unknown;
  headers: Headers;
  requestId: string;
  previousResponseId?: string;
  cachedTraceState?: StoredResponseTraceState;
}

export interface ResolvedTraceResult {
  context: TraceContext;
  isContinuation: boolean;
  correlationRecovered: boolean;
}

/**
 * Phân giải hoặc phục hồi TraceContext cho request ingress.
 * Đảm bảo: traceId LUÔN do Server sinh và sở hữu.
 * HTTP span hiện tại luôn là con trực tiếp của rootSpanId.
 */
export function resolveTraceContext(params: ResolveTraceContextParams): ResolvedTraceResult {
  const { rawBody, headers, requestId, previousResponseId, cachedTraceState } = params;

  // Trích xuất metadata từ Codex (nếu có)
  const identity = extractCodexTurnIdentityFromBody(rawBody);
  const clientTurnId = identity.turnId;
  const conversationHeader = headers.get("x-codex-conversation-key")?.trim() || undefined;
  const threadId = identity.threadId?.trim() || undefined;

  // Trường hợp 1: Request là Continuation (có previous_response_id)
  if (previousResponseId) {
    if (cachedTraceState?.traceId && cachedTraceState?.rootSpanId) {
      const traceId = cachedTraceState.traceId;
      const rootSpanId = cachedTraceState.rootSpanId;
      const conversationId = threadId ?? conversationHeader ?? cachedTraceState.conversationId ?? `anon_${traceId}`;
      const providerCallIndex = (cachedTraceState.providerCallIndex ?? 1) + 1;
      const toolIteration = cachedTraceState.toolIteration ?? 0;

      const httpSpanId = createSpanId("http");
      const context: TraceContext = {
        traceId,
        rootSpanId,
        spanId: httpSpanId,
        parentSpanId: rootSpanId,
        requestId,
        conversationId,
        clientTurnId: clientTurnId ?? cachedTraceState.turnId,
        previousResponseId,
        providerCallIndex,
        toolIteration,
      };

      return {
        context,
        isContinuation: true,
        correlationRecovered: true,
      };
    }

    // Không tìm thấy trong cache (cache miss hoặc legacy state):
    // Tự sinh trace mới, đánh dấu correlationRecovered = false
    const traceId = `tr_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
    const rootSpanId = createSpanId("root");
    const httpSpanId = createSpanId("http");
    const conversationId = threadId ?? conversationHeader ?? `anon_${traceId}`;

    const context: TraceContext = {
      traceId,
      rootSpanId,
      spanId: httpSpanId,
      parentSpanId: rootSpanId,
      requestId,
      conversationId,
      clientTurnId,
      previousResponseId,
      providerCallIndex: 2,
      toolIteration: 0,
    };

    return {
      context,
      isContinuation: true,
      correlationRecovered: false,
    };
  }

  // Trường hợp 2: Turn mới hoàn toàn (Request khởi đầu)
  const traceId = `tr_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  const rootSpanId = createSpanId("root");
  const httpSpanId = createSpanId("http");
  const conversationId = threadId ?? conversationHeader ?? `anon_${traceId}`;

  const context: TraceContext = {
    traceId,
    rootSpanId,
    spanId: httpSpanId,
    parentSpanId: rootSpanId,
    requestId,
    conversationId,
    clientTurnId,
    providerCallIndex: 1,
    toolIteration: 0,
  };

  return {
    context,
    isContinuation: false,
    correlationRecovered: true,
  };
}
