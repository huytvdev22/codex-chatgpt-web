import { logFunctionInput } from "../debug-logger";
import type { CodexParsedRequest } from "../../../types";
import { CodexRawPayload } from "../codex-raw-payload";
import { CodexPayloadNormalizer } from "../codex-normalizer";
import {
  promptCompiler,
  logPromptMetrics,
  logPromptAudit,
  isImplementingPlanRequest,
  truncateToolResult,
  renderDynamicToolDeclarations,
  UNIFIED_TOOL_PROTOCOL,
  MINIMAL_TOOL_PROTOCOL,
  type PromptCompileResult,
  type PromptSectionMetrics,
  type PromptAuditData,
} from "../prompt-strategy";

export { isImplementingPlanRequest, truncateToolResult };

/**
 * Kiểm tra xem yêu cầu hiện tại có đang ở chế độ Plan Mode (/plan) hay không.
 * Single Source of Truth: Dựa vào detectCollaborationMode của CodexPayloadNormalizer.
 * TUYỆT ĐỐI KHÔNG coi sự xuất hiện của tool request_user_input là Plan Mode!
 */
export function isPlanModeRequest(parsed: CodexParsedRequest): boolean {
  logFunctionInput("temp-chat:compileHybridForwardPrompt", "isPlanModeRequest", { parsed });
  if (isImplementingPlanRequest(parsed)) return false;
  const payload = CodexRawPayload.from(parsed._rawBody || parsed);
  return CodexPayloadNormalizer.detectCollaborationMode(payload) === "plan";
}

/**
 * Xây dựng Prompt chuyển tiếp cho chế độ Temporary Chat Per Request.
 * Sử dụng M365PromptCompiler duy nhất:
 * - Loại bỏ hoàn toàn mâu thuẫn Plan Mode / Default Mode
 * - Rút gọn mạnh permissions + sandbox instructions
 * - Thống nhất format tool duy nhất và render dynamic tools
 * - Ghi nhận log: planMode, collaborationMode, finalPromptLength
 */
export function compileM365HybridForwardPrompt(
  parsed: CodexParsedRequest,
  rawBody?: unknown
): string {
  logFunctionInput("temp-chat:compileHybridForwardPrompt", "compileM365HybridForwardPrompt", { parsed, rawBody });
  const result = compileM365HybridForwardPromptWithResult(parsed, rawBody);
  return result.finalPrompt;
}

/**
 * Phiên bản mở rộng trả về đầy đủ finalPrompt, metrics và audit data.
 */
export function compileM365HybridForwardPromptWithResult(
  parsed: CodexParsedRequest,
  rawBody?: unknown
): PromptCompileResult {
  logFunctionInput("temp-chat:compileHybridForwardPrompt", "compileM365HybridForwardPromptWithResult", { parsed, rawBody });
  const payload = CodexRawPayload.from(rawBody || parsed._rawBody || parsed);
  const normalized = CodexPayloadNormalizer.normalize(payload);

  const result = promptCompiler.compile({
    normalized,
    parsed,
  });

  // Ghi nhận log metrics và audit
  logPromptMetrics(result.metrics);
  logPromptAudit(result.audit);

  return result;
}

export {
  renderDynamicToolDeclarations,
  UNIFIED_TOOL_PROTOCOL,
  MINIMAL_TOOL_PROTOCOL,
  promptCompiler,
  logPromptMetrics,
  logPromptAudit,
  type PromptSectionMetrics,
  type PromptAuditData,
  type PromptCompileResult,
};
