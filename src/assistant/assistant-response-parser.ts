import {
  parseStrictWebResponse,
  type StrictWebToolCall,
} from "../adapters/web/protocol/strict-response-parser";
import type { AssistantParsedResponse } from "./types";

const RESERVED_CONTROL_MARKER_REGEX =
  /(?:<\/?\s*(?:webResponse|tool_call|custom_tool_call|thought|thinking)\b|\*{3}\s*(?:Begin|End) Patch)/i;

const EXECUTABLE_ACTION_MARKER_REGEX =
  /(?:<\/?\s*(?:tool_call|custom_tool_call)\b|\*{3}\s*(?:Begin|End) Patch)/i;

const TRAILING_CLOSE_NOISE_PATTERN = "(?:[ \\t]+[^\\r\\n`<>]{1,32})?[ \\t]*";

const FULL_TRANSPORT_FENCE_REGEX = new RegExp(
  `^(\`{3,4})(?:markdown|md|xml)?[ \\t]*\\r?\\n([\\s\\S]*)\\r?\\n\\1${TRAILING_CLOSE_NOISE_PATTERN}$`,
  "i",
);

const TRAILING_WEBRESPONSE_FENCE_REGEX = new RegExp(
  `(?:^|\\n)((\`{3,4})(?:markdown|md|xml)?[ \\t]*\\r?\\n[ \\t]*<webResponse\\b[\\s\\S]*<\\/\\s*webResponse\\s*>[ \\t]*\\r?\\n\\2${TRAILING_CLOSE_NOISE_PATTERN})$`,
  "i",
);

/**
 * Turndown (`webHtmlToMarkdown`) thường escape ký tự `_` và `*` thành `\_` / `\*`
 * khi AI xuất XML tool call ngoài code fence hoặc bị đọc từ DOM fallback.
 * Chuẩn hóa các thẻ điều khiển + prefix mở thẻ để Gate và Parser nhận diện chính xác.
 */
export function normalizeEscapedToolMarkers(text: string): string {
  if (!text || (!text.includes("\\_") && !text.includes("\\*"))) {
    return text;
  }
  return text
    .replace(/<(\/?)\s*tool(?:\\?_)+call\b([^>]*)>/gi, "<$1tool_call$2>")
    .replace(/<(\/?)\s*custom(?:\\?_)+tool(?:\\?_)+call\b([^>]*)>/gi, (_, slash: string, attrs: string) => {
      const cleanAttrs = attrs.replace(/\\_/g, "_");
      return `<${slash}custom_tool_call${cleanAttrs}>`;
    })
    .replace(/<(\/?)\s*tool(?:\\?_)+(?:c(?:a(?:l(?:l)?)?)?)?$/i, (m) => m.replace(/\\_/g, "_"))
    .replace(/<(\/?)\s*custom(?:\\?_)+(?:t(?:o(?:o(?:l(?:\\?_)+(?:c(?:a(?:l(?:l)?)?)?)?)?)?)?)?$/i, (m) =>
      m.replace(/\\_/g, "_"),
    )
    .replace(/(^|\n)([ \t]*)\\\*\\\*\\\*/g, "$1$2***");
}

function unescapeTurndownInsideToolTags(text: string): string {
  if (!text || (!text.includes("\\_") && !text.includes("\\*"))) {
    return text;
  }
  return text
    .replace(
      /<tool_call\b[^>]*>[\s\S]*?<\/\s*tool_call\s*>/gi,
      (block) => block.replace(/\\([_*])/g, "$1"),
    )
    .replace(
      /<custom_tool_call\b[^>]*>[\s\S]*?<\/\s*custom_tool_call\s*>/gi,
      (block) => block.replace(/\\([_*])/g, "$1"),
    );
}

/**
 * Tách duy nhất 1 khối transport fence ở ngoài cùng:
 * - Khối 4-backtick (` ````...```` `): coi là transport fence (giữ nguyên chuẩn cũ).
 *   Nếu dòng đóng fence bị dính nhãn thừa (vd. ` ```` Grok`), chỉ chấp nhận khi bên trong
 *   là cặp thẻ `<webResponse>...</webResponse>` hoàn chỉnh.
 * - Khối 3-backtick (` ```...``` `): CHỈ coi là transport fence khi bên trong bắt đầu bằng `<webResponse\b`
 *   và không bị đóng sớm trước dòng cuối cùng (tránh khớp gộp nhiều code block rời nhau).
 */
