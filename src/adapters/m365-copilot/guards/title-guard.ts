import type { CodexParsedRequest } from "../../../types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => {
      if (typeof part === "string") return part;
      const record = asRecord(part);
      return typeof record?.text === "string" ? record.text : "";
    })
    .join(" ");
}

function hasLegacyToolInput(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some(item => {
    const record = asRecord(item);
    return record?.role === "tool" || record?.type === "tool_result";
  });
}

/**
 * Cờ kiểm tra tính năng Title Guard có đang được bật hay không.
 * MẶC ĐỊNH: DISABLED (false) để triệt tiêu hoàn toàn nguy cơ can thiệp nhầm vào luồng chat của Codex.
 * Có thể bật lại bằng cách:
 * - Đặt biến môi trường M365_ENABLE_TITLE_GUARD="true" (hoặc ENABLE_TITLE_GUARD="true")
 * - Hoặc truyền options { enableTitleGuard: true }
 */
export function isTitleGuardEnabled(customFlag?: boolean): boolean {
  if (typeof customFlag === "boolean") {
    return customFlag;
  }
  const envVal = process.env.M365_ENABLE_TITLE_GUARD || process.env.CODEX_M365_ENABLE_TITLE_GUARD || process.env.ENABLE_TITLE_GUARD;
  return envVal === "true" || envVal === "1";
}

/**
 * Kiểm tra xem request có phải là request sinh tiêu đề (Title Request) ngầm của Codex hay không.
 * RÀNG BUỘC AN TOÀN:
 * 0. MẶC ĐỊNH DISABLED: Chỉ hoạt động khi có cờ bật rõ ràng (isTitleGuardEnabled).
 * 1. TUYỆT ĐỐI KHÔNG đánh chặn nếu request có toolResults hoặc đang thực thi công cụ.
 * 2. TUYỆT ĐỐI KHÔNG kiểm tra trên compiledPrompt vì compiledPrompt chứa System Prompt,
 *    danh sách công cụ (có 'description') và các template mã nguồn (có thẻ '<title>').
 * 3. Chỉ kiểm tra trực tiếp trên tin nhắn của người dùng hoặc chỉ thị developer cụ thể của lượt này.
 */
export function isTitleRequest(
  parsed: CodexParsedRequest,
  _compiledPrompt: string,
  options?: { enableTitleGuard?: boolean }
): boolean {


  // 0. CỜ BẬT TẮT: Mặc định DISABLED (false). Trả về false ngay lập tức nếu không được bật tường minh!
  if (!isTitleGuardEnabled(options?.enableTitleGuard)) {
    return false;
  }

  // 1. Nếu có tool results (kết quả đọc file, chạy lệnh terminal từ IDE) -> Chắc chắn KHÔNG PHẢI Title Request
  const parsedRecord = parsed as unknown as Record<string, unknown>;
  const contextRecord = asRecord(parsedRecord.context);
  const legacyToolResults = contextRecord?.toolResults;
  if (
    (Array.isArray(legacyToolResults) && legacyToolResults.length > 0) ||
    parsed.context.messages.some(message => message.role === "toolResult") ||
    hasLegacyToolInput(parsedRecord.input)
  ) {
    return false;
  }

  // 2. Trích xuất nội dung yêu cầu cụ thể của lượt này từ tin nhắn người dùng hoặc developer
  const legacyMessages = Array.isArray(parsedRecord.messages)
    ? parsedRecord.messages
    : [];
  const allMessages: unknown[] = parsed.context.messages.length > 0
    ? parsed.context.messages
    : legacyMessages;
  const userMessages = allMessages.filter(message => asRecord(message)?.role === "user");
  const lastUserMsgObj = userMessages.length > 0 ? userMessages[userMessages.length - 1] : undefined;
  const lastUserMsg = contentToText(asRecord(lastUserMsgObj)?.content).toLowerCase();

  const devMessages = allMessages.filter(message => {
    const role = asRecord(message)?.role;
    return role === "developer" || role === "system";
  });
  const lastDevMsgObj = devMessages.length > 0 ? devMessages[devMessages.length - 1] : undefined;
  const lastDevMsg = contentToText(asRecord(lastDevMsgObj)?.content).toLowerCase();

  // Chỉ xét nội dung trực tiếp của lượt hiện tại. Không nhập context.systemPrompt
  // vì trường này có thể chứa bootstrap protocol hoặc ví dụ "title:" từ phiên.
  const specificText = `${lastUserMsg} ${lastDevMsg}`.trim();
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

  // Trích xuất từ khoá nếu có
  let subject = "Coding Session";
  const match = compiledPrompt.match(/(?:xây dựng|tạo|viết|sửa|debug|tích hợp|hướng dẫn|hàm|file|module)\s+([^.,\n]+)/i);
  if (match && match[1]) {
    subject = match[1].trim().slice(0, 30);
  }

  return `title: M365 - ${subject}\ndescription: Phiên lập trình với M365 Copilot`;
}
