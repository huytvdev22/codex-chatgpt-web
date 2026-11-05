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
 * M365MarkdownBuffer quản lý luồng streaming append-only theo khối ngữ nghĩa:
 * 1. Phân rã nội dung câu trả lời thành từng khối ngữ nghĩa độc lập (paragraphs, headings, code blocks, lists).
 * 2. Chỉ commit và emit các khối đã hoàn thành (khi khối tiếp theo xuất hiện hoặc turn kết thúc).
 * 3. Tuyệt đối không stream dở dang khối code block để tránh gãy vỡ cú pháp Markdown (fences).
 * 4. Đảm bảo tính toàn vẹn và không bao giờ bị lệch chỉ mục chuỗi (index offset misalignment).
 */
export class M365MarkdownBuffer {
  private readonly committedKeys = new Set<string>();
  private markdown = "";
  private pendingBlocks: M365MarkdownBlock[] = [];

  constructor(
    private readonly transform: (md: string) => string = md => md,
  ) {}

  observe(blocks: M365MarkdownBlock[]): string {
    this.pendingBlocks = blocks;
    let delta = "";

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (this.committedKeys.has(block.key)) {
        continue;
      }

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

  finish(finalBlocks?: M365MarkdownBlock[]): { markdown: string; delta: string } {
    const blocks =
      finalBlocks && finalBlocks.length > 0 ? finalBlocks : this.pendingBlocks;
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
