import { m365HtmlToMarkdown, normalizeMarkdownFences } from "./html-to-markdown";

export interface SemanticMarkdownBlock {
  key: string;
  tag: string;
  html: string;
  text: string;
  streamable: boolean;
}

export type M365MarkdownBlock = SemanticMarkdownBlock;

/**
 * SemanticMarkdownBuffer quản lý luồng streaming append-only của Web Chat Bot
 * 1. Phân rã nội dung câu trả lời thành từng khối ngữ nghĩa độc lập (paragraphs, headings, code blocks, lists).
 * 2. Chỉ commit và emit các khối đã hoàn thành (khi khối tiếp theo xuất hiện hoặc turn kết thúc).
 * 3. Tuyệt đối không stream dở dang khối code block để tránh gãy vỡ cú pháp Markdown (fences).
 * 4. Đảm bảo tính toán vẹn và không bao giờ bị lệch chỉ mục chuỗi (index offset misalignment).
 */
export class SemanticMarkdownBuffer {
  private readonly committedKeys = new Set<string>();
  private markdown = "";
  private pendingBlocks: SemanticMarkdownBlock[] = [];

  constructor(
    private readonly htmlToMarkdownFn: (html: string) => string = (html) => html,
    private readonly transform: (md: string) => string = md => md
  ) { }

  /**
   * Quan sát danh sách các khối ngữ nghĩa hiện tại trong DOM.
   */
  observe(blocks: SemanticMarkdownBlock[]): string {
    this.pendingBlocks = blocks;
    let delta = "";

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (this.committedKeys.has(block.key)) {
        continue;
      }

      // Khối hiện tại chưa hoàn thành -> dừng lại chờ
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
   * Kết thúc lượt sinh phản hồi từ Bot.
   */
  finish(finalBlocks?: SemanticMarkdownBlock[]): { markdown: string; delta: string } {
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

  private commitBlock(block: SemanticMarkdownBlock): string {
    let rawMd: string;
    if (
      /<\s*tool[\\_]*call\s*>/i.test(block.text) ||
      /(?:\\?\*){2,3}\s*Begin Patch/i.test(block.text)
    ) {
      rawMd = block.text.trim();
    } else {
      rawMd = this.htmlToMarkdownFn(block.html).trim();
    }
    const cleanMd = this.transform(rawMd).trim();
    this.committedKeys.add(block.key);

    if (!cleanMd) return "";

    const separator = this.markdown ? "\n\n" : "";
    const delta = `${separator}${cleanMd}`;
    this.markdown += delta;
    return delta;
  }
}

export class M365MarkdownBuffer extends SemanticMarkdownBuffer {
  constructor(transform: (md: string) => string = md => md) {
    super(m365HtmlToMarkdown, (md) => normalizeMarkdownFences(transform(md)));
  }
}
