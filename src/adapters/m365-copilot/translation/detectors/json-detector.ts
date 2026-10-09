import { logFunctionInput } from "../../debug-logger";
import type { IToolCallDetector, DetectedToolCall } from "./types";
import { cleanJsonPayload, normalizeToolName } from "./sanitizers";

/**
 * Bộ phát hiện JSON Tool Call (Ưu tiên A)
 * Hỗ trợ các định dạng:
 * 1. {"action": "tool_call", "tool": "read_file", "arguments": {"path": "pom.xml"}}
 * 2. {"name": "read_file", "arguments": {"path": "pom.xml"}}
 * 3. Mảng JSON [ {...}, {...} ] hoặc {"tool_calls": [ ... ]}
 * 4. Nằm trong code fence ```json ... ``` hoặc chuỗi JSON độc lập
 */
export class JsonToolCallDetector implements IToolCallDetector {
  readonly priority = 1;
  readonly name = "JsonToolCallDetector";

  /**
 * Phát hiện và trích xuất tool call dạng JSON trong phản hồi của mô hình.
 */
  detect(rawResponse: string): DetectedToolCall[] | DetectedToolCall | null {

    if (!rawResponse || !rawResponse.trim()) return null;

    // Không match nếu đang là XML tool_call để nhường cho XmlToolCallDetector nếu nằm trong thẻ
    if (/(?:<|\b)\s*tool[\\_]*call\s*>/i.test(rawResponse)) {
      return null;
    }

    // 1. Thử tìm khối code fence ```json ... ``` trước
    const fenceMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenceMatch) {
      const parsed = this.tryParseJson(fenceMatch[1]);
      if (parsed) return parsed;
    }

    // 2. Thử tìm mảng JSON [...]
    const arrayMatch = rawResponse.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      const parsed = this.tryParseJson(arrayMatch[0]);
      if (parsed) return parsed;
    }

    // 3. Thử tìm khối JSON Object {...} lớn nhất hoặc đầu tiên
    const objectMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      const parsed = this.tryParseJson(objectMatch[0]);
      if (parsed) return parsed;
    }

    return null;
  }

  /**
 * Thử phân tích một chuỗi văn bản thành đối tượng JSON hợp lệ.
 */
  private tryParseJson(jsonStr: string): DetectedToolCall[] | DetectedToolCall | null {

    try {
      const clean = cleanJsonPayload(jsonStr);
      const parsed = JSON.parse(clean);

      // Nếu là mảng JSON các tool calls: [ {...}, {...} ]
      if (Array.isArray(parsed)) {
        const calls: DetectedToolCall[] = [];
        for (const item of parsed) {
          const single = this.extractFromObject(item);
          if (single) calls.push(single);
        }
        if (calls.length > 0) return calls;
        return null;
      }

      if (parsed && typeof parsed === "object") {
        // Nếu chứa thuộc tính tool_calls: [ ... ]
        if (Array.isArray(parsed.tool_calls)) {
          const calls: DetectedToolCall[] = [];
          for (const item of parsed.tool_calls) {
            const single = this.extractFromObject(item);
            if (single) calls.push(single);
          }
          if (calls.length > 0) return calls;
        }

        return this.extractFromObject(parsed);
      }
    } catch {
      // Bỏ qua lỗi parse JSON
    }

    return null;
  }

  /**
 * Trích xuất thông tin tool name và arguments từ một đối tượng JSON đã parse.
 */
  private extractFromObject(obj: any): DetectedToolCall | null {

    if (!obj || typeof obj !== "object") return null;

    // TH1: { "action": "tool_call", "tool": "read_file", "arguments": { ... } }
    if (obj.action === "tool_call" && (obj.tool || obj.name)) {
      const toolName = normalizeToolName(String(obj.tool || obj.name));
      let args = obj.arguments || obj.args || obj.parameters || {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = { path: args }; }
      }
      return { name: toolName, arguments: args };
    }

    // TH2: { "name": "read_file", "arguments": { ... } }
    if (typeof obj.name === "string" && (obj.arguments !== undefined || obj.path !== undefined || obj.cmd !== undefined || obj.input !== undefined || obj.patch !== undefined)) {
      const toolName = normalizeToolName(obj.name);
      let args = obj.arguments || {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = { path: args }; }
      } else if (Object.keys(args).length === 0) {
        if (obj.path) args = { path: obj.path };
        else if (obj.cmd) args = { cmd: obj.cmd };
        else if (obj.input) args = { input: obj.input };
        else if (obj.patch) args = { input: obj.patch };
      }
      return { name: toolName, arguments: args };
    }

    // TH3: { "tool": "read_file", "path": "pom.xml" }
    if (typeof obj.tool === "string") {
      const toolName = normalizeToolName(obj.tool);
      const args = obj.arguments || { ...obj };
      delete (args as any).tool;
      delete (args as any).action;
      return { name: toolName, arguments: args };
    }

    return null;
  }
}
