
import { chatGptHtmlToMarkdown } from "./html-to-markdown";

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown> | string;
}

/**
 * M365ToolCallDetector phát hiện cú pháp tool call <tool_call>...</tool_call> từ luồng streaming.
 * Hỗ trợ nhận diện partial chunks, streaming incremental, unescape Turndown markdown escapes (\_ -> _),
 * và loại bỏ code fences nếu có.
 */
export interface M365ToolCallDetectorOptions {
  renderThinkingInText?: boolean;
}

/**
 * Các loại marker có thể xuất hiện khi detector đang ở trạng thái văn bản thường (ngoài mọi khối nội bộ).
 */
type OutsideMarkerKind = "rootOpen" | "rootClose" | "strayClose" | "thoughtOpen" | "toolOpen" | "patchOpen";

interface OutsideMarkerMatch {
  kind: OutsideMarkerKind;
  index: number;
  length: number;
}

interface StepResult {
  emitted: string;
  continueLoop: boolean;
}

/**
 * Danh sách marker theo thứ tự ưu tiên khi trùng vị trí. Marker được chọn là marker xuất hiện SỚM NHẤT trong buffer,
 * tránh trường hợp một marker ở cuối buffer (vd: </m365Response>) làm toàn bộ text phía trước bị emit nguyên văn.
 * Nhánh dạng thiếu dấu `<` (vd: `tool_call>`, `m365Response>`) có lookbehind chặn dấu `/` để không nhận nhầm thẻ đóng.
 */
const OUTSIDE_MARKERS: ReadonlyArray<{ kind: OutsideMarkerKind; pattern: RegExp }> = [
  { kind: "rootClose", pattern: /(?:<\s*\/|\/)\s*m365[\\_]*response\s*>/i },
  { kind: "strayClose", pattern: /(?:<\s*\/|\/)\s*(?:(?:custom[\\_]*)?tool[\\_]*call|thought|thinking)\s*>/i },
  { kind: "rootOpen", pattern: /(?:<\s*|(?<!\/\s*)\b)m365[\\_]*response(?:\s+[^>]*)?>/i },
  { kind: "thoughtOpen", pattern: /<\s*(?:thought|thinking)\s*>/i },
  { kind: "toolOpen", pattern: /(?:<\s*|(?<!\/\s*)\b)(?:custom[\\_]*)?tool[\\_]*call(?:\s+[^>]*)?>/i },
  { kind: "patchOpen", pattern: /(?:\\?\*){2,3}\s*Begin Patch/i },
];

const THOUGHT_CLOSE_RE = /<\s*\/\s*(?:thought|thinking)\s*>/i;
const TOOL_CLOSE_RE = /(?:<\s*\/|\/\s*)(?:custom[\\_]*)?tool[\\_]*call\s*>/i;
const PATCH_CLOSE_RE = /(?:\\?\*){2,3}\s*End Patch/i;
const PATCH_CLOSE_PARTIAL_RE = /(?:\\?\*)+[ \t]*(?:E(?:n(?:d(?:[ \t]*(?:P(?:a(?:t(?:c(?:h)?)?)?)?)?)?)?)?)?$/i;
const PATCH_OPEN_PARTIAL_RE = /(?:\\?\*)+[ \t]*(?:B(?:e(?:g(?:i(?:n(?:[ \t]*(?:P(?:a(?:t(?:c(?:h)?)?)?)?)?)?)?)?)?)?)?$/i;
const FENCE_ONLY_RE = /^```(?:xml|json|patch|diff|markdown)?$/i;
const FENCE_TOKEN_RE = /```(?:xml|json|patch|diff|markdown)?/gi;

/** Tên thẻ nội bộ đã chuẩn hóa (bỏ `_`, `\`, viết thường) không bao giờ được hiển thị cho người dùng. */
const INTERNAL_TAG_NAMES = ["m365response", "thought", "thinking", "toolcall", "customtoolcall"];
const MAX_PARTIAL_TAG_LENGTH = 256;
const MAX_PARTIAL_CLOSE_LENGTH = 48;

/**
 * Tìm marker xuất hiện sớm nhất trong buffer (khi trùng vị trí, ưu tiên theo thứ tự OUTSIDE_MARKERS).
 */