function extractOuterTransportFence(text: string): { fenceLen: 3 | 4; inner: string } | null {
  const match = FULL_TRANSPORT_FENCE_REGEX.exec(text);
  if (!match) return null;

  const fenceLen = match[1].length as 3 | 4;
  const rawInner = match[2];
  const innerTrimmed = rawInner.trim();
  const hasTrailingNoiseOnCloseLine = !match[0].endsWith(match[1]) && !/\r?\n[ \t]*$/.test(match[0].slice(match[0].lastIndexOf(match[1]) + match[1].length));
  const hasCompleteEnvelope = /^<webResponse\b[^>]*>[\s\S]*<\/\s*webResponse\s*>$/i.test(innerTrimmed);

  if (hasTrailingNoiseOnCloseLine && !hasCompleteEnvelope) {
    return null;
  }

  if (fenceLen === 4) {
    return { fenceLen, inner: innerTrimmed };
  }

  if (!/^<webResponse\b/i.test(innerTrimmed)) {
    return null;
  }

  // Bảo vệ trường hợp có >= 2 block 3-backtick tách rời mà block đầu tình cờ mở đầu bằng <webResponse>.
  if (hasUnbalancedClosingTripleFenceOutsidePatch(rawInner)) {
    return null;
  }

  return { fenceLen, inner: innerTrimmed };
}

function isProtectedTransportCodeBlock(fenceChar: string, fenceLen: number, innerText: string): boolean {
  if (fenceChar !== "`") return false;
  if (fenceLen >= 4) {
    return RESERVED_CONTROL_MARKER_REGEX.test(innerText);
  }
  if (fenceLen === 3) {
    return /^<webResponse\b/i.test(innerText.trim()) && EXECUTABLE_ACTION_MARKER_REGEX.test(innerText);
  }
  return false;
}

/**
 * Loại bỏ các code block minh họa thông thường và inline code để kiểm tra control marker,
 * nhưng GIỮ NGUYÊN các transport block (` ````...```` ` chứa marker hoặc ` ``` ` mở đầu bằng `<webResponse>`
 * chứa action) để không bao giờ hạ cấp nhầm lời gọi công cụ bị dính rác ngoài fence thành `final_answer`.
 */
