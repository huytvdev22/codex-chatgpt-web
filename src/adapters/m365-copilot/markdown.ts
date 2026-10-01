import { chatGptHtmlToMarkdown } from "../chatgpt-web/markdown";

const STATUS_PATTERNS = [
  /^(?:Taking a look|Checking that now|Getting things ready|Digging in|Working on it|Searching the web|Searching work data|Searching|Thinking|Generating response|Putting it together|Putting things together|Gathering thoughts|Looking through your files)[.…\s]*/i,
  /^(?:Đang xem xét|Đang kiểm tra|Đang chuẩn bị|Đang tìm kiếm|Đang đào sâu|Đang xử lý|Đang suy nghĩ|Đang tạo câu trả lời|Đang tổng hợp)[.…\s]*/i,
];

/**
 * Chuyển đổi HTML của tin nhắn Microsoft 365 Copilot thành Markdown chuẩn
 * Kế thừa và tái sử dụng toàn bộ logic markdown (preservation tags, file paths, wiki links) từ chatGptHtmlToMarkdown
 */
/**
 * Tự động chuẩn hóa các code fence bị lỗi định dạng Markdown (như cụt 2 backtick hoặc lẻ loi 1 backtick)
 */
export function normalizeMarkdownFences(md: string): string {
  if (!md) return "";

  // Sửa các dòng chỉ chứa đúng 2 dấu backtick thành 3 dấu backtick chuẩn
  let fixed = md.replace(/^([ \t]*)``([ \t]*)$/gm, "$1```$2");

  // Sửa các code fence bị cụt 2 backtick có kèm tên ngôn ngữ (ví dụ ``plain -> ```plain)
  fixed = fixed.replace(/^([ \t]*)``([a-zA-Z0-9_-]+[ \t]*)$/gm, "$1```$2");

  // Sửa dòng kết thúc bằng 1 backtick lẻ loi đứng riêng sau nội dung
  fixed = fixed.replace(/^([ \t]*)`([ \t]*)$/gm, "$1```$2");

  return fixed;
}

export function m365HtmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return "";
  let md = chatGptHtmlToMarkdown(html).trim();

  // Dọn dẹp tiền tố "Copilot said:" hoặc "Copilot:"
  md = md.replace(/^Copilot(?: said)?:\s*/i, "").trim();

  // Dọn dẹp các cụm từ status/thinking nếu còn sót ở đầu phản hồi
  for (const pattern of STATUS_PATTERNS) {
    md = md.replace(pattern, "").trim();
  }

  // Dọn dẹp lại lần nữa nếu tiền tố Copilot said nằm trước status hoặc ngược lại
  md = md.replace(/^Copilot(?: said)?:\s*/i, "").trim();

  md = normalizeMarkdownFences(md);
  return md;
}

export interface M365MarkdownBlock {
  key: string;
  tag: string;
  html: string;
  text: string;
  streamable: boolean;
}

/**
 * M365MarkdownBuffer quản lý luồng streaming append-only của Microsoft 365 Copilot
 * Kế thừa nguyên lý Semantic Block Buffering của ChatGPT:
 * 1. Phân rã nội dung câu trả lời thành từng khối ngữ nghĩa độc lập (paragraphs, headings, code blocks, lists).
 * 2. Chỉ commit và emit các khối đã hoàn thành (khi khối tiếp theo xuất hiện hoặc turn kết thúc).
 * 3. Tuyệt đối không stream dở dang khối code block để tránh gãy vỡ cú pháp Markdown (fences).
 * 4. Đảm bảo tính toán vẹn và không bao giờ bị lệch chỉ mục chuỗi (index offset misalignment).
 */
export class M365MarkdownBuffer {
  private readonly committedKeys = new Set<string>();
  private markdown = "";
  private pendingBlocks: M365MarkdownBlock[] = [];

  constructor(
    private readonly transform: (md: string) => string = md => md
  ) {}

