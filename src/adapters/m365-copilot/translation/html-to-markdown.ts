import { logFunctionInput } from "../debug-logger";
import { chatGptHtmlToMarkdown } from "../../chatgpt-web/markdown";
export { chatGptHtmlToMarkdown };

export const STATUS_PATTERNS = [
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

/**
 * Chuyển đổi cây HTML của tin nhắn M365 Copilot thành chuỗi Markdown chuẩn hóa.
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

  md = normalizeMarkdownFences(md);
  return md;
}
