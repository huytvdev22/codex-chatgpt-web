export type M365ProtocolErrorCode =
  | "MISSING_RESPONSE_ENVELOPE"
  | "MULTIPLE_RESPONSE_ENVELOPES"
  | "EMPTY_RESPONSE"
  | "FORBIDDEN_THOUGHT_BLOCK"
  | "MIXED_TOOL_AND_TEXT_CONTENT"
  | "INCOMPLETE_TOOL_CALL"
  | "INVALID_TOOL_JSON"
  | "INVALID_TOOL_SHAPE"
  | "INVALID_TOOL_CALL"
  | "INCOMPLETE_PATCH_CALL"
  | "INVALID_PATCH_ENVELOPE";

export interface StrictM365ToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type StrictM365ResponseResult =
  | {
    kind: "final_answer";
    content: string;
    rawResponse: string;
  }
  | {
    kind: "tool_calls";
    calls: StrictM365ToolCall[];
    rawResponse: string;
  }
  | {
    kind: "protocol_error";
    code: M365ProtocolErrorCode;
    message: string;
    rawResponse: string;
  };

const ROOT_OPEN = "<m365Response>";
const ROOT_CLOSE = "</m365Response>";
const TOOL_OPEN = "<tool_call>";
const TOOL_CLOSE = "</tool_call>";
const PATCH_OPEN = '<custom_tool_call name="apply_patch">';
const PATCH_CLOSE = "</custom_tool_call>";

function isApplyPatchToolName(name: string): boolean {
  const shortName = name.startsWith("functions.") ? name.slice("functions.".length) : name;
  return shortName === "apply_patch" || shortName === "applypatch";
}

function hasCompletePatchEnvelope(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const lines = value.trim().split(/\r?\n/);
  if (lines[0] !== "*** Begin Patch" || lines[lines.length - 1] !== "*** End Patch") {
    return false;
  }
  return !lines.slice(1, -1).some(line => line === "*** Begin Patch" || line === "*** End Patch");
}

function protocolError(
  rawResponse: string,
  code: M365ProtocolErrorCode,
  message: string
): StrictM365ResponseResult {
  return { kind: "protocol_error", code, message, rawResponse };
}

/**
 * Bóc duy nhất transport wrapper 4-backtick khi DOM scraper chưa bóc wrapper này.
 * Không đụng tới bất kỳ code fence Markdown nào nằm bên trong response envelope.
 */
function unwrapTransportFence(rawResponse: string): string {
  const trimmed = rawResponse.trim();
  const match = trimmed.match(/^````markdown[ \t]*\r?\n([\s\S]*)\r?\n````$/);
  return match ? match[1].trim() : trimmed;
}

function hasReservedControlMarker(content: string): boolean {
  return /<\/?(?:tool_call|custom_tool_call|thought|thinking)\b/i.test(content)
    || /\*{3}\s*(?:Begin|End) Patch/i.test(content);
}

function parseFunctionToolCall(
  payload: string,
  rawResponse: string
): StrictM365ToolCall | StrictM365ResponseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.trim());
  } catch {
    return protocolError(
      rawResponse,
      "INVALID_TOOL_JSON",
      "Nội dung <tool_call> phải là JSON hoàn chỉnh và hợp lệ; parser không tự sửa JSON bị cắt hoặc sai escape."
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return protocolError(rawResponse, "INVALID_TOOL_SHAPE", "Payload <tool_call> phải là một JSON object.");
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name.trim()) {
    return protocolError(rawResponse, "INVALID_TOOL_SHAPE", "Payload <tool_call> thiếu trường name hợp lệ.");
  }
  if (!record.arguments || typeof record.arguments !== "object" || Array.isArray(record.arguments)) {
    return protocolError(rawResponse, "INVALID_TOOL_SHAPE", "Payload <tool_call> thiếu arguments JSON object hợp lệ.");
  }

  const args = record.arguments as Record<string, unknown>;
  if (isApplyPatchToolName(record.name)) {
    const patch = args.input;
    if (!hasCompletePatchEnvelope(patch)) {
      return protocolError(
        rawResponse,
        "INVALID_PATCH_ENVELOPE",
        "apply_patch trong <tool_call> cũng phải chứa input hoàn chỉnh từ *** Begin Patch đến *** End Patch."
      );
    }
  }

  return {
    ...(typeof record.id === "string" && record.id ? { id: record.id } : {}),
    name: record.name,
    arguments: args,
  };
}