  /**
   * Quan sát danh sách các khối ngữ nghĩa hiện tại trong DOM.
   * Duyệt tuần tự an toàn tuyệt đối theo Semantic Key:
   * Bỏ qua các block đã commit; khi gặp block chưa streamable thì dừng lại chờ;
   * Không phụ thuộc vào committedIndex đơn điệu để tránh nhảy cóc khi danh sách block bị co giãn.
   */
  observe(blocks: M365MarkdownBlock[]): string {
    this.pendingBlocks = blocks;
    let delta = "";

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (this.committedKeys.has(block.key)) {
        continue;
      }

      // Khối hiện tại chưa hoàn thành (đang là khối cuối cùng hoặc đang sinh) -> dừng lại chờ
      if (!block.streamable) {
        break;
      }

      const blockDelta = this.commitBlock(block);
      if (blockDelta) {
        delta += blockDelta;
      }
    }

    return delta;
  }

  /**
   * Kết thúc lượt sinh phản hồi từ Copilot.
   * Commit toàn bộ các khối còn lại chưa từng được commit.
   */
  finish(finalBlocks?: M365MarkdownBlock[]): { markdown: string; delta: string } {
    const blocks = (finalBlocks && finalBlocks.length > 0) ? finalBlocks : this.pendingBlocks;
    let delta = "";

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (!this.committedKeys.has(block.key)) {
        const blockDelta = this.commitBlock(block);
        if (blockDelta) {
          delta += blockDelta;
        }
      }
    }

    this.pendingBlocks = [];
    return { markdown: this.markdown, delta };
  }

  getMarkdown(): string {
    return this.markdown;
  }

  private commitBlock(block: M365MarkdownBlock): string {
    const rawMd = m365HtmlToMarkdown(block.html).trim();
    const cleanMd = normalizeMarkdownFences(this.transform(rawMd).trim());
    this.committedKeys.add(block.key);

    if (!cleanMd) return "";

    const separator = this.markdown ? "\n\n" : "";
    const delta = `${separator}${cleanMd}`;
    this.markdown += delta;
    return delta;
  }
}

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
  private detectedToolCall: ParsedToolCall | null = null;

  /**
   * Đưa chunk mới vào detector.
   * Trả về text thông thường an toàn để emit text_delta (nếu không thuộc tool_call).
   */
  feed(chunk: string): string {
    if (this.detectedToolCall) return "";
    this.buffer += chunk;

    let emittedText = "";

    while (this.buffer.length > 0) {
      if (!this.inToolCall) {
        // Tìm thẻ mở <tool_call> hoặc <tool\_call>
        const openMatch = this.buffer.match(/<\s*tool[\\_]*call\s*>/i);
        if (openMatch && openMatch.index !== undefined) {
          if (openMatch.index > 0) {
            const prefix = this.buffer.slice(0, openMatch.index);
            const cleanPrefix = prefix.replace(/```(?:xml|json)?/gi, "").trim();
            if (cleanPrefix) {
              emittedText += cleanPrefix;
            }
          }
          this.inToolCall = true;
          this.buffer = this.buffer.slice(openMatch.index + openMatch[0].length);
          continue;
        }

        // Tạm hoãn emit nếu buffer chỉ là code fence ``` hoặc ```xml để chờ thẻ <tool_call>
        const trimmed = this.buffer.trim();
        if (/^```(?:xml|json)?$/i.test(trimmed)) {
          break;
        }

        // Kiểm tra xem đuôi buffer có thể là tiền tố dở dang của thẻ mở không
        const possiblePrefixMatch = this.buffer.match(/<[^>]*$/);
        if (possiblePrefixMatch && possiblePrefixMatch.index !== undefined) {
          const prefixCandidate = possiblePrefixMatch[0].toLowerCase();
          const targetPrefix = "<tool_call>";
          const targetPrefixAlt = "<tool\\_call>";
          if (targetPrefix.startsWith(prefixCandidate) || targetPrefixAlt.startsWith(prefixCandidate)) {
            if (possiblePrefixMatch.index > 0) {
              emittedText += this.buffer.slice(0, possiblePrefixMatch.index);
              this.buffer = this.buffer.slice(possiblePrefixMatch.index);
            }
            break;
          }
        }

        emittedText += this.buffer;
        this.buffer = "";
        break;
      } else {
        // Đang trong khối tool call, tìm thẻ đóng </tool_call> hoặc </tool\_call>
        const closeMatch = this.buffer.match(/<\s*\/tool[\\_]*call\s*>/i);
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
   * Kết thúc lượt stream: flush các phần còn lại nếu không phải tool call hoặc parse fallback.
   */
  finish(): { remainingText: string; toolCall: ParsedToolCall | null } {
    let remainingText = "";
    if (!this.inToolCall && !this.detectedToolCall) {
      remainingText = this.buffer;
      this.buffer = "";
    } else if (this.inToolCall && !this.detectedToolCall) {
      this.toolContent += this.buffer;
      this.buffer = "";
      const toolCall = this.parseToolPayload(this.toolContent);
      if (toolCall) {
        this.detectedToolCall = toolCall;
      } else {
        remainingText = `<tool_call>${this.toolContent}`;
      }
    }
    return { remainingText, toolCall: this.detectedToolCall };
  }

  hasDetectedToolCall(): boolean {
    return this.detectedToolCall !== null;
  }

  getToolCall(): ParsedToolCall | null {
    return this.detectedToolCall;
  }

  /**
   * Tự động chuẩn hóa các ký tự điều khiển thô (raw newline, carriage return, tab)
   * nằm bên trong string literal của JSON để JSON.parse không bị lỗi Bad control character.
   * Đồng thời tự động khử dấu \ thừa ở cuối dòng trước khi xuống dòng (line continuation).
   */
  private sanitizeJsonControlChars(raw: string): string {
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
   * Chuẩn hóa làm sạch khối tool payload trước khi phân tích cú pháp:
   * Khôi phục toàn bộ các ký tự bị Turndown / Markdown vô tình escape
   */
  private cleanToolPayload(raw: string): string {
    return raw
      .replace(/```(?:json)?/gi, "")
      .replace(/```/g, "")
      .replaceAll("\\_", "_")
      .replaceAll("\\*", "*")
      .replaceAll("\\[", "[")
      .replaceAll("\\]", "]")
      .replaceAll("\\{", "{")
      .replaceAll("\\}", "}")
      .replaceAll("\\~", "~")
      .trim();
  }

  /**
   * Fallback trích xuất tool call bằng Regex nếu JSON.parse vẫn thất bại
   */
  private fallbackExtractToolCall(raw: string): ParsedToolCall | null {
    const nameMatch = raw.match(/"name"\s*:\s*"([^"]+)"/i);
    if (!nameMatch) return null;
    const name = nameMatch[1].trim();

    if (name === "write_file") {
      const pathMatch = raw.match(/"path"\s*:\s*"([^"]+)"/i);
      const contentMatch = raw.match(/"content"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"|\}\s*\}|\}\s*$)/);
      if (pathMatch) {
        return {
          name,
          arguments: {
            path: pathMatch[1].trim(),
            content: contentMatch ? contentMatch[1] : "",
          },
        };
      }
    }

    if (name === "run_command") {
      const cmdMatch = raw.match(/"cmd"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"|\}\s*\}|\}\s*$)/i);
      if (cmdMatch) {
        return {
          name,
          arguments: { cmd: cmdMatch[1].trim() },
        };
      }
    }

    const pathMatch = raw.match(/"path"\s*:\s*"([^"]+)"/i);
    if (pathMatch) {
      return {
        name,
        arguments: { path: pathMatch[1].trim() },
      };
    }

    return {
      name,
      arguments: {},
    };
  }

  private parseToolPayload(raw: string): ParsedToolCall | null {
    const clean = this.cleanToolPayload(raw);

    // 1. Thử parse với sanitizer xử lý raw newlines/control characters và trailing backslash
    try {
      const sanitized = this.sanitizeJsonControlChars(clean);
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
        return {
          name,
          arguments: args,
        };
      }
    } catch {}

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
        return {
          name,
          arguments: args,
        };
      }
    } catch {}

    // 3. Fallback: trích xuất regex tự phục hồi nếu JSON bị format lỗi bởi LLM
    try {
      const fallback = this.fallbackExtractToolCall(clean);
      if (fallback) {
        return fallback;
      }
    } catch {}

    return null;
  }
}

export { chatGptHtmlToMarkdown };