function findEarliestOutsideMarker(buffer: string): OutsideMarkerMatch | null {
  let best: OutsideMarkerMatch | null = null;
  for (const { kind, pattern } of OUTSIDE_MARKERS) {
    const match = buffer.match(pattern);
    if (!match || match.index === undefined) continue;
    if (!best || match.index < best.index) {
      best = { kind, index: match.index, length: match[0].length };
    }
  }
  return best;
}

/**
 * Trả về vị trí bắt đầu của một thẻ nội bộ dở dang ở cuối text (vd: `<`, `</`, `<thou`, `<custom_tool_call name="x`),
 * hoặc -1 nếu đuôi text không thể là thẻ nội bộ.
 */
function findPartialInternalTagStart(text: string): number {
  const lt = text.lastIndexOf("<");
  if (lt === -1) return -1;
  const tail = text.slice(lt + 1);
  if (tail.includes(">") || tail.length > MAX_PARTIAL_TAG_LENGTH) return -1;

  const body = tail.replace(/^\s*\/?\s*/, "");
  const rawName = body.match(/^[A-Za-z0-9\\_]*/)?.[0] ?? "";
  const rest = body.slice(rawName.length);
  const name = rawName.replace(/[\\_]/g, "").toLowerCase();

  if (rest.length === 0) {
    // Tên thẻ còn đang được stream: giữ lại nếu có thể là tiền tố của một thẻ nội bộ
    return INTERNAL_TAG_NAMES.some(n => n.startsWith(name)) ? lt : -1;
  }
  // Tên thẻ đã hoàn chỉnh và đang stream phần thuộc tính: chỉ giữ lại nếu là thẻ nội bộ
  return /^\s/.test(rest) && INTERNAL_TAG_NAMES.includes(name) ? lt : -1;
}

/**
 * Trả về vị trí bắt đầu của thẻ tool call dạng thiếu dấu `<` còn dở dang ở cuối text (vd: `tool_ca`), hoặc -1.
 */
function findPartialBareToolTagStart(text: string): number {
  const rawToolPrefix = "tool_call>";
  const rawCustomPrefix = "custom_tool_call";
  for (const match of text.matchAll(/\b(?:custom[\\_]*)?tool/gi)) {
    if (match.index === undefined) continue;
    const suffix = text.slice(match.index);
    if (suffix.includes(">") || suffix.length > MAX_PARTIAL_TAG_LENGTH) continue;
    const candidate = suffix.replace(/\\/g, "").toLowerCase();
    const isPrefixOfTag = rawToolPrefix.startsWith(candidate) || `${rawCustomPrefix}>`.startsWith(candidate);
    const isTagWithAttributes = candidate.startsWith(`${rawCustomPrefix} `);
    if (isPrefixOfTag || isTagWithAttributes) {
      return match.index;
    }
  }
  return -1;
}

/**
 * Tính vị trí cần tạm giữ ở cuối buffer khi đang ở trạng thái văn bản thường (chờ chunk tiếp theo để xác định marker).
 * Trả về -1 nếu toàn bộ buffer an toàn để emit.
 */
