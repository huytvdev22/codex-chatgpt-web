import { logFunctionInput } from "../debug-logger";
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
export class M365ToolCallDetector {
  private buffer = "";
  private inToolCall = false;
  private toolContent = "";
  private inPatch = false;
  private patchContent = "";
  private inThought = false;
  private thoughtContent = "";
  private detectedToolCall: ParsedToolCall | null = null;

  /**
   * Đưa chunk mới vào detector.
   * Trả về text thông thường an toàn để emit text_delta (nếu không thuộc tool_call, patch hay thought).
   */
  feed(chunk: string): string {
    logFunctionInput("translation:toolcall-detector", "feed", { chunk });
    if (this.detectedToolCall) return "";
    this.buffer += chunk;

    let emittedText = "";

    while (this.buffer.length > 0) {
      if (!this.inToolCall && !this.inPatch && !this.inThought) {
        // 1. Nhận diện thẻ mở suy nghĩ nội tâm <thought> hoặc <thinking>
        const thoughtOpenMatch = this.buffer.match(/<\s*(?:thought|thinking)\s*>/i);
        if (thoughtOpenMatch && thoughtOpenMatch.index !== undefined) {
          if (thoughtOpenMatch.index > 0) {
            emittedText += this.buffer.slice(0, thoughtOpenMatch.index);
          }
          this.inThought = true;
          this.buffer = this.buffer.slice(thoughtOpenMatch.index + thoughtOpenMatch[0].length);
          continue;
        }

        // 2. Ưu tiên tìm thẻ mở <tool_call>, tool_call>, <custom_tool_call ...>, custom_tool_call>
        const openMatch = this.buffer.match(/(?:<|\b)\s*(?:custom[\\_]*)?tool[\\_]*call(?:\s+[^>]*)?>/i);
        if (openMatch && openMatch.index !== undefined) {
          if (openMatch.index > 0) {
            const prefix = this.buffer.slice(0, openMatch.index);
            const cleanPrefix = prefix.replace(/```(?:xml|json|patch)?/gi, "").trim();
            if (cleanPrefix) {
              emittedText += cleanPrefix;
            }
          }
          this.inToolCall = true;
          this.buffer = this.buffer.slice(openMatch.index + openMatch[0].length);
          continue;
        }

        // 3. Tìm khối patch Codex độc lập: *** Begin Patch hoặc \*\*\* Begin Patch (hỗ trợ cả 2 hoặc 3 dấu sao)
        const patchOpenMatch = this.buffer.match(/(?:\\?\*){2,3}\s*Begin Patch/i);
        if (patchOpenMatch && patchOpenMatch.index !== undefined) {
          if (patchOpenMatch.index > 0) {
            const prefix = this.buffer.slice(0, patchOpenMatch.index);
            const cleanPrefix = prefix.replace(/```(?:patch|diff)?/gi, "").trim();
            if (cleanPrefix) {
              emittedText += cleanPrefix;
            }
          }
          this.inPatch = true;
          this.buffer = this.buffer.slice(patchOpenMatch.index);
          continue;
        }

        // Tạm hoãn emit nếu buffer chỉ là code fence ``` hoặc ```patch/xml để chờ thẻ mở
        const trimmed = this.buffer.trim();
        if (/^```(?:xml|json|patch|diff)?$/i.test(trimmed)) {
          break;
        }

        // Kiểm tra xem đuôi buffer có thể là tiền tố dở dang của thẻ thought không
        const thoughtPrefixMatch = this.buffer.match(/<\s*(?:t(?:h(?:o(?:u(?:g(?:h(?:t)?)?)?)?)?|i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?$/i);
        if (thoughtPrefixMatch && thoughtPrefixMatch.index !== undefined) {
          if (thoughtPrefixMatch.index > 0) {
            emittedText += this.buffer.slice(0, thoughtPrefixMatch.index);
            this.buffer = this.buffer.slice(thoughtPrefixMatch.index);
          }
          break;
        }

        // Kiểm tra xem đuôi buffer có thể là tiền tố dở dang của thẻ mở không (hỗ trợ cả dạng <... và tool...)
        const possiblePrefixMatch = this.buffer.match(/(?:<[^>]*$|\b(?:custom[\\_]*)?tool(?:[\\_]*call)?[^>]*$)/i);
        if (possiblePrefixMatch && possiblePrefixMatch.index !== undefined) {
          const prefixCandidate = possiblePrefixMatch[0].toLowerCase();
          const targetPrefix = "<tool_call>";
          const targetPrefixAlt = "<tool\\_call>";
          const targetCustom = "<custom_tool_call";
          const rawToolPrefix = "tool_call>";
          const rawCustomPrefix = "custom_tool_call";
          if (
            targetPrefix.startsWith(prefixCandidate) ||
            targetPrefixAlt.startsWith(prefixCandidate) ||
            targetCustom.startsWith(prefixCandidate) ||
            rawToolPrefix.startsWith(prefixCandidate) ||
            rawCustomPrefix.startsWith(prefixCandidate)
          ) {
            if (possiblePrefixMatch.index > 0) {
              emittedText += this.buffer.slice(0, possiblePrefixMatch.index);
              this.buffer = this.buffer.slice(possiblePrefixMatch.index);
            }
            break;
          }
        }

        // Kiểm tra xem đuôi buffer có thể là tiền tố dở dang của *** Begin Patch không
        const patchPrefixCandidateMatch = this.buffer.match(/(?:\\?\*)+[ \t]*(?:B(?:e(?:g(?:i(?:n)?)?)?)?)?$/i);
        if (patchPrefixCandidateMatch && patchPrefixCandidateMatch.index !== undefined) {
          if (patchPrefixCandidateMatch[0].length >= 2) {
            if (patchPrefixCandidateMatch.index > 0) {
              emittedText += this.buffer.slice(0, patchPrefixCandidateMatch.index);
              this.buffer = this.buffer.slice(patchPrefixCandidateMatch.index);
            }
            break;
          }
        }

        // Tạm hoãn emit nếu đuôi buffer kết thúc bằng dấu backticks dở dang (chờ xem có phải code fence mở/đóng)
        const trailingTickMatch = this.buffer.match(/`{1,5}$/);
        if (trailingTickMatch && trailingTickMatch.index !== undefined) {
          if (trailingTickMatch.index > 0) {
            emittedText += this.buffer.slice(0, trailingTickMatch.index);
            this.buffer = this.buffer.slice(trailingTickMatch.index);
          }
          break;
        }

        emittedText += this.buffer;
        this.buffer = "";
        break;
      } else if (this.inThought) {
        // Đang trong khối suy nghĩ nội tâm, tìm thẻ đóng </thought> hoặc </thinking>
        const thoughtCloseMatch = this.buffer.match(/<\s*\/\s*(?:thought|thinking)\s*>/i);
        if (thoughtCloseMatch && thoughtCloseMatch.index !== undefined) {
          this.thoughtContent += this.buffer.slice(0, thoughtCloseMatch.index);
          this.inThought = false;
          const afterClose = this.buffer.slice(thoughtCloseMatch.index + thoughtCloseMatch[0].length);
          this.buffer = afterClose.replace(/^\r?\n/, "");
          continue;
        }

        this.thoughtContent += this.buffer;
        this.buffer = "";
        break;
      } else if (this.inPatch) {
        // Đang trong khối patch, tìm *** End Patch hoặc \*\*\* End Patch (2 hoặc 3 dấu sao)
        const patchCloseMatch = this.buffer.match(/(?:\\?\*){2,3}\s*End Patch/i);
        if (patchCloseMatch && patchCloseMatch.index !== undefined) {
          const patchEndIndex = patchCloseMatch.index + patchCloseMatch[0].length;
          this.patchContent += this.buffer.slice(0, patchEndIndex);
          this.inPatch = false;
          this.buffer = this.buffer.slice(patchEndIndex);

          const cleanPatch = sanitizeCodexPatchContent(this.patchContent);

          this.detectedToolCall = {
            name: "apply_patch",
            arguments: { input: cleanPatch },
          };
          break;
        }

        this.patchContent += this.buffer;
        this.buffer = "";
        break;
      } else {
        // Đang trong khối tool call, tìm thẻ đóng </tool_call>, /tool_call>, </custom_tool_call>
        const closeMatch = this.buffer.match(/(?:<\s*\/|\/\s*)(?:custom[\\_]*)?tool[\\_]*call\s*>/i);
        if (closeMatch && closeMatch.index !== undefined) {
          this.toolContent += this.buffer.slice(0, closeMatch.index);
          this.inToolCall = false;
          this.buffer = this.buffer.slice(closeMatch.index + closeMatch[0].length);

          const toolCall = this.parseToolPayload(this.toolContent);
          if (toolCall) {
            this.detectedToolCall = toolCall;
            break;
          }
          continue;
        }

        this.toolContent += this.buffer;
        this.buffer = "";
        break;
      }
    }

    return emittedText;
  }

