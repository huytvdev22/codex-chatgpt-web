import { logFunctionInput } from "../debug-logger";
import type { CodexParsedRequest } from "../../../types";

/**
 * Kiểm tra xem request có phải là request sinh tiêu đề (Title Request) ngầm của Codex hay không
 */
export function isTitleRequest(parsed: CodexParsedRequest, compiledPrompt: string): boolean {
  logFunctionInput("guards:title-guard", "isTitleRequest", { parsed, compiledPrompt });
  const p = compiledPrompt.toLowerCase();
  if (
    (p.includes("title:") && p.includes("description:")) ||
    p.includes("generate a title") ||
    p.includes("short title for the conversation") ||
    p.includes("title and description") ||
    p.includes("brief title") ||
    p.includes("session title")
  ) {
    return true;
  }

  // Kiểm tra thêm trong các systemPrompt hoặc developer messages
  if (parsed.context?.systemPrompt) {
    for (const sp of parsed.context.systemPrompt) {
      const lower = sp.toLowerCase();
      if (lower.includes("generate a title") || (lower.includes("title:") && lower.includes("description:"))) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Sinh nội dung phản hồi tiêu đề tức thì (5ms)
 */
export function generateTitleResponse(compiledPrompt: string): string {
  logFunctionInput("guards:title-guard", "generateTitleResponse", { compiledPrompt });
  // Trích xuất từ khoá nếu có
  let subject = "Coding Session";
  const match = compiledPrompt.match(/(?:xây dựng|tạo|viết|sửa|debug|tích hợp|hướng dẫn|hàm|file|module)\s+([^.,\n]+)/i);
  if (match && match[1]) {
    subject = match[1].trim().slice(0, 30);
  }

  return `title: M365 - ${subject}\ndescription: Phiên lập trình với M365 Copilot`;
}
