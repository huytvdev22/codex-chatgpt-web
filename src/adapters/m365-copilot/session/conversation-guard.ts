import { logFunctionInput } from "../debug-logger";
import type { CodexMessage } from "../../../types";
import type { ConversationGuardState } from "./conversation-state";

export const MAX_TOOL_ITERATIONS = 100;
export const MAX_IDENTICAL_TOOL_CALLS = 10;
export const MAX_IDENTICAL_READ_TOOL_CALLS = 20;
export const MAX_IDENTICAL_WRITE_TOOL_CALLS = 6;
export const GUARD_TTL_MS = 15 * 60 * 1000; // 15 phút

export const READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_dir",
  "grep_code",
  "git_status",
  "git_diff",
  "view_file",
  "grep_search",
  "read_url_content",
]);

/**
 * Kiểm tra xem công cụ có phải là read-only (chỉ đọc, không làm thay đổi trạng thái file system / process) hay không.
 */
export function isReadOnlyTool(name?: string): boolean {
  if (!name || typeof name !== "string") return false;
  return READ_ONLY_TOOLS.has(name.trim().toLowerCase());
}

/**
 * Lấy giới hạn số lần lặp liên tiếp tối đa cho phép dựa trên loại công cụ (Read vs Write).
 */
export function getMaxIdenticalToolCalls(name?: string): number {
  return isReadOnlyTool(name) ? MAX_IDENTICAL_READ_TOOL_CALLS : MAX_IDENTICAL_WRITE_TOOL_CALLS;
}

export const conversationGuard = new Map<string, ConversationGuardState>();

/**
 * Thực hiện xử lý cleanExpiredConversationGuards cho quy trình M365 Copilot Adapter.
 */
export function cleanExpiredConversationGuards(now = Date.now()): void {
  logFunctionInput("session:conversation-guard", "cleanExpiredConversationGuards", { now });
  for (const [key, state] of conversationGuard.entries()) {
    if (now - state.updatedAt > GUARD_TTL_MS) {
      conversationGuard.delete(key);
    }
  }
  if (conversationGuard.size > 1000) {
    const entries = [...conversationGuard.entries()]
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (let i = 0; i < Math.min(200, entries.length); i++) {
      conversationGuard.delete(entries[i][0]);
    }
  }
}

/**
 * Thực hiện xử lý stableSortValue cho quy trình M365 Copilot Adapter.
 */
export function stableSortValue(value: unknown): unknown {
  logFunctionInput("session:conversation-guard", "stableSortValue", { value });
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
 * Thực hiện xử lý stableToolFingerprint cho quy trình M365 Copilot Adapter.
 */
export function stableToolFingerprint(name: string, rawArgs: unknown): string {
  logFunctionInput("session:conversation-guard", "stableToolFingerprint", { name, rawArgs });
  let parsedArgs = rawArgs;
  if (typeof rawArgs === "string") {
    try {
      parsedArgs = JSON.parse(rawArgs);
    } catch {
      parsedArgs = rawArgs.trim();
    }
  }
  const normalized = stableSortValue(parsedArgs);
  return `${name.trim()}:${JSON.stringify(normalized)}`;
}

/**
 * Thực hiện xử lý isToolCallPart cho quy trình M365 Copilot Adapter.
 */
export function isToolCallPart(part: unknown): boolean {
  logFunctionInput("session:conversation-guard", "isToolCallPart", { part });
  if (!part || typeof part !== "object") return false;
  const p = part as Record<string, unknown>;
  const typeStr = typeof p.type === "string" ? p.type.toLowerCase() : "";
  return (
    typeStr === "toolcall" ||
    typeStr === "tool_call" ||
    typeStr === "function_call" ||
    typeStr === "functioncall" ||
    typeStr === "custom_tool_call" ||
    typeStr === "tool_search_call" ||
    p.call_id !== undefined ||
    p.callId !== undefined ||
    p.function !== undefined
  );
}

/**
 * Thực hiện xử lý isAssistantFinalAnswer cho quy trình M365 Copilot Adapter.
 */
export function isAssistantFinalAnswer(msg: CodexMessage | undefined): boolean {
  logFunctionInput("session:conversation-guard", "isAssistantFinalAnswer", { msg });
  if (!msg || msg.role !== "assistant") return false;

  // 1. Nếu content là string: Kiểm tra xem có chứa XML tool_call serialize không
  if (typeof msg.content === "string") {
    if (/<tool[\\_]*call>/i.test(msg.content)) {
      return false;
    }
    return true;
  }

  // 2. Nếu content là structured parts: Kiểm tra toàn bộ schema biến thể của tool call
  if (Array.isArray(msg.content)) {
    const hasToolCall = msg.content.some(isToolCallPart);
    return !hasToolCall;
  }

  return true;
}
