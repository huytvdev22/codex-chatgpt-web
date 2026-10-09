import { logFunctionInput } from "../../debug-logger";
import type { IToolCallDetector, DetectedToolCall } from "./types";
import { cleanJsonPayload, normalizeToolName } from "./sanitizers";
import { sanitizeJsonControlChars, sanitizeCodexPatchContent } from "../toolcall-detector";

/**
 * Bộ phát hiện XML Tool Call (Ưu tiên B)
 * Hỗ trợ nhiều thẻ <tool_call>...</tool_call> và <tool\_call>...</tool\_call>
 * TUYỆT ĐỐI KHÔNG thực thi khi chưa có thẻ đóng hợp lệ.
 */
export class XmlToolCallDetector implements IToolCallDetector {
  readonly priority = 2;
  readonly name = "XmlToolCallDetector";

  /**
 * Phát hiện các thẻ XML <tool_call> trong văn bản phản hồi.
 */
  detect(rawResponse: string): DetectedToolCall[] | DetectedToolCall | null {

    if (!rawResponse || !rawResponse.trim()) return null;

    const allCalls: DetectedToolCall[] = [];

    // 1. Tìm tất cả các thẻ <custom_tool_call name="...">...</custom_tool_call> (hỗ trợ cả custom_tool_call>)
    const customMatches = [...rawResponse.matchAll(/(?:<|\b)\s*custom[\\_]*tool[\\_]*call(?:\s+name=["']([^"']+)["'])?\s*>([\s\S]*?)(?:<\s*\/|\/\s*)custom[\\_]*tool[\\_]*call\s*>/gi)];
    for (const m of customMatches) {
      const name = m[1] || (m[2].includes("Begin Patch") ? "apply_patch" : "custom_tool");
      if (name === "apply_patch" || m[2].includes("Begin Patch")) {
        const cleaned = sanitizeCodexPatchContent(m[2]);
        allCalls.push({ name: "apply_patch", arguments: { input: cleaned } });
      } else {
        allCalls.push({ name, arguments: { input: m[2].trim() } });
      }
    }

    // 2. Tìm tất cả các cặp thẻ: <tool_call>...</tool_call>, tool_call>...</tool_call> hoặc /tool_call>
    const matches = [...rawResponse.matchAll(/(?:<|\b)\s*tool[\\_]*call\s*>([\s\S]*?)(?:<\s*\/|\/\s*)tool[\\_]*call\s*>/gi)];
    for (const m of matches) {
      const item = this.parseInnerXml(m[1]);
      if (item) allCalls.push(item);
    }

    if (allCalls.length > 0) {
      return allCalls.length === 1 ? allCalls[0] : allCalls;
    }

    // Nếu không có thẻ đóng, tool call chưa hoàn chỉnh -> Không được thực thi
    return null;
  }

  /**
 * Phân giải nội dung bên trong thẻ XML <tool_call> thành tên công cụ và tham số.
 */
  private parseInnerXml(innerContent: string): DetectedToolCall | null {

    const trimmed = innerContent.trim();

    // 0. Ưu tiên cao nhất: Thử parse trực tiếp JSON gốc nguyên bản không qua bất kỳ sanitizer nào
    try {
      const directParsed = JSON.parse(trimmed);
      if (directParsed && typeof directParsed === "object") {
        const rawName = typeof directParsed.name === "string" ? directParsed.name : (directParsed.tool || "read_file");
        const name = normalizeToolName(rawName);
        let args = directParsed.arguments || directParsed.args || {};
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch { args = { path: args }; }
        } else if (Object.keys(args).length === 0) {
          if (directParsed.path) args = { path: directParsed.path };
          else if (directParsed.cmd) args = { cmd: directParsed.cmd };
          else if (directParsed.input) args = { input: directParsed.input };
          else if (directParsed.patch) args = { input: directParsed.patch };
          else if (directParsed.questions) args = { questions: directParsed.questions };
          else if (directParsed.question) args = { question: directParsed.question, options: directParsed.options, header: directParsed.header };
        }
        if (name === "write_file") {
          if (!args || typeof args !== "object" || !args.path || args.content === undefined) {
            return null;
          }
        }
        if (name === "apply_patch" && args && typeof args === "object") {
          const rawP = args.input || args.patch;
          if (typeof rawP === "string") {
            args = { input: sanitizeCodexPatchContent(rawP) };
          }
        }
        if (name === "exec_command" && args && typeof args === "object") {
          const cmd = args.cmd || args.command || "";
          args.cmd = String(cmd);
        }
        return { name, arguments: args };
      }
    } catch { }

