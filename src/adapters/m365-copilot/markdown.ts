import { chatGptHtmlToMarkdown } from "../chatgpt-web/markdown";

const STATUS_PATTERNS = [
  /^(?:Taking a look|Checking that now|Getting things ready|Digging in|Working on it|Searching the web|Searching work data|Searching|Thinking|Generating response)[.…\s]*/i,
  /^(?:Đang xem xét|Đang kiểm tra|Đang chuẩn bị|Đang tìm kiếm|Đang đào sâu|Đang xử lý|Đang suy nghĩ|Đang tạo câu trả lời)[.…\s]*/i,
];

/**
 * Chuyển đổi HTML của tin nhắn Microsoft 365 Copilot thành Markdown chuẩn
 * Kế thừa và tái sử dụng toàn bộ logic markdown (preservation tags, file paths, wiki links) từ chatGptHtmlToMarkdown
 */
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
   * Chỉ commit các khối đã hoàn tất (streamable = true) và chưa từng commit.
   */
  observe(blocks: M365MarkdownBlock[]): string {
    this.pendingBlocks = blocks;
    let delta = "";

    for (const block of blocks) {
      if (!block.streamable) continue;
      if (this.committedKeys.has(block.key)) continue;

      const blockDelta = this.commitBlock(block);
      if (blockDelta) {
        delta += blockDelta;
      }
    }

    return delta;
  }

  /**
   * Kết thúc lượt sinh phản hồi từ Copilot.
   * Commit và emit toàn bộ các khối còn lại trong buffer (bao gồm khối cuối cùng).
   */
  finish(): { markdown: string; delta: string } {
    let delta = "";
    for (const block of this.pendingBlocks) {
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
    const cleanMd = this.transform(rawMd).trim();
    this.committedKeys.add(block.key);

    if (!cleanMd) return "";

    const separator = this.markdown ? "\n\n" : "";
    const delta = `${separator}${cleanMd}`;
    this.markdown += delta;
    return delta;
  }
}

export { chatGptHtmlToMarkdown };