  /**
   * Kết thúc lượt stream: flush các phần còn lại.
   * Yêu cầu 4 & 5: TUYỆT ĐỐI KHÔNG thực thi tool call khi thẻ mở chưa có thẻ đóng
   * hoặc khi JSON arguments chưa hoàn chỉnh!
   */
  finish(): { remainingText: string; toolCall: ParsedToolCall | null; detectedToolCall?: ParsedToolCall } {
    logFunctionInput("translation:toolcall-detector", "finish");
    let remainingText = "";
    if (this.inThought) {
      this.thoughtContent += this.buffer;
      this.buffer = "";
      this.inThought = false;
    }

    if (!this.inToolCall && !this.inPatch && !this.detectedToolCall) {
      remainingText = this.buffer;
      this.buffer = "";
    } else if (this.inToolCall && !this.detectedToolCall) {
      // Thẻ <tool_call> chưa đóng -> Stream bị ngắt giữa JSON arguments.
      // Không được tự sửa hay thực thi dở dang!
      remainingText = `<tool_call>${this.toolContent}${this.buffer}`;
      this.toolContent = "";
      this.buffer = "";
    } else if (this.inPatch && !this.detectedToolCall) {
      // Khối patch chưa có *** End Patch -> Dở dang, không thực thi.
      remainingText = `${this.patchContent}${this.buffer}`;
      this.patchContent = "";
      this.buffer = "";
    }

    // Làm sạch trailing backticks dở dang ở cuối câu trả lời nếu có
    remainingText = remainingText.replace(/(?:\r?\n\s*)?`{1,5}\s*$/g, "").trimEnd();

    return {
      remainingText,
      toolCall: this.detectedToolCall,
      detectedToolCall: this.detectedToolCall ?? undefined,
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
    logFunctionInput("translation:toolcall-detector", "processChunk", { chunk });
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
    logFunctionInput("translation:toolcall-detector", "hasDetectedToolCall");
    return this.detectedToolCall !== null;
  }

    /**
   * Lấy thông tin tool call hoàn chỉnh đã phát hiện được.
   */
getToolCall(): ParsedToolCall | null {
    logFunctionInput("translation:toolcall-detector", "getToolCall");
    return this.detectedToolCall;
  }

  /**
   * Tự động chuẩn hóa các ký tự điều khiển thô (raw newline, carriage return, tab)
   * nằm bên trong string literal của JSON để JSON.parse không bị lỗi Bad control character.
   * Đồng thời tự động khử dấu \ thừa ở cuối dòng trước khi xuống dòng (line continuation).
   */
  private cleanToolPayload(raw: string): string {
    logFunctionInput("translation:toolcall-detector", "cleanToolPayload", { raw });
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
    logFunctionInput("translation:toolcall-detector", "parseToolPayload", { raw });
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
  logFunctionInput("translation:toolcall-detector", "sanitizeJsonControlChars", { raw });
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
        // Nếu ký tự trước là '\' nhưng ký tự hiện tại không phải là escape sequence hợp lệ trong JSON:
        // Cụ thể là các ký tự do Turndown/Markdown vô tình escape: '[', ']', '{', '}', '*', '_'
        if (escaped && /^[\[\]{}*_~]/.test(ch)) {
          if (out.endsWith("\\")) {
            out = out.slice(0, -1);
          }
          out += ch;
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
  logFunctionInput("translation:toolcall-detector", "stripOuterCodeFence", { raw });
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
  logFunctionInput("translation:toolcall-detector", "sanitizeCodexPatchContent", { rawPatch });
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

  return patch.trim();
}

export { chatGptHtmlToMarkdown };
