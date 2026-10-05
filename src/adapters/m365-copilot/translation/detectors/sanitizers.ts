import { logFunctionInput } from "../../debug-logger";
import { stripOuterCodeFence } from "../../temp-chat/stripCodeFence";

export { stripOuterCodeFence };

/**
 * Sinh ngẫu nhiên mã ID duy nhất cho một tool call vừa phát hiện.
 */
export function generateToolCallId(): string {
  logFunctionInput("translation:detectors:sanitizers", "generateToolCallId");
  return `call_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/**
 * Chuẩn hóa tên tool: Tự động loại bỏ tiền tố "functions." nếu có
 */
export function normalizeToolName(name: string): string {
  logFunctionInput("translation:detectors:sanitizers", "normalizeToolName", { name });
  if (typeof name === "string" && name.startsWith("functions.")) {
    return name.slice("functions.".length);
  }
  return name;
}

/**
 * Tự động cân bằng dấu đóng ngoặc nhọn JSON nếu bị thiếu do Markdown hoặc DOM cắt dở
 */
export function balanceJsonBraces(raw: string): string {
  logFunctionInput("translation:detectors:sanitizers", "balanceJsonBraces", { raw });
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
 * 2. Khôi phục các ký tự bị Markdown/Turndown escape không hợp lệ trong cú pháp JSON
 *    (ví dụ: "run\_command" -> "run_command", "\[n\]" -> "[n]", "\*" -> "*").
 *    Trong JSON, chỉ có các escape: \" \\ \/ \b \f \n \r \t \uXXXX là hợp lệ.
 * 3. Tự động cân bằng ngoặc nhọn nếu mô hình mở nhiều hơn đóng.
 */
export function cleanJsonPayload(raw: string): string {
  logFunctionInput("translation:detectors:sanitizers", "cleanJsonPayload", { raw });
  const stripped = stripOuterCodeFence(raw);
  const unescaped = stripped.replace(/\\([_\[\]*~`>#+\-.!|{}()])/g, "$1");
  return balanceJsonBraces(unescaped);
}

/**
 * Chuẩn hóa khối patch Codex (khôi phục các ký tự bị escape bởi Markdown/Turndown)
 */
export function normalizePatchEnvelope(raw: string): string {
  logFunctionInput("translation:detectors:sanitizers", "normalizePatchEnvelope", { raw });
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
