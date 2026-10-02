// @ts-ignore - CommonJS policy file loaded dynamically
import policy from "../../launcher/electron/observability-policy.cjs";

export const {
  OBS_PREFIX_V1,
  OBS_PROTOCOL_VERSION,
  MAX_EVENT_PAYLOAD_BYTES,
  VALID_LEVELS,
  VALID_SOURCES,
  STRUCTURED_DETAIL_EXPORT_ALLOWLIST,
  EVENT_SAFE_DETAILS_ALLOWLIST,
  filterSafeDetailsForExport,
} = policy;

export type LogLevel = "debug" | "info" | "warning" | "error";
export type LogSource = "server" | "m365" | "bridge" | "browser";

/**
 * Ngữ cảnh Trace phân tán của lượt làm việc hiện tại (tương đương MDC trong Java).
 */
export interface TraceContext {
  /** Root Server-Owned Trace ID duy nhất cho toàn bộ turn (tr_...) */
  traceId: string;
  /** Root Span ID đại diện cho cả turn (span_root) */
  rootSpanId: string;
  /** Span ID hiện tại */
  spanId: string;
  /** Span ID cha trực tiếp */
  parentSpanId?: string;
  /** HTTP Request ID hiện tại */
  requestId: string;
  /** Thread / Conversation ID */
  conversationId?: string;
  /** Client turnId nếu Codex gửi trong metadata */
  clientTurnId?: string;
  /** Protocol link continuation từ Codex */
  previousResponseId?: string;
  /** Thứ tự gọi provider trong cùng turn (1, 2, ...) */
  providerCallIndex: number;
  /** Số vòng lặp thực thi tool */
  toolIteration: number;
}

/**
 * Dữ liệu chi tiết của Structured Event (không chứa level hoặc event).
 */
export interface StructuredLogDetail {
  id: string;
  timestamp: string;
  processInstanceId: string;
  sequence: number;
  source: LogSource;
  message: string;

  traceId: string;
  spanId: string;
  parentSpanId?: string;

  requestId: string;
  responseId?: string;
  previousResponseId?: string;
  conversationId?: string;
  clientTurnId?: string;
  toolCallId?: string;

  durationMs?: number;
  status?: "completed" | "failed" | "aborted" | "timeout";
  completionType?: "final_answer" | "early_conclude" | "loop_blocked" | "title_response" | "tool_call" | "aborted" | "error";
  stopReason?: "stop" | "tool_use" | "error";
  endTurn?: boolean;

  safeDetails: Record<string, unknown>;
}

/**
 * Envelope truyền qua stdout của daemon runtime.
 */
export interface StructuredLogEnvelope {
  version: 1;
  nonce: string;
  level: LogLevel;
  event: string;
  detail: StructuredLogDetail;
}

/**
 * Dữ liệu đầu vào cho emitter (safeDetails có thể undefined và sẽ được normalize).
 */
export interface EmitStructuredEventInput {
  level: LogLevel;
  event: string;
  message?: string;
  source?: LogSource;

  traceContext?: TraceContext;
  spanId?: string;
  parentSpanId?: string;
  responseId?: string;
  toolCallId?: string;

  durationMs?: number;
  status?: "completed" | "failed" | "aborted" | "timeout";
  completionType?: "final_answer" | "early_conclude" | "loop_blocked" | "title_response" | "tool_call" | "aborted" | "error";
  stopReason?: "stop" | "tool_use" | "error";
  endTurn?: boolean;

  safeDetails?: Record<string, unknown>;
  diagnosticDetails?: Record<string, unknown>;
}
