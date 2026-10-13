import { stripOuterCodeFence } from "../core/strip-code-fence";

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
 * Chuẩn hóa các ký tự điều khiển trong chuỗi JSON trước khi phân tích
 */
export function sanitizeJsonControlChars(raw: string): string {
  let inString = false;
  let escaped = false;
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"' && !escaped) {
      inString = !inString;
      out += ch;
    } else if (inString) {
      if (ch === "\n") {
        if (escaped && out.endsWith("\\")) {
          out = out.slice(0, -1);
        }
        out += "\\n";
        escaped = false;
        continue;
      } else if (ch === "\r") {
        if (escaped && out.endsWith("\\")) {
          out = out.slice(0, -1);
        }
        out += "\\r";
        escaped = false;
        continue;
      } else if (ch === "\t") {
        out += "\\t";
      } else {
        if (escaped && !/^[\\/"bfnrtu]/.test(ch)) {
          out += "\\" + ch;
          escaped = false;
          continue;
        }
        out += ch;
      }
    } else {
      out += ch;
    }
    escaped = (ch === "\\" && !escaped);
  }
  return out;
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

  cleaned = cleaned.replace(/\\+[ \t]*(\r?\n)/g, "$1");
  return cleaned.trim();
}

/**
 * Chuẩn hóa và làm sạch triệt để khối Codex Patch:
 * 1. Bóc tách chính xác từ Begin Patch đến End Patch, loại bỏ hoàn toàn thẻ XML hoặc rác JSON ở đuôi.
 * 2. Chuẩn hóa header thành `*** Begin Patch` và footer thành `*** End Patch`.
 * 3. Tự động giải mã unescape \n literal nếu patch bị bọc trong chuỗi JSON/escape string.
 * 4. Gọt sạch các ký tự escape markdown thừa từ Turndown.
 */
export function sanitizeCodexPatchContent(rawPatch: string): string {
  let patch = rawPatch
    .replaceAll("\\*", "*")
    .replaceAll("\\_", "_")
    .replaceAll("\\[", "[")
    .replaceAll("\\]", "]")
    .replaceAll("\\{", "{")
    .replaceAll("\\}", "}")
    .replaceAll("\\~", "~");

  const beginMatch = patch.match(/\*{2,3}\s*Begin Patch/i);
  if (beginMatch && beginMatch.index !== undefined) {
    patch = patch.slice(beginMatch.index);
  }

  const endMatch = patch.match(/\*{2,3}\s*End Patch/i);
  if (endMatch && endMatch.index !== undefined) {
    patch = patch.slice(0, endMatch.index + endMatch[0].length);
  }

  patch = patch.replace(/^\*{2,3}\s*Begin Patch/i, "*** Begin Patch");
  patch = patch.replace(/\*{2,3}\s*End Patch$/i, "*** End Patch");

  const literalNewlineCount = (patch.match(/\\n/g) || []).length;
  const actualNewlineCount = (patch.match(/\n/g) || []).length;
  if (literalNewlineCount > 0 && (actualNewlineCount < 3 || literalNewlineCount > actualNewlineCount)) {
    patch = patch
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"');
  }

  return patch.trim();
}
