import { logFunctionInput } from "../debug-logger";
import { normalizeMarkdownFences, m365HtmlToMarkdown } from "./html-to-markdown";
export { m365HtmlToMarkdown };

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

  /**
 * Khởi tạo bộ đệm Markdown ngữ nghĩa quản lý commit các khối văn bản và code.
 */
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
    finish(finalBlocks ?: M365MarkdownBlock[]): { markdown: string; delta: string } {

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

    /**
   * Lấy toàn bộ nội dung Markdown hoàn chỉnh đã được tích lũy trong bộ đệm.
   */
    getMarkdown(): string {

      return this.markdown;
    }

    /**
   * Xử lý commit một khối Markdown đã hoàn tất vào chuỗi Markdown chính thức.
   */
private commitBlock(block: M365MarkdownBlock): string {

    // Nếu khối là khối công cụ hoặc patch, ưu tiên trích xuất textContent thuần túy (raw text)
    // để tránh việc Turndown tự động escape các ký tự cú pháp như _ thành \_, [ thành \[, * thành \*
    let rawMd: string;
    if (
      /<\s*tool[\\_]*call\s*>/i.test(block.text) ||
      /(?:\\?\*){2,3}\s*Begin Patch/i.test(block.text)
    ) {
      rawMd = block.text.trim();
    } else {
      rawMd = m365HtmlToMarkdown(block.html).trim();
    }
    const cleanMd = normalizeMarkdownFences(this.transform(rawMd).trim());
    this.committedKeys.add(block.key);

    if (!cleanMd) return "";

    const separator = this.markdown ? "\n\n" : "";
    const delta = `${separator}${cleanMd}`;
    this.markdown += delta;
    return delta;
  }
}
