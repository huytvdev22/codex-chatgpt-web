import {
  parseStrictWebResponse,
  stripMarkdownCode,
  type StrictWebToolCall,
} from "../adapters/web/protocol/strict-response-parser";
import type { AssistantParsedResponse } from "./types";

const TOOL_TAG_REGEX =
  /<tool_call\b[^>]*>([\s\S]*?)<\/\s*tool_call\s*>|<custom_tool_call\b[^>]*name=["']apply_patch["'][^>]*>([\s\S]*?)<\/\s*custom_tool_call\s*>/gi;

const UNCLOSED_TOOL_REGEX = /<(?:tool_call|custom_tool_call)\b/i;

/**
 * Gỡ wrapper vận chuyển tùy chọn (4-backtick markdown và/hoặc `<webResponse>...</webResponse>`)
 * nếu AI vẫn tự bọc dù giao thức Assistant là Natural-First.
 */
export function unwrapOptionalAssistantEnvelope(rawResponse: string): string {
  let text = String(rawResponse || "").trim();
  if (!text) return "";

  const fenceMatch = /^`{4}(?:markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n`{4}$/i.exec(text);
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

/**
 * Tìm các vùng code fence (` ```...``` `) để không nhận nhầm ví dụ `<tool_call>`
 * nằm trong đoạn code minh họa thành lời gọi công cụ thực thi.
 */
function findCodeFenceRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const regex = /(?:^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[ \t]*(?=\n|$)|$)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function isInsideRanges(index: number, ranges: ReadonlyArray<[number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return true;
  }
  return false;
}

/**
 * Parser Natural-First cho Trợ lý cá nhân (`src/assistant/`):
 * - Chấp nhận thẳng câu trả lời Markdown tự nhiên (không yêu cầu 4-backtick / `<webResponse>`),
 *   triệt tiêu hoàn toàn lỗi format-retry thừa ở các lượt hỏi đáp thường.
 * - Khi phát hiện `<tool_call>` hoặc `<custom_tool_call name="apply_patch">` ngoài code fence:
 *   ủy quyền validate cú pháp JSON/patch/SafeCommandGuard sang `parseStrictWebResponse`,
 *   đồng thời hỗ trợ tách câu dẫn ngắn (`commentaryText`) nếu AI lỡ viết trước thẻ tool.
 */
export class AssistantResponseParser {
  public parse(rawResponse: string): AssistantParsedResponse {
    const cleaned = unwrapOptionalAssistantEnvelope(rawResponse);
    if (!cleaned) {
      return {
        kind: "protocol_error",
        code: "EMPTY_RESPONSE",
        message: "Phản hồi từ AI Web bị rỗng.",
        rawResponse,
      };
    }

    const fenceRanges = findCodeFenceRanges(cleaned);
    const toolBlocks: Array<{ start: number; end: number; rawBlock: string }> = [];
    TOOL_TAG_REGEX.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = TOOL_TAG_REGEX.exec(cleaned)) !== null) {
      if (isInsideRanges(match.index, fenceRanges)) {
        continue;
      }
      toolBlocks.push({
        start: match.index,
        end: match.index + match[0].length,
        rawBlock: match[0],
      });
    }

    if (toolBlocks.length > 0) {
      const canonicalEnvelope = `\`\`\`\`markdown\n<webResponse>\n${toolBlocks.map((b) => b.rawBlock).join("\n")}\n</webResponse>\n\`\`\`\``;
      const strictResult = parseStrictWebResponse(canonicalEnvelope);
      if (strictResult.kind === "protocol_error") {
        return {
          kind: "protocol_error",
          code: strictResult.code,
          message: strictResult.message,
          rawResponse,
        };
      }
      if (strictResult.kind === "tool_calls") {
        const preamble = cleaned.slice(0, toolBlocks[0].start).trim();
        return {
          kind: "tool_calls",
          calls: strictResult.calls as StrictWebToolCall[],
          ...(preamble ? { commentaryText: preamble } : {}),
          rawResponse,
        };
      }
    }

    // Kiểm tra trường hợp AI mở `<tool_call>` / `<custom_tool_call>` nhưng bị cắt cụt (chưa có thẻ đóng).
    const plainOutsideCode = stripMarkdownCode(cleaned);
    if (UNCLOSED_TOOL_REGEX.test(plainOutsideCode)) {
      return {
        kind: "protocol_error",
        code: "INCOMPLETE_TOOL_CALL",
        message: "Phát hiện thẻ gọi công cụ bị thiếu thẻ đóng (`</tool_call>` hoặc `</custom_tool_call>`).",
        rawResponse,
      };
    }

    return {
      kind: "final_answer",
      content: cleaned,
      rawResponse,
    };
  }
}

export const assistantResponseParser = new AssistantResponseParser();
