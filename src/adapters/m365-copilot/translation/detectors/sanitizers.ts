import { logFunctionInput } from "../../debug-logger";
import { stripOuterCodeFence } from "../../temp-chat/stripCodeFence";

export { stripOuterCodeFence };

/**
 * Sinh ngẫu nhiên mã ID duy nhất cho một tool call vừa phát hiện.
 */
export function generateToolCallId(): string {

  return `call_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/**
 * Chuẩn hóa tên tool: Tự động loại bỏ tiền tố "functions." nếu có
 */
export function normalizeToolName(name: string): string {

  if (typeof name === "string" && name.startsWith("functions.")) {
    return name.slice("functions.".length);
  }
  return name;
}

/**
 * Tự động cân bằng dấu đóng ngoặc nhọn JSON nếu bị thiếu do Markdown hoặc DOM cắt dở
 */
export function balanceJsonBraces(raw: string): string {

  let inString = false;
  let escaped = false;
  let openBraces = 0;
  let closeBraces = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"' && !escaped) {
      inString = !inString;
    } else if (!inString) {
      if (ch === "{") openBraces++;
      else if (ch === "}") closeBraces++;
    }
    escaped = (ch === "\\" && !escaped);
  }
  if (openBraces > closeBraces) {
    return raw + "}".repeat(openBraces - closeBraces);
  }
  return raw;
}

/**
 * Chuẩn hóa và làm sạch chuỗi JSON payload:
 * 1. Bóc outer code fence mà không xâm phạm code fence bên trong.
 * 2. Ưu tiên giữ nguyên vẹn 100% nếu chuỗi đã là JSON hợp lệ.
 * 3. Nếu parse lỗi, chỉ khôi phục các ký tự bị Markdown/Turndown escape ngoài ý muốn (_ * ~).
 *    TUYỆT ĐỐI KHÔNG khử escape dấu ngoặc đơn () hay các ký tự hợp lệ của shell script.
 * 4. Tự động cân bằng ngoặc nhọn nếu mô hình mở nhiều hơn đóng.
 */
export function cleanJsonPayload(raw: string): string {

  const stripped = stripOuterCodeFence(raw).trim();

  // Ưu tiên 1: Nếu chuỗi đã là JSON hợp lệ, giữ nguyên vẹn 100%
  try {
    JSON.parse(stripped);
    return stripped;
  } catch { }

  // Ưu tiên 2: Chỉ unescape các ký tự markdown thuần túy thường bị Turndown chèn vào (_ * ~ ` [ ])
  // Tránh unescape khi phía trước là ký tự backslash khác (tức là \\char cố ý của JSON)
  const unescaped = stripped.replace(/\\([_\[\]*~`>#+\-.!|{}])/g, (match, char, offset, fullStr) => {
    if (offset > 0 && fullStr[offset - 1] === "\\") {
      return match;
    }
    return char;
  });

  return balanceJsonBraces(unescaped);
}

/**
 * Chuẩn hóa khối patch Codex (khôi phục các ký tự bị escape bởi Markdown/Turndown)
 */
export function normalizePatchEnvelope(raw: string): string {

  let cleaned = raw
    .replaceAll("\\*", "*")
    .replaceAll("\\_", "_")
    .replaceAll("\\[", "[")
    .replaceAll("\\]", "]")
    .replaceAll("\\{", "{")
    .replaceAll("\\}", "}")
    .replaceAll("\\~", "~");

  if (cleaned.includes("\\n") && !cleaned.includes("\n")) {
    cleaned = cleaned.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
  }

  // Khử dấu gạch chéo ngược ở cuối dòng
  cleaned = cleaned.replace(/\\+[ \t]*(\r?\n)/g, "$1");

  return cleaned.trim();
}