function stripNonTransportCodeBlocks(text: string): string {
  const lines = text.split(/\r?\n/);
  const keptLines: string[] = [];
  let activeFence: { char: "`" | "~"; len: number; lines: string[] } | null = null;

  for (const line of lines) {
    if (!activeFence) {
      const openMatch = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
      if (openMatch) {
        const char = openMatch[1][0] as "`" | "~";
        const info = openMatch[2] || "";
        if (char !== "`" || !info.includes("`")) {
          activeFence = { char, len: openMatch[1].length, lines: [line] };
          continue;
        }
      }
      keptLines.push(line.replace(/`[^`\r\n]*`/g, ""));
      continue;
    }

    activeFence.lines.push(line);
    const closeMatch = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (
      closeMatch &&
      closeMatch[1][0] === activeFence.char &&
      closeMatch[1].length >= activeFence.len
    ) {
      const innerText = activeFence.lines.slice(1, -1).join("\n");
      if (isProtectedTransportCodeBlock(activeFence.char, activeFence.len, innerText)) {
        keptLines.push(...activeFence.lines);
      }
      activeFence = null;
    }
  }

  if (activeFence) {
    const innerText = activeFence.lines.slice(1).join("\n");
    if (isProtectedTransportCodeBlock(activeFence.char, activeFence.len, innerText)) {
      keptLines.push(...activeFence.lines);
    }
  }

  return keptLines.join("\n");
}

function hasUnbalancedClosingTripleFenceOutsidePatch(innerBody: string): boolean {
  let insideCustomTool = false;
  for (const line of innerBody.split(/\r?\n/)) {
    if (/<custom_tool_call\b/i.test(line)) {
      insideCustomTool = true;
    }
    if (!insideCustomTool && /^[ \t]*`{3}[ \t]*$/.test(line)) {
      return true;
    }
    if (/<\/\s*custom_tool_call\s*>/i.test(line)) {
      insideCustomTool = false;
    }
  }
  return false;
}

/**
 * Gỡ wrapper vận chuyển tùy chọn (4-backtick hoặc 3-backtick kèm `<webResponse>...</webResponse>`)
 * để làm sạch câu trả lời cuối khi cần (vd. đồng bộ finalize text trên Stream Gate).
 */
export function unwrapOptionalAssistantEnvelope(rawResponse: string): string {
  let text = String(rawResponse || "").trim();
  if (!text) return "";

  const extracted = extractOuterTransportFence(text);
  if (extracted) {
    text = extracted.inner;
  }

  const envelopeMatch = /^<webResponse\b[^>]*>([\s\S]*?)<\/\s*webResponse\s*>$/i.exec(text);
  if (envelopeMatch) {
    text = envelopeMatch[1].trim();
  } else {
    text = text
      .replace(/^<webResponse\b[^>]*>\s*/i, "")
      .replace(/\s*<\/\s*webResponse\s*>`{0,4}$/i, "")
      .trim();
  }

  return text;
}

function toCanonicalQuadTransportFence(innerBody: string): string {
  return `\`\`\`\`markdown\n${innerBody.trim()}\n\`\`\`\``;
}

/**
 * Parser "Strict Actions — Natural Answers" cho Trợ lý cá nhân (`src/assistant/`):
 * - **Final Answer:** Chấp nhận thẳng Markdown tự nhiên (không ép 4-backtick hay `<webResponse>`),
 *   giúp streaming lên Telegram mượt mà. Ví dụ XML minh họa bên trong code block ` ```...``` ` được bỏ qua.
 * - **Action Turn:** Đồng bộ 100% với `parseStrictWebResponse` — yêu cầu `<webResponse>...</webResponse>`
 *   (và không lẫn chữ/text thừa bên trong hay giữa các `<tool_call>`, cấm `<thought>`, kiểm đủ patch grammar
 *   và `SafeCommandGuard`). Riêng trường hợp AI lỡ viết câu dẫn ngắn phía trước khối ` ````markdown\n<webResponse> `
 *   đã kịp stream lên Telegram thì tách câu dẫn thành `commentaryText` trước khi parse strict phần Action.
 */
export class AssistantResponseParser {
  public parse(rawResponse: string): AssistantParsedResponse {
    const trimmedRaw = String(rawResponse || "").trim();
    if (!trimmedRaw) {
      return {
        kind: "protocol_error",
        code: "EMPTY_RESPONSE",
        message: "Phản hồi từ AI Web bị rỗng.",
        rawResponse,
      };
    }

    const normalized = normalizeEscapedToolMarkers(trimmedRaw);

    // 1. Toàn bộ phản hồi nằm trong 1 khối 4-backtick hoặc 3-backtick kèm `<webResponse>`:
    //    chuẩn hóa về 4-backtick rồi ủy quyền thẳng sang parseStrictWebResponse.
    const outerTransport = extractOuterTransportFence(normalized);
    if (outerTransport) {
      const strictResult = parseStrictWebResponse(toCanonicalQuadTransportFence(outerTransport.inner));
      return this.mapStrictResult(strictResult, rawResponse);
    }

    // 2. Ngoại lệ phục vụ Telegram streaming: câu dẫn tự nhiên sạch ở đầu + khối 3/4-backtick `<webResponse>` ở cuối.
    const trailingFenceMatch = TRAILING_WEBRESPONSE_FENCE_REGEX.exec(normalized);
    if (trailingFenceMatch) {
      const fenceText = trailingFenceMatch[1];
      const extractedTrailing = extractOuterTransportFence(fenceText.trim());
      const fenceStart = trailingFenceMatch.index + (trailingFenceMatch[0].length - fenceText.length);
      const preamble = normalized.slice(0, fenceStart).trim();

      if (extractedTrailing && !RESERVED_CONTROL_MARKER_REGEX.test(stripNonTransportCodeBlocks(preamble))) {
        const strictResult = parseStrictWebResponse(
          toCanonicalQuadTransportFence(extractedTrailing.inner),
        );
        if (strictResult.kind === "final_answer") {
          const combined = preamble
            ? `${preamble}\n\n${strictResult.content}`
            : strictResult.content;
          return {
            kind: "final_answer",
            content: combined,
            rawResponse,
          };
        }
        return this.mapStrictResult(strictResult, rawResponse, preamble || undefined);
      }
    }

    // 3. Nếu ngoài code fence minh họa có bất kỳ control marker nào (hoặc có transport fence chứa marker
    //    nhưng bị dính text/rác bên ngoài khiến không match envelope chuẩn): tuyệt đối không hạ cấp thành Final Answer.
    const plainOutsideCode = stripNonTransportCodeBlocks(normalized);
    if (RESERVED_CONTROL_MARKER_REGEX.test(plainOutsideCode)) {
      const preparedForStrict = unescapeTurndownInsideToolTags(normalized);
      const strictResult = parseStrictWebResponse(preparedForStrict);
      if (strictResult.kind === "final_answer") {
        // Phòng trường hợp marker xuất hiện với biến thể ngoài khả năng nhận diện của `strict-response-parser`
        return {
          kind: "protocol_error",
          code: "MISSING_RESPONSE_ENVELOPE",
          message:
            "Phát hiện thẻ điều khiển chưa bọc đúng chuẩn ````markdown\\n<webResponse>...</webResponse>\\n````.",
          rawResponse,
        };
      }
      return this.mapStrictResult(strictResult, rawResponse);
    }

    // 4. Final Answer Markdown tự nhiên thuần túy.
    return {
      kind: "final_answer",
      content: trimmedRaw,
      rawResponse,
    };
  }

  private mapStrictResult(
    strictResult: ReturnType<typeof parseStrictWebResponse>,
    rawResponse: string,
    commentaryText?: string,
  ): AssistantParsedResponse {
    if (strictResult.kind === "protocol_error") {
      return {
        kind: "protocol_error",
        code: strictResult.code,
        message: strictResult.message,
        rawResponse,
      };
    }
    if (strictResult.kind === "tool_calls") {
      return {
        kind: "tool_calls",
        calls: strictResult.calls as StrictWebToolCall[],
        ...(commentaryText ? { commentaryText } : {}),
        rawResponse,
      };
    }
    return {
      kind: "final_answer",
      content: strictResult.content,
      rawResponse,
    };
  }
}

export const assistantResponseParser = new AssistantResponseParser();
