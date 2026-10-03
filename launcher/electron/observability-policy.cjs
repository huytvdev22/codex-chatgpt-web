"use strict";

const OBS_PREFIX_V1 = "@@CODEX_OBSERVABILITY_V1@@";
const OBS_PROTOCOL_VERSION = 1;
const MAX_EVENT_PAYLOAD_BYTES = 256 * 1024; // 256 KB
 
const VALID_LEVELS = Object.freeze(["debug", "info", "warning", "error"]);
const VALID_SOURCES = Object.freeze(["server", "m365", "bridge", "browser"]);

// Allowlist các trường cấp 1 của detail được phép xuất qua Safe Export
const STRUCTURED_DETAIL_EXPORT_ALLOWLIST = Object.freeze([
  "id",
  "timestamp",
  "processInstanceId",
  "sequence",
  "source",
  "message",
  "traceId",
  "spanId",
  "parentSpanId",
  "requestId",
  "responseId",
  "previousResponseId",
  "conversationId",
  "clientTurnId",
  "toolCallId",
  "durationMs",
  "status",
  "completionType",
  "stopReason",
  "endTurn",
  "safeDetails",
]);

// Allowlist các thuộc tính bên trong safeDetails theo từng sự kiện cụ thể
// Bất kỳ thuộc tính nào không nằm trong danh sách này sẽ bị loại bỏ hoàn toàn khi Safe Export
const EVENT_SAFE_DETAILS_ALLOWLIST = Object.freeze({
  "codex.request.received": Object.freeze(["method", "model", "stream", "hasPreviousResponse", "modelSlug", "promptPreview", "userMessage", "actualMessage", "rawMessages"]),
  "trace.context.resolved": Object.freeze(["isContinuation", "correlationRecovered", "providerCallIndex", "restoredFromResponseId"]),
  "codex.tool_result.received": Object.freeze(["toolCallId", "resultBytes", "isError", "previousResponseId", "output", "outputPreview"]),
  "m365.provider.started": Object.freeze(["provider", "modelSlug", "isNewConversation", "capabilityMode", "attempt", "injectedPromptPreview", "promptBytes", "rawPrompt"]),
  "m365.provider.progress": Object.freeze(["elapsedSeconds", "isGenerating", "outputChars", "stableSeconds", "hasUnclosedToolCall", "hasUnclosedPatch", "statusSummary", "domStatus"]),
  "m365.provider.finished": Object.freeze(["provider", "status", "durationMs", "outputChars", "totalChars", "errorType", "responsePreview", "rawResponse", "timedOut", "terminalReason", "terminalExplanation"]),
  "m365.tool.detected": Object.freeze(["toolName", "callId", "argKeys", "argBytes", "argHmac", "arguments"]),
  "m365.loop.updated": Object.freeze(["toolIterations", "identicalToolCount", "toolIteration", "identicalCount", "fingerprintHmac"]),
  "m365.loop.blocked": Object.freeze(["reason", "toolName", "identicalCount", "toolIterations", "limitType", "count", "blockedTool"]),
  "m365.turn.completed": Object.freeze(["completionType", "toolCount", "inputTokens", "outputTokens", "endTurn", "stopReason", "finalAnswer", "toolCalls", "terminalReason", "terminalExplanation", "parseDiagnostics"]),
  "bridge.sse.completed": Object.freeze(["emittedFrames", "terminalStatus", "durationMs", "outgoingItems"]),
});

/**
 * Lọc sạch safeDetails chỉ giữ lại các trường được khai báo trong allowlist của event đó.
 * Loại bỏ mọi trường lạ (như sourceCode, rawArguments, command, content, prompt, v.v.).
 */
function filterSafeDetailsForExport(eventName, safeDetails) {
  if (!safeDetails || typeof safeDetails !== "object" || Array.isArray(safeDetails)) {
    return {};
  }
  const allowedKeys = EVENT_SAFE_DETAILS_ALLOWLIST[eventName];
  if (!allowedKeys) {
    return {};
  }
  const filtered = {};
  for (const key of allowedKeys) {
    if (key in safeDetails && safeDetails[key] !== undefined) {
      filtered[key] = safeDetails[key];
    }
  }
  return filtered;
}

module.exports = {
  OBS_PREFIX_V1,
  OBS_PROTOCOL_VERSION,
  MAX_EVENT_PAYLOAD_BYTES,
  VALID_LEVELS,
  VALID_SOURCES,
  STRUCTURED_DETAIL_EXPORT_ALLOWLIST,
  EVENT_SAFE_DETAILS_ALLOWLIST,
  filterSafeDetailsForExport,
};