function parsePatchToolCall(
  payload: string,
  rawResponse: string
): StrictM365ToolCall | StrictM365ResponseResult {
  const patch = payload.trim();
  if (!hasCompletePatchEnvelope(patch)) {
    return protocolError(
      rawResponse,
      "INVALID_PATCH_ENVELOPE",
      "apply_patch phải chứa nguyên vẹn *** Begin Patch ... *** End Patch; parser không tự đóng patch bị cắt."
    );
  }
  return { name: "apply_patch", arguments: { input: patch } };
}

/**
 * Parser fail-closed cho response M365.
 *
 * Đây là framed protocol parser, không phải XML DOM parser tổng quát: phần final answer là Markdown
 * opaque và có thể chứa HTML/code không hợp lệ theo XML. Parser chỉ diễn giải các control frame
 * chính xác; nội dung Markdown không bao giờ được quét để suy đoán shell/JSON tool call.
 */
export function parseStrictM365Response(rawResponse: string): StrictM365ResponseResult {
  const framed = unwrapTransportFence(rawResponse);
  if (!framed.startsWith(ROOT_OPEN) || !framed.endsWith(ROOT_CLOSE)) {
    return protocolError(
      rawResponse,
      "MISSING_RESPONSE_ENVELOPE",
      `Phản hồi phải được bọc chính xác bởi ${ROOT_OPEN} ... ${ROOT_CLOSE}.`
    );
  }

  const inner = framed.slice(ROOT_OPEN.length, framed.length - ROOT_CLOSE.length);
  if (inner.includes(ROOT_OPEN) || inner.includes(ROOT_CLOSE)) {
    return protocolError(rawResponse, "MULTIPLE_RESPONSE_ENVELOPES", "Mỗi lượt chỉ được chứa đúng một m365Response envelope.");
  }

  const content = inner.trim();
  if (!content) {
    return protocolError(rawResponse, "EMPTY_RESPONSE", "m365Response không được rỗng.");
  }
  if (/<\/?(?:thought|thinking)\b/i.test(content)) {
    return protocolError(rawResponse, "FORBIDDEN_THOUGHT_BLOCK", "Không được xuất thought/thinking trong response protocol.");
  }

  const calls: StrictM365ToolCall[] = [];
  let offset = 0;
  let sawToolFrame = false;

  while (offset < content.length) {
    const whitespace = content.slice(offset).match(/^\s*/)?.[0] ?? "";
    offset += whitespace.length;
    if (offset >= content.length) break;

    if (content.startsWith(TOOL_OPEN, offset)) {
      sawToolFrame = true;
      const payloadStart = offset + TOOL_OPEN.length;
      const closeIndex = content.indexOf(TOOL_CLOSE, payloadStart);
      if (closeIndex < 0) {
        return protocolError(rawResponse, "INCOMPLETE_TOOL_CALL", "Phát hiện <tool_call> chưa có </tool_call>; hủy toàn bộ atomic batch.");
      }
      const parsed = parseFunctionToolCall(content.slice(payloadStart, closeIndex), rawResponse);
      if ("kind" in parsed) return parsed;
      calls.push(parsed);
      offset = closeIndex + TOOL_CLOSE.length;
      continue;
    }

    if (content.startsWith(PATCH_OPEN, offset)) {
      sawToolFrame = true;
      const payloadStart = offset + PATCH_OPEN.length;
      const closeIndex = content.indexOf(PATCH_CLOSE, payloadStart);
      if (closeIndex < 0) {
        return protocolError(rawResponse, "INCOMPLETE_PATCH_CALL", "Phát hiện apply_patch chưa có </custom_tool_call>; hủy toàn bộ atomic batch.");
      }
      const parsed = parsePatchToolCall(content.slice(payloadStart, closeIndex), rawResponse);
      if ("kind" in parsed) return parsed;
      calls.push(parsed);
      offset = closeIndex + PATCH_CLOSE.length;
      continue;
    }

    if (sawToolFrame || hasReservedControlMarker(content.slice(offset))) {
      return protocolError(
        rawResponse,
        "MIXED_TOOL_AND_TEXT_CONTENT",
        "Response chứa tool syntax lẫn văn bản hoặc control frame không đúng chuẩn; hủy toàn bộ atomic batch."
      );
    }

    return { kind: "final_answer", content, rawResponse };
  }

  if (calls.length > 0) {
    return { kind: "tool_calls", calls, rawResponse };
  }
  return { kind: "final_answer", content, rawResponse };
}

export {
  ROOT_OPEN as M365_RESPONSE_OPEN_TAG,
  ROOT_CLOSE as M365_RESPONSE_CLOSE_TAG,
};