function findOutsideHoldIndex(buffer: string): number {
  if (FENCE_ONLY_RE.test(buffer.trim())) return 0;

  const patchMatch = buffer.match(PATCH_OPEN_PARTIAL_RE);
  const tickMatch = buffer.match(/`{1,5}$/);
  const candidates = [
    findPartialInternalTagStart(buffer),
    findPartialBareToolTagStart(buffer),
    patchMatch && patchMatch.index !== undefined && patchMatch[0].length >= 1 ? patchMatch.index : -1,
    tickMatch && tickMatch.index !== undefined ? tickMatch.index : -1,
  ].filter(index => index >= 0);

  return candidates.length > 0 ? Math.min(...candidates) : -1;
}

/**
 * Trả về vị trí bắt đầu của thẻ đóng thought đang dở dang ở cuối text (vd: `<`, `</`, `</thou`),
 * hoặc text.length nếu không có.
 */
function findPartialThoughtCloseStart(text: string): number {
  const ltIndex = text.lastIndexOf("<");
  if (ltIndex >= 0) {
    const tail = text.slice(ltIndex);
    if (!tail.includes(">") && tail.length <= MAX_PARTIAL_CLOSE_LENGTH) {
      const body = tail.replace(/^<\s*\/?\s*/, "").replace(/[\\_]/g, "").toLowerCase();
      if ("thought".startsWith(body) || "thinking".startsWith(body)) {
        return ltIndex;
      }
    }
  }
  return text.length;
}

/**
 * Trả về vị trí bắt đầu của thẻ đóng tool đang dở dang ở cuối text (vd: `<`, `</`, `</tool_call`, hoặc `/tool`),
 * hoặc text.length nếu không có. Đảm bảo không tách rời `<` khỏi `/` khi chuỗi kết thúc bằng `</`.
 */
function findPartialToolCloseStart(text: string): number {
  const ltIndex = text.lastIndexOf("<");
  if (ltIndex >= 0) {
    const tail = text.slice(ltIndex);
    if (!tail.includes(">") && tail.length <= MAX_PARTIAL_CLOSE_LENGTH) {
      const body = tail.replace(/^<\s*\/?\s*/, "").replace(/[\\_]/g, "").toLowerCase();
      if ("customtoolcall".startsWith(body) || "toolcall".startsWith(body)) {
        return ltIndex;
      }
    }
  }

  const slashIndex = text.lastIndexOf("/");
  if (slashIndex >= 0) {
    const tail = text.slice(slashIndex);
    if (!tail.includes(">") && tail.length <= MAX_PARTIAL_CLOSE_LENGTH) {
      const body = tail.replace(/^\/\s*/, "").replace(/[\\_]/g, "").toLowerCase();
      if (body.length > 0 && ("customtoolcall".startsWith(body) || "toolcall".startsWith(body))) {
        return slashIndex;
      }
    }
  }

  return text.length;
}

/**
 * Làm sạch đoạn văn bản đứng trước một khối nội bộ (root/tool/patch): bỏ code fence bao ngoài và khoảng trắng đuôi.
 * Không trim đầu chuỗi để tránh dính chữ giữa các chunk.
 */
function cleanPrefixBeforeBlock(prefix: string): string {
  const withoutFences = prefix.replace(FENCE_TOKEN_RE, "");
  return withoutFences.trim() ? withoutFences.trimEnd() : "";
}

export class M365ToolCallDetector {
  private buffer = "";
  private inToolCall = false;
  private toolContent = "";
  private inPatch = false;
  private patchContent = "";
  private inThought = false;
  private thoughtContent = "";
  private renderedThinking = false;
  private detectedToolCall: ParsedToolCall | null = null;
  private options: M365ToolCallDetectorOptions;

  constructor(options?: M365ToolCallDetectorOptions) {
    this.options = options || {};
  }

  /**
   * Đưa chunk mới vào detector.
   * Trả về text thông thường an toàn để emit text_delta (nếu không thuộc tool_call, patch hay thought).
   */
  feed(chunk: string): string {

    if (this.detectedToolCall) return "";
    this.buffer += chunk;

    let emittedText = "";

    while (this.buffer.length > 0 && !this.detectedToolCall) {
      const step = this.inThought
        ? this.consumeThought()
        : this.inPatch
          ? this.consumePatch()
          : this.inToolCall
            ? this.consumeToolCall()
            : this.consumeOutside();
      emittedText += step.emitted;
      if (!step.continueLoop) break;
    }

    return emittedText;
  }

  /**
   * Xử lý buffer khi đang ở trạng thái văn bản thường: tìm marker sớm nhất (root/thought/tool/patch),
   * emit phần văn bản an toàn phía trước và chuyển trạng thái. Nếu chưa có marker hoàn chỉnh,
   * tạm giữ phần đuôi có thể là thẻ dở dang để chờ chunk tiếp theo.
   */
  private consumeOutside(): StepResult {
    const marker = findEarliestOutsideMarker(this.buffer);
    if (marker) {
      const prefix = this.buffer.slice(0, marker.index);
      const rest = this.buffer.slice(marker.index + marker.length);
      switch (marker.kind) {
        case "rootOpen":
          // Nuốt sạch thẻ mở root <m365Response> hoặc <m365_response>
          this.buffer = rest.replace(/^\r?\n/, "");
          return { emitted: cleanPrefixBeforeBlock(prefix), continueLoop: true };
        case "rootClose":
        case "strayClose":
          // Nuốt sạch thẻ đóng root </m365Response> và các thẻ đóng nội bộ mồ côi
          this.buffer = rest;
          return { emitted: prefix, continueLoop: true };
        case "thoughtOpen":
          this.inThought = true;
          this.buffer = rest;
          return { emitted: prefix, continueLoop: true };
        case "toolOpen":
          this.inToolCall = true;
          this.toolContent = "";
          this.buffer = rest;
          return { emitted: cleanPrefixBeforeBlock(prefix), continueLoop: true };
        case "patchOpen":
          // Giữ nguyên marker *** Begin Patch trong buffer để đưa vào patchContent
          this.inPatch = true;
          this.buffer = this.buffer.slice(marker.index);
          return { emitted: cleanPrefixBeforeBlock(prefix), continueLoop: true };
      }
    }

    const holdIndex = findOutsideHoldIndex(this.buffer);
    if (holdIndex === -1) {
      const emitted = this.buffer;
      this.buffer = "";
      return { emitted, continueLoop: false };
    }
    const emitted = this.buffer.slice(0, holdIndex);
    this.buffer = this.buffer.slice(holdIndex);
    return { emitted, continueLoop: false };
  }

  /**
   * Xử lý buffer khi đang trong khối suy nghĩ nội tâm, tìm thẻ đóng </thought> hoặc </thinking>.
   */
  private consumeThought(): StepResult {
    const thoughtCloseMatch = this.buffer.match(THOUGHT_CLOSE_RE);
    if (thoughtCloseMatch && thoughtCloseMatch.index !== undefined) {
      this.thoughtContent += this.buffer.slice(0, thoughtCloseMatch.index);
      this.inThought = false;

      let emitted = "";
      // Nếu được bật renderThinkingInText: Render khối suy nghĩ dạng văn bản thuần túy với icon 💭
      if (this.options.renderThinkingInText && !this.renderedThinking) {
        const cleanThought = this.thoughtContent.trim();
        if (cleanThought) {
          emitted = `💭 ${cleanThought}\n\n`;
          this.renderedThinking = true;
        }
      }

      const afterClose = this.buffer.slice(thoughtCloseMatch.index + thoughtCloseMatch[0].length);
      this.buffer = afterClose.replace(/^\r?\n/, "");
      return { emitted, continueLoop: true };
    }

    // Giữ lại đuôi có thể là thẻ đóng bị cắt giữa 2 chunk (vd: "</thou" + "ght>")
    const holdIndex = findPartialThoughtCloseStart(this.buffer);
    this.thoughtContent += this.buffer.slice(0, holdIndex);
    this.buffer = this.buffer.slice(holdIndex);
    return { emitted: "", continueLoop: false };
  }

  /**
   * Xử lý buffer khi đang trong khối patch, tìm *** End Patch hoặc \*\*\* End Patch (2 hoặc 3 dấu sao).
   */
  private consumePatch(): StepResult {
    const patchCloseMatch = this.buffer.match(PATCH_CLOSE_RE);
    if (patchCloseMatch && patchCloseMatch.index !== undefined) {
      const patchEndIndex = patchCloseMatch.index + patchCloseMatch[0].length;
      this.patchContent += this.buffer.slice(0, patchEndIndex);
      this.inPatch = false;
      this.buffer = this.buffer.slice(patchEndIndex);

      this.detectedToolCall = {
        name: "apply_patch",
        arguments: { input: sanitizeCodexPatchContent(this.patchContent) },
      };
      return { emitted: "", continueLoop: false };
    }

    // Giữ lại đuôi có thể là marker kết thúc bị cắt giữa 2 chunk (vd: "*** En" + "d Patch")
    const partialMatch = this.buffer.match(PATCH_CLOSE_PARTIAL_RE);
    const holdIndex = partialMatch && partialMatch.index !== undefined ? partialMatch.index : this.buffer.length;
    this.patchContent += this.buffer.slice(0, holdIndex);
    this.buffer = this.buffer.slice(holdIndex);
    return { emitted: "", continueLoop: false };
  }

  /**
   * Xử lý buffer khi đang trong khối tool call, tìm thẻ đóng </tool_call>, /tool_call>, </custom_tool_call>.
   */
  private consumeToolCall(): StepResult {
    const closeMatch = this.buffer.match(TOOL_CLOSE_RE);
    if (closeMatch && closeMatch.index !== undefined) {
      this.toolContent += this.buffer.slice(0, closeMatch.index);
      this.inToolCall = false;
      this.buffer = this.buffer.slice(closeMatch.index + closeMatch[0].length);

      const toolCall = this.parseToolPayload(this.toolContent);
      this.toolContent = "";
      if (toolCall) {
        this.detectedToolCall = toolCall;
        return { emitted: "", continueLoop: false };
      }
      return { emitted: "", continueLoop: true };
    }

    // Giữ lại đuôi có thể là thẻ đóng bị cắt giữa 2 chunk (vd: "</custom_tool_" + "call>")
    const holdIndex = findPartialToolCloseStart(this.buffer);
    this.toolContent += this.buffer.slice(0, holdIndex);
    this.buffer = this.buffer.slice(holdIndex);
    return { emitted: "", continueLoop: false };
  }

  /**
   * Kết thúc lượt stream: flush các phần còn lại.
   * Yêu cầu 4 & 5: TUYỆT ĐỐI KHÔNG thực thi tool call khi thẻ mở chưa có thẻ đóng
   * hoặc khi JSON arguments chưa hoàn chỉnh!
   */
  finish(): {
    remainingText: string;
    toolCall: ParsedToolCall | null;
    detectedToolCall?: ParsedToolCall;
    protocolError?: "INCOMPLETE_TOOL_CALL" | "INCOMPLETE_PATCH_CALL";
  } {

    let remainingText = "";
    let protocolError: "INCOMPLETE_TOOL_CALL" | "INCOMPLETE_PATCH_CALL" | undefined;
    if (this.inThought) {
      this.thoughtContent += this.buffer;
      this.buffer = "";
      this.inThought = false;
      if (this.options.renderThinkingInText && !this.renderedThinking) {
        const cleanThought = this.thoughtContent.trim();
        if (cleanThought) {
          remainingText += `💭 ${cleanThought}\n\n`;
          this.renderedThinking = true;
        }
      }
    }

    if (!this.inToolCall && !this.inPatch && !this.detectedToolCall) {
      // Bỏ thẻ nội bộ dở dang ở cuối stream (vd: "</" hoặc "<custom_tool_call name=...") để không rò rỉ ra UI
      const partialTagStart = findPartialInternalTagStart(this.buffer);
      remainingText += partialTagStart >= 0 ? this.buffer.slice(0, partialTagStart) : this.buffer;
      this.buffer = "";
    } else if (this.inToolCall && !this.detectedToolCall) {
      // Thẻ <tool_call> chưa đóng -> Stream bị ngắt giữa JSON arguments.
      // Fail closed: không tự sửa, không thực thi và tuyệt đối không rò control frame ra UI.
      protocolError = "INCOMPLETE_TOOL_CALL";
      this.toolContent = "";
      this.buffer = "";
    } else if (this.inPatch && !this.detectedToolCall) {
      // Khối patch chưa có *** End Patch -> Dở dang, không thực thi.
      protocolError = "INCOMPLETE_PATCH_CALL";
      this.patchContent = "";
      this.buffer = "";
    }

    // Chỉ loại bỏ root transport tag. Không xóa trailing backticks vì đó có thể là
    // closing fence Markdown hợp lệ của final answer.
    remainingText = remainingText
      .replace(/<\s*\/?\s*m365[\\_]*response\s*>/gi, "")
      .trimEnd();

    return {
      remainingText,
      toolCall: this.detectedToolCall,
      detectedToolCall: this.detectedToolCall ?? undefined,
      ...(protocolError ? { protocolError } : {}),
    };
  }

  /**
   * Lấy nội dung suy nghĩ nội tâm (thought/thinking) thu thập được trong quá trình stream.
   */
  getThinking(): string {
    return this.thoughtContent.trim();
  }

  /**
   * Helper xử lý chunk và trả về kết quả ngay lập tức
   */
  processChunk(chunk: string): { emittedText: string; toolCalls: ParsedToolCall[] } {

    const emittedText = this.feed(chunk);
    const toolCall = this.getToolCall();
    return {
      emittedText,
      toolCalls: toolCall ? [toolCall] : [],
    };
  }

  /**
 * Kiểm tra xem detector đã nhận diện được một tool call hoàn chỉnh hay chưa.
 */
  hasDetectedToolCall(): boolean {

    return this.detectedToolCall !== null;
  }

  /**
 * Lấy thông tin tool call hoàn chỉnh đã phát hiện được.
 */
  getToolCall(): ParsedToolCall | null {

    return this.detectedToolCall;
  }

  /**
   * Tự động chuẩn hóa các ký tự điều khiển thô (raw newline, carriage return, tab)
   * nằm bên trong string literal của JSON để JSON.parse không bị lỗi Bad control character.
   * Đồng thời tự động khử dấu \ thừa ở cuối dòng trước khi xuống dòng (line continuation).
   */
  private cleanToolPayload(raw: string): string {

    const stripped = stripOuterCodeFence(raw);
    return stripped
      .replace(/\\_/g, "_")
      .replace(/^[\s\S]*?(?:<|\b)(?:custom[\\_]*)?tool[\\_]*call(?:\s+[^>]*)?>/i, "")
      .replace(/(?:<\s*\/|\/\s*)(?:custom[\\_]*)?tool[\\_]*call\s*>[\s\S]*$/i, "")
      .trim();
  }

  /**
 * Phân giải chuỗi payload thô bên trong thẻ tool call thành tên hàm và đối số JSON.
 */
  private parseToolPayload(raw: string): ParsedToolCall | null {

    const trimmed = raw.trim();

    // 0. Ưu tiên cao nhất: Thử parse trực tiếp JSON gốc nguyên bản không qua bất kỳ sanitizer nào
    try {
      const directParsed = JSON.parse(trimmed);
      if (directParsed && typeof directParsed === "object") {
        const name = typeof directParsed.name === "string" ? directParsed.name : "read_file";
        let args = directParsed.arguments || directParsed.args || {};
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch { args = { path: args }; }
        }
        if (name === "write_file") {
          if (!args || typeof args !== "object" || !args.path || args.content === undefined) {
            return null;
          }
        }
        if (name === "apply_patch" && args && typeof args === "object") {
          const rawP = args.input || args.patch;
          if (typeof rawP === "string") {
            args = { input: sanitizeCodexPatchContent(rawP) };
          }
        }
        if (name === "exec_command" && args && typeof args === "object") {
          const cmd = args.cmd || args.command || "";
          args.cmd = String(cmd);
        }
        return { name, arguments: args };
      }
    } catch { }

    const clean = this.cleanToolPayload(raw);

    // 1. Thử parse với sanitizer xử lý raw newlines/control characters và trailing backslash
    try {
      const sanitized = sanitizeJsonControlChars(clean);
      const parsed = JSON.parse(sanitized);
      if (parsed && typeof parsed === "object") {
        const name = typeof parsed.name === "string" ? parsed.name : "read_file";
        let args = parsed.arguments;
        if (!args && parsed.path) {
          args = { path: parsed.path };
        } else if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            args = { path: args };
          }
        } else if (!args) {
          args = {};
        }

        // Yêu cầu 4 & 5: Kiểm tra tính hoàn chỉnh bắt buộc cho write_file
        if (name === "write_file") {
          if (!args || typeof args !== "object" || !args.path || args.content === undefined) {
            return null;
          }
        }

        if (name === "apply_patch" && args && typeof args === "object") {
          const rawP = args.input || args.patch;
          if (typeof rawP === "string") {
            args = { input: sanitizeCodexPatchContent(rawP) };
          }
        }

        return {
          name,
          arguments: args,
        };
      }
    } catch { }

    // 2. Thử parse nguyên bản nếu clean khác sanitized
    try {
      const parsed = JSON.parse(clean);
      if (parsed && typeof parsed === "object") {
        const name = typeof parsed.name === "string" ? parsed.name : "read_file";
        let args = parsed.arguments;
        if (!args && parsed.path) {
          args = { path: parsed.path };
        } else if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            args = { path: args };
          }
        } else if (!args) {
          args = {};
        }

        if (name === "write_file") {
          if (!args || typeof args !== "object" || !args.path || args.content === undefined) {
            return null;
          }
        }

        if (name === "apply_patch" && args && typeof args === "object") {
          const rawP = args.input || args.patch;
          if (typeof rawP === "string") {
            args = { input: sanitizeCodexPatchContent(rawP) };
          }
        }

        return {
          name,
          arguments: args,
        };
      }
    } catch { }

    // 3. Cứu hộ trường hợp apply_patch: JSON.parse thất bại vì unescaped quotes bên trong patch
    if (/\*{2,3}\s*Begin Patch/i.test(clean)) {
      const cleanedPatch = sanitizeCodexPatchContent(clean);
      if (cleanedPatch.includes("*** Begin Patch")) {
        return {
          name: "apply_patch",
          arguments: { input: cleanedPatch },
        };
      }
    }

    return null;
  }
}

/**
 * Tự động chuẩn hóa các ký tự điều khiển thô (raw newline, carriage return, tab)
 * nằm bên trong string literal của JSON để JSON.parse không bị lỗi Bad control character.
 * Đồng thời tự động khử dấu \ thừa ở cuối dòng trước khi xuống dòng (line continuation).
 */
export function sanitizeJsonControlChars(raw: string): string {

  let inString = false;
  let escaped = false;
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"' && !escaped) {
      inString = !inString;
      out += ch;
    } else if (inString) {
      if (ch === "\n") {
        // Khử dấu gạch chéo ngược ở cuối dòng trước khi xuống dòng (line continuation)
        if (escaped && out.endsWith("\\")) {
          out = out.slice(0, -1);
        }
        out += "\\n";
        escaped = false;
        continue;
      } else if (ch === "\r") {
        if (escaped && out.endsWith("\\")) {
          out = out.slice(0, -1);
        }
        out += "\\r";
        escaped = false;
        continue;
      } else if (ch === "\t") {
        out += "\\t";
      } else {
        // Nếu ký tự trước là '\' nhưng ký tự hiện tại không phải là escape sequence hợp lệ trong JSON (" \ / b f n r t u):
        // (Ví dụ: shell scripts \(, \), regex \., \s, \d, hoặc Markdown \[, \], \*, \_)
        // Tự động escape backslash để chuỗi trở thành literal backslash hợp lệ trong JSON, không làm JSON.parse bị crash
        if (escaped && !/^[\\/"bfnrtu]/.test(ch)) {
          out += "\\" + ch;
          escaped = false;
          continue;
        }
        out += ch;
      }
    } else {
      out += ch;
    }
    escaped = (ch === "\\" && !escaped);
  }
  return out;
}

/**
 * Bóc tách code fence ở rìa ngoài cùng của khối JSON/XML
 */
export function stripOuterCodeFence(raw: string): string {

  let trimmed = raw.trim();
  const openMatch = trimmed.match(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n/);
  if (openMatch) {
    trimmed = trimmed.slice(openMatch[0].length);
  }
  const closeMatch = trimmed.match(/\r?\n```[ \t]*$/);
  if (closeMatch) {
    trimmed = trimmed.slice(0, trimmed.length - closeMatch[0].length);
  }
  return trimmed.trim();
}

