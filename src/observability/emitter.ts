import { randomUUID } from "node:crypto";
import {
  MAX_EVENT_PAYLOAD_BYTES,
  OBS_PREFIX_V1,
  OBS_PROTOCOL_VERSION,
  VALID_LEVELS,
  type LogLevel,
  type EmitStructuredEventInput,
  type StructuredLogDetail,
  type StructuredLogEnvelope,
} from "./types";
import {
  currentTraceContext,
  nextSequence,
  PROCESS_INSTANCE_ID,
} from "./trace-context";

/**
 * Kiểm tra xem tính năng Structured Observability có được kích hoạt hay không.
 * Phase 2: MẶC ĐỊNH LÀ BẬT (ON). Chỉ tắt nếu người dùng cấu hình rõ ràng là "0".
 */
export function isStructuredObservabilityEnabled(): boolean {
  return process.env.CODEX_STRUCTURED_OBSERVABILITY !== "0";
}

/**
 * Lấy Nonce bảo mật của tiến trình hiện tại từ biến môi trường.
 */
function getProcessNonce(): string {
  return process.env.CODEX_OBSERVABILITY_NONCE || "";
}

/**
 * Phát một Structured Log Event ra stdout theo đúng chuẩn protocol @@CODEX_OBSERVABILITY_V1@@.
 * Không throw lỗi ra ngoài để bảo đảm runtime luôn an toàn tuyệt đối.
 */
export function emitStructuredEvent(input: EmitStructuredEventInput): void {
  if (!isStructuredObservabilityEnabled()) {
    return;
  }

  try {
    const context = input.traceContext || currentTraceContext();
    const traceId = context?.traceId || `tr_orphan_${Date.now().toString(36)}`;
    const spanId = input.spanId || context?.spanId || `span_orphan_${Date.now().toString(36)}`;
    const parentSpanId = input.parentSpanId ?? context?.parentSpanId;
    const requestId = context?.requestId || "req_unknown";

    // Chuẩn hóa level hợp lệ
    const level: LogLevel = VALID_LEVELS.includes(input.level) ? input.level : "info";

    // Chuẩn hóa safeDetails thành object sạch (không chứa undefined)
    const rawSafeDetails = input.safeDetails && typeof input.safeDetails === "object" && !Array.isArray(input.safeDetails)
      ? { ...input.safeDetails }
      : {};

    const detail: StructuredLogDetail = {
      id: `evt_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      timestamp: new Date().toISOString(),
      processInstanceId: PROCESS_INSTANCE_ID,
      sequence: nextSequence(),
      source: input.source || "server",
      message: input.message || input.event,

      traceId,
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),

      requestId,
      ...(input.responseId ? { responseId: input.responseId } : {}),
      ...(context?.previousResponseId ? { previousResponseId: context.previousResponseId } : {}),
      ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
      ...(context?.clientTurnId ? { clientTurnId: context.clientTurnId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),

      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.completionType ? { completionType: input.completionType } : {}),
      ...(input.stopReason ? { stopReason: input.stopReason } : {}),
      ...(input.endTurn !== undefined ? { endTurn: input.endTurn } : {}),

      safeDetails: rawSafeDetails,
    };

    const envelope: StructuredLogEnvelope = {
      version: OBS_PROTOCOL_VERSION,
      nonce: getProcessNonce(),
      level,
      event: input.event,
      detail,
    };

    // Kiểm tra kích thước an toàn trước khi in ra stdout
    let serialized = JSON.stringify(envelope);
    if (Buffer.byteLength(serialized, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
      // Nếu payload vượt quá 64KB, lược bớt safeDetails và thêm cảnh báo truncated
      envelope.detail.safeDetails = {
        _warning: "payload_exceeded_size_limit",
        _truncated: true,
      };
      serialized = JSON.stringify(envelope);
    }

    process.stdout.write(`${OBS_PREFIX_V1}${serialized}\n`);
  } catch {
    // Không bao giờ để lỗi logging làm gián đoạn luồng xử lý chính của daemon
  }
}
