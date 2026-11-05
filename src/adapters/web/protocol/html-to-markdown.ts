import { chatGptHtmlToMarkdown } from "../markdown";
export { chatGptHtmlToMarkdown };

export const STATUS_PATTERNS = [
  /^(?:Taking a look|Checking that now|Getting things ready|Digging in|Working on it|Searching the web|Searching work data|Searching|Thinking|Generating response|Putting it together|Putting things together|Gathering thoughts|Looking through your files)[.…\s]*/i,
  /^(?:Đang xem xét|Đang kiểm tra|Đang chuẩn bị|Đang tìm kiếm|Đang đào sâu|Đang xử lý|Đang suy nghĩ|Đang tạo câu trả lời|Đang tổng hợp)[.…\s]*/i,
];

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

export interface WebHtmlToMarkdownOptions {
  leadingPrefixes?: RegExp[];
  statusPatterns?: RegExp[];
}

/**
 * Chuyển đổi cây HTML của tin nhắn sang chuỗi Markdown chuẩn hóa dùng chung cho Web Adapter.
 */
export function webHtmlToMarkdown(
  html: string,
  options: WebHtmlToMarkdownOptions = {},
): string {
  if (!html || !html.trim()) return "";
  let md = chatGptHtmlToMarkdown(html).trim();

  const prefixes = options.leadingPrefixes ?? [];
  for (const prefix of prefixes) {
    md = md.replace(prefix, "").trim();
  }

  const statuses = options.statusPatterns ?? [];
  for (const pattern of statuses) {
    md = md.replace(pattern, "").trim();
  }

  for (const prefix of prefixes) {
    md = md.replace(prefix, "").trim();
  }

  return normalizeMarkdownFences(md);
}

/**
 * Chuyển đổi cây HTML của tin nhắn sang chuỗi Markdown chuẩn hóa (preset tương thích M365).
 */
export function m365HtmlToMarkdown(html: string): string {
  return webHtmlToMarkdown(html, {
    leadingPrefixes: [/^Copilot(?: said)?:\s*/i],
    statusPatterns: STATUS_PATTERNS,
  });
}