/**
 * Chuẩn hóa và làm sạch triệt để khối Codex Patch:
 * 1. Bóc tách chính xác từ Begin Patch đến End Patch, loại bỏ hoàn toàn thẻ XML hoặc rác JSON ở đuôi.
 * 2. Chuẩn hóa header thành `*** Begin Patch` và footer thành `*** End Patch`.
 * 3. Tự động giải mã unescape \n literal nếu patch bị bọc trong chuỗi JSON/escape string.
 * 4. Gọt sạch các ký tự escape markdown thừa từ Turndown.
 */
export function sanitizeCodexPatchContent(rawPatch: string): string {

  let patch = rawPatch
    .replaceAll("\\*", "*")
    .replaceAll("\\_", "_")
    .replaceAll("\\[", "[")
    .replaceAll("\\]", "]")
    .replaceAll("\\{", "{")
    .replaceAll("\\}", "}")
    .replaceAll("\\~", "~");

  // Tìm vị trí bắt đầu Begin Patch (2 hoặc 3 dấu sao)
  const beginMatch = patch.match(/\*{2,3}\s*Begin Patch/i);
  if (beginMatch && beginMatch.index !== undefined) {
    patch = patch.slice(beginMatch.index);
  }

  // Tìm vị trí kết thúc End Patch (2 hoặc 3 dấu sao)
  const endMatch = patch.match(/\*{2,3}\s*End Patch/i);
  if (endMatch && endMatch.index !== undefined) {
    patch = patch.slice(0, endMatch.index + endMatch[0].length);
  }

  // Chuẩn hóa Begin Patch và End Patch thành đúng 3 dấu sao
  patch = patch.replace(/^\*{2,3}\s*Begin Patch/i, "*** Begin Patch");
  patch = patch.replace(/\*{2,3}\s*End Patch$/i, "*** End Patch");

  // Nếu trong ruột patch chứa các chuỗi \n literal và số dòng thực tế không đủ (hoặc có nhiều \n literal hơn newline thực tế)
  const literalNewlineCount = (patch.match(/\\n/g) || []).length;
  const actualNewlineCount = (patch.match(/\n/g) || []).length;
  if (literalNewlineCount > 0 && (actualNewlineCount < 3 || literalNewlineCount > actualNewlineCount)) {
    patch = patch
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"');
  }

  // Khử dấu gạch chéo ngược thừa ở cuối dòng do Turndown
  patch = patch.replace(/\\+[ \t]*(\r?\n)/g, "$1");

  // Tự động phục hồi các thẻ HTML bị biến dạng/cắt cụt do bộ lọc web của Microsoft Copilot
  patch = autoHealHtmlMangledTags(patch);

  return patch.trim();
}

