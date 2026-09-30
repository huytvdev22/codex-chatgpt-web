import { chatGptHtmlToMarkdown } from "../chatgpt-web/markdown";

const STATUS_PATTERNS = [
  /^(?:Taking a look|Getting things ready|Digging in|Working on it|Searching the web|Searching work data|Searching|Thinking|Generating response)[.…\s]*/i,
  /^(?:Đang xem xét|Đang chuẩn bị|Đang tìm kiếm|Đang đào sâu|Đang xử lý|Đang suy nghĩ|Đang tạo câu trả lời)[.…\s]*/i,
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

export { chatGptHtmlToMarkdown };
