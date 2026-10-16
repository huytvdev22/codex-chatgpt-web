import type { AdapterEvent, CodexParsedRequest } from "../types";
import type { TraceContext } from "../observability/types";

/** Metadata about the caller's incoming request, for auth-forwarding adapters. */
export interface IncomingMeta {
  headers: Headers;
  abortSignal?: AbortSignal;
  traceContext?: TraceContext;
}

export interface ProviderAdapter {
  name: string;
  runTurn(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void,
  ): Promise<void>;
}

/**
 * Kiểm tra xem danh sách tin nhắn ngữ cảnh có thực sự chứa phản hồi có nội dung từ trợ lý (assistant) hay chưa.
 * Loại trừ hoàn toàn các placeholder rỗng ({ content: [] }), tin nhắn rỗng (""), hoặc thinking tạm thời.
 */
export function hasActualPriorAssistantReply(messages?: Array<any>): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  return messages.some((m) => {
    if (!m || m.role !== "assistant") return false;
    if (typeof m.content === "string") return m.content.trim().length > 0;
    if (Array.isArray(m.content)) {
      return m.content.some((p: any) => {
        if (!p) return false;
        if ((p.type === "text" || p.type === "output_text") && typeof p.text === "string" && p.text.trim().length > 0) {
          return true;
        }
        if (p.type === "toolCall") return true;
        return false;
      });
    }
    return false;
  });
}