    const clean = cleanJsonPayload(innerContent);

    // 1. Thử parse với sanitizer xử lý raw newlines/control characters
    try {
      const sanitized = sanitizeJsonControlChars(clean);
      const parsed = JSON.parse(sanitized);
      if (parsed && typeof parsed === "object") {
        const rawName = typeof parsed.name === "string" ? parsed.name : (parsed.tool || "read_file");
        const name = normalizeToolName(rawName);
        let args = parsed.arguments || parsed.args || {};
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch { args = { path: args }; }
        } else if (Object.keys(args).length === 0) {
          if (parsed.path) args = { path: parsed.path };
          else if (parsed.cmd) args = { cmd: parsed.cmd };
          else if (parsed.input) args = { input: parsed.input };
          else if (parsed.patch) args = { input: parsed.patch };
          else if (parsed.questions) args = { questions: parsed.questions };
          else if (parsed.question) args = { question: parsed.question, options: parsed.options, header: parsed.header };
        }

        // Kiểm tra tính hoàn chỉnh bắt buộc cho write_file
        if (name === "write_file") {
          if (!args || typeof args !== "object" || !args.path || args.content === undefined) {
            return null;
          }
        }

        // Nếu là apply_patch, đảm bảo nội dung patch được làm sạch bằng sanitizeCodexPatchContent
        if (name === "apply_patch" && args && typeof args === "object") {
          const rawP = args.input || args.patch;
          if (typeof rawP === "string") {
            args = { input: sanitizeCodexPatchContent(rawP) };
          }
        }

        if (name === "exec_command" && args && typeof args === "object") {
          const cmd = args.cmd || args.command || "";
          args.cmd = String(cmd);
        }

        return { name, arguments: args };
      }
    } catch { }

    // 2. Thử parse nguyên bản
    try {
      const parsed = JSON.parse(clean);
      if (parsed && typeof parsed === "object") {
        const rawName = typeof parsed.name === "string" ? parsed.name : (parsed.tool || "read_file");
        const name = normalizeToolName(rawName);
        let args = parsed.arguments || parsed.args || {};
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch { args = { path: args }; }
        } else if (Object.keys(args).length === 0) {
          if (parsed.path) args = { path: parsed.path };
          else if (parsed.cmd) args = { cmd: parsed.cmd };
          else if (parsed.input) args = { input: parsed.input };
          else if (parsed.patch) args = { input: parsed.patch };
          else if (parsed.questions) args = { questions: parsed.questions };
          else if (parsed.question) args = { question: parsed.question, options: parsed.options, header: parsed.header };
        }

        if (name === "write_file") {
          if (!args || typeof args !== "object" || !args.path || args.content === undefined) {
            return null;
          }
        }

        if (name === "apply_patch" && args && typeof args === "object") {
          const rawP = args.input || args.patch;
          if (typeof rawP === "string") {
            args = { input: sanitizeCodexPatchContent(rawP) };
          }
        }

        if (name === "exec_command" && args && typeof args === "object") {
          const cmd = args.cmd || args.command || "";
          args.cmd = String(cmd);
        }

        return { name, arguments: args };
      }
    } catch { }

    // 3. Cứu hộ trường hợp apply_patch: JSON.parse thất bại vì unescaped quotes bên trong patch
    if (/\*{2,3}\s*Begin Patch/i.test(innerContent)) {
      const cleanedPatch = sanitizeCodexPatchContent(innerContent);
      if (cleanedPatch.includes("*** Begin Patch")) {
        return {
          name: "apply_patch",
          arguments: { input: cleanedPatch },
        };
      }
    }

    return null;
  }
}