/**
 * Tự động phục hồi các thẻ HTML/XML bị bộ lọc giao diện hoặc LLM của Microsoft Copilot làm biến dạng:
 * 1. Phục hồi thẻ <script src="..."> bị sanitize biến dạng thành .jsscript>, .jsatch hoặc thiếu mở/đóng thẻ
 * 2. Phục hồi thẻ <link rel="stylesheet" href="..."> bị biến dạng thành .csslink> hoặc đuôi rác
 * 3. Phục hồi các thẻ <meta> bị cắt cụt đuôi (thiếu dấu ngoặc kép hoặc dấu đóng >)
 */
export function autoHealHtmlMangledTags(text: string): string {
  if (!text) return "";

  // 1. Phục hồi thẻ script (ví dụ: js/storage.jsscript>, js/app.jsatch, - js/app.jsatch, + js/storage.jsscript>)
  let healed = text.replace(
    /^([ \t]*[-+ ]?[ \t]*)(?:<script\s+src=["'\s]*)?([a-zA-Z0-9_./-]+\.js)(?:["'\s]*>)?(?:<\/)?[sS]cript>?/gm,
    "$1<script src=\"$2\"></script>"
  );
  healed = healed.replace(
    /^([ \t]*[-+ ]?[ \t]*)(?:<script\s+src=["'\s]*)?([a-zA-Z0-9_./-]+\.js)(?:["'\s]*>)?(?:<\/)?[aA]tch$/gm,
    "$1<script src=\"$2\"></script>"
  );

  // 2. Phục hồi thẻ link stylesheet (ví dụ: styles.csslink>, styles.cssatch)
  healed = healed.replace(
    /^([ \t]*[-+ ]?[ \t]*)(?:<link\s+[^>\n]*href=["'\s]*)?([a-zA-Z0-9_./-]+\.css)(?:["'\s]*>)?(?:<\/)?[lL]ink>?/gm,
    "$1<link rel=\"stylesheet\" href=\"$2\">"
  );

  // 3. Phục hồi thẻ meta bị cắt cụt đuôi
  healed = healed.replace(
    /^([ \t]*[-+ ]?[ \t]*<meta\s+[^>\n]*)(?<!>)$/gm,
    (match) => {
      const quotes = (match.match(/"/g) || []).length;
      if (quotes % 2 !== 0) {
        return match + '">';
      }
      return match.endsWith(">") ? match : match + ">";
    }
  );

  return healed;
}

export { chatGptHtmlToMarkdown };
