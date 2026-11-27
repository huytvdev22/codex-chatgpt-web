import {
  parseStrictWebResponse,
  stripMarkdownCode,
  type StrictWebToolCall,
} from "../adapters/web/protocol/strict-response-parser";
import type { AssistantParsedResponse } from "./types";

const RESERVED_CONTROL_MARKER_REGEX =
  /(?:<\/?\s*(?:webResponse|tool_call|custom_tool_call|thought|thinking)\b|\*{3}\s*(?:Begin|End) Patch)/i;

const FULL_TRANSPORT_FENCE_REGEX =
  /^`{4}(?:markdown|md|xml)?[ \t]*\r?\n([\s\S]*)\r?\n`{4}$/i;

const TRAILING_WEBRESPONSE_FENCE_REGEX =
  /(?:^|\n)(`{4}(?:markdown|md|xml)?[ \t]*\r?\n<webResponse\b[\s\S]*\r?\n`{4})$/i;

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
 * Gỡ wrapper vận chuyển tùy chọn (4-backtick markdown và/hoặc `<webResponse>...</webResponse>`)
 * để làm sạch câu trả lời cuối khi cần (vd. đồng bộ finalize text trên Stream Gate).
 */
export function unwrapOptionalAssistantEnvelope(rawResponse: string): string {
  let text = String(rawResponse || "").trim();
  if (!text) return "";

  const fenceMatch = FULL_TRANSPORT_FENCE_REGEX.exec(text);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
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

function normalizeTransportLanguageTag(fenceText: string): string {
  return fenceText.replace(/^`{4}(?:markdown|md|xml)?[ \t]*\r?\n/i, "````markdown\n");
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

    // 1. Toàn bộ phản hồi nằm trong 1 khối 4-backtick transport fence: ủy quyền thẳng sang parseStrictWebResponse.
    if (FULL_TRANSPORT_FENCE_REGEX.test(normalized)) {
      const strictResult = parseStrictWebResponse(normalizeTransportLanguageTag(normalized));
      return this.mapStrictResult(strictResult, rawResponse);
    }

    // 2. Ngoại lệ phục vụ Telegram streaming: câu dẫn tự nhiên sạch ở đầu + khối 4-backtick `<webResponse>` ở cuối.
    const trailingFenceMatch = TRAILING_WEBRESPONSE_FENCE_REGEX.exec(normalized);
    if (trailingFenceMatch) {
      const fenceText = trailingFenceMatch[1];
      const fenceStart = trailingFenceMatch.index + (trailingFenceMatch[0].length - fenceText.length);
      const preamble = normalized.slice(0, fenceStart).trim();

      if (!RESERVED_CONTROL_MARKER_REGEX.test(stripMarkdownCode(preamble))) {
        const strictResult = parseStrictWebResponse(normalizeTransportLanguageTag(fenceText));
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

    // 3. Nếu ngoài code fence thường có bất kỳ control marker nào (<webResponse>, <tool_call>, <custom_tool_call>,
    //    *** Begin Patch, <thought>, <thinking>): tuyệt đối không hạ cấp thành Final Answer — đi qua parseStrictWebResponse.
    const plainOutsideCode = stripMarkdownCode(normalized);
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
