import type { CodexRawRequestWire } from "./codex-raw-payload";

/**
 * Định danh chuẩn của công cụ, bảo toàn cả namespace và short name.
 */
export interface NormalizedToolIdentity {
  namespace?: string;
  name: string;
  qualifiedName: string;
}

/**
 * Công cụ kiểu function tiêu chuẩn (có raw JSON Schema parameters).
 * Lưu ý: rawParameters được bảo toàn đầy đủ để phục vụ cho ToolCallValidator,
 * không tự ý chuyển đổi hoặc thu gọn ở tầng canonical này.
 */
export interface NormalizedFunctionTool {
  kind: "function";
  identity: NormalizedToolIdentity;
  description: string;
  strict?: boolean;
  rawParameters: Record<string, unknown>;
}

/**
 * Công cụ tùy chỉnh (ví dụ apply_patch với freeform grammar).
 */
export interface NormalizedCustomTool {
  kind: "custom";
  identity: NormalizedToolIdentity;
  description: string;
  format?: unknown;
}

export type NormalizedTool = NormalizedFunctionTool | NormalizedCustomTool;

/**
 * Kết quả thực thi công cụ ở cuối turn (Trailing Tool Result).
 */
export interface NormalizedToolResult {
  callId: string;
  toolName?: string;
  kind?: "function" | "custom";
  output: string;
}

/**
 * Lượt trao đổi trong hội thoại đã được chuẩn hóa.
 */
export interface NormalizedTurn {
  id?: string;
  role: "user" | "assistant" | "developer" | "tool";
  content: string;
  isUserText?: boolean;
  callId?: string;
  toolName?: string;
}

/**
 * Chính sách thực thi (Execution Policy) từ client.
 */
export interface NormalizedExecutionPolicy {
  parallelToolCalls: boolean;
  toolChoice?: unknown;
}

/**
 * Đối tượng yêu cầu từ Codex đã được chuẩn hóa toàn diện (Canonical Boundary).
 * Đóng vai trò là đầu vào duy nhất cho các Prompt Builders và downstream adapters.
 */
export interface NormalizedCodexRequest {
  model: string;
  stream: boolean;
  threadId?: string;
  turnId?: string;
  systemInstructions?: string[];
  environmentContext?: string;
  developerInstructions?: string[];
  priorHistory: NormalizedTurn[];
  latestUserInstruction?: string;
  trailingToolResults: NormalizedToolResult[];
  tools: NormalizedTool[];
  activeCodingTools: NormalizedTool[];
  executionPolicy: NormalizedExecutionPolicy;
  collaborationMode: "default" | "plan";
  rawSnapshot: CodexRawRequestWire;
}

