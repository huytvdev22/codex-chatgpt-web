import { logFunctionInput } from "../debug-logger";
import type { CodexParsedRequest } from "../../../types";

/**
 * Kiểm tra xem request có phải là request sinh tiêu đề (Title Request) ngầm của Codex hay không.
 * RÀNG BUỘC AN TOÀN:
 * 1. TUYỆT ĐỐI KHÔNG đánh chặn nếu request có toolResults hoặc đang thực thi công cụ.
 * 2. TUYỆT ĐỐI KHÔNG kiểm tra trên compiledPrompt vì compiledPrompt chứa System Prompt,
 *    danh sách công cụ (có 'description') và các template mã nguồn (có thẻ '<title>').
 * 3. Chỉ kiểm tra trực tiếp trên tin nhắn của người dùng hoặc chỉ thị developer cụ thể của lượt này.
 */
export function isTitleRequest(parsed: CodexParsedRequest, compiledPrompt: string): boolean {
  logFunctionInput("guards:title-guard", "isTitleRequest", { parsed, compiledPrompt });

  // 1. Nếu có tool results (kết quả đọc file, chạy lệnh terminal từ IDE) -> Chắc chắn KHÔNG PHẢI Title Request
  if (
    (parsed.context?.toolResults && parsed.context.toolResults.length > 0) ||
    (parsed.input && parsed.input.some((item: any) => item.role === "tool" || item.type === "tool_result"))
  ) {
    return false;
  }

  // 2. Trích xuất nội dung yêu cầu cụ thể của lượt này từ tin nhắn người dùng hoặc developer
  const userMessages = parsed.messages?.filter(m => m.role === "user") || [];
  const lastUserMsg = userMessages.length > 0 ? (userMessages[userMessages.length - 1].content || "").toLowerCase() : "";
  const devMessages = parsed.messages?.filter(m => m.role === "developer" || m.role === "system") || [];
  const lastDevMsg = devMessages.length > 0 ? (devMessages[devMessages.length - 1].content || "").toLowerCase() : "";

  // Thêm kiểm tra từ context.systemPrompt nếu có
  const systemPrompts = (parsed.context?.systemPrompt || []).map(s => s.toLowerCase()).join(" ");

  const specificText = `${lastUserMsg} ${lastDevMsg} ${systemPrompts}`.trim();
  if (!specificText) return false;

  // 3. Chỉ nhận diện là Title Request khi YÊU CẦU CỤ THỂ thực sự là sinh tiêu đề và không có ý định code
  const isExplicitTitle =
    specificText.includes("generate a title") ||
    specificText.includes("generate a concise title") ||
    specificText.includes("short title for the conversation") ||
    specificText.includes("title for this session") ||
    specificText.includes("session title") ||
    specificText.includes("brief title") ||
    (specificText.includes("title:") && specificText.includes("description:") && specificText.length < 500);

  return Boolean(isExplicitTitle);
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
