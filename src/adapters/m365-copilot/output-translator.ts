import { BashCommandTranslator } from "./bash-translator";
import { sanitizeJsonControlChars, sanitizeCodexPatchContent } from "./markdown";
import { AtomicFileWriter } from "./atomic-file-writer";

export { sanitizeCodexPatchContent };

/**
 * Cấu trúc OpenAI Tool Call chuẩn hóa
 */
export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string theo chuẩn OpenAI
  };
}

export interface ParseDiagnostics {
  suspiciousToolDetected?: boolean;
  unclosedTagDetected?: boolean;
  terminalReason?: string;
  warningMessage?: string;
}

/**
 * Kết quả phân tích dịch từ M365 Output Translator
 */
export type TranslationResult =
  | {
    type: "tool_call";
    tool_calls: OpenAIToolCall[];
    rawResponse: string;
    parseDiagnostics?: ParseDiagnostics;
  }
  | {
    type: "final_answer";
    content: string;
    rawResponse: string;
    parseDiagnostics?: ParseDiagnostics;
  };

export interface DetectedToolCall {
  name: string;
  arguments: Record<string, any>;
}

/**
 * Giao diện trừu tượng cho các bộ phát hiện Tool Call
 * Tuân thủ Single Responsibility & Interface Segregation Principle
 */
export interface IToolCallDetector {
  readonly priority: number; // Mức độ ưu tiên (số nhỏ hơn = ưu tiên cao hơn)
  readonly name: string;
  detect(rawResponse: string): DetectedToolCall[] | DetectedToolCall | null;
}

function generateToolCallId(): string {
  return `call_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

import { stripOuterCodeFence } from "./temp-chat/stripCodeFence";
export { stripOuterCodeFence };


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
 * 2. Khôi phục các ký tự bị Markdown/Turndown escape không hợp lệ trong cú pháp JSON
 *    (ví dụ: "run\_command" -> "run_command", "\[n\]" -> "[n]", "\*" -> "*").
 *    Trong JSON, chỉ có các escape: \" \\ \/ \b \f \n \r \t \uXXXX là hợp lệ.
 * 3. Tự động cân bằng ngoặc nhọn nếu mô hình mở nhiều hơn đóng.
 */
export function cleanJsonPayload(raw: string): string {
  const stripped = stripOuterCodeFence(raw);
  const unescaped = stripped.replace(/\\([_\[\]*~`>#+\-.!|{}()])/g, "$1");
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

/**
 * Bộ phát hiện Codex Patch Tool Call (Ưu tiên 0)
 * Phát hiện các khối patch:
 * *** Begin Patch
 * ...
 * *** End Patch
 * Hỗ trợ:
 * - Dạng 2 hoặc 3 dấu sao (*** Begin Patch hoặc ** Begin Patch)
 * - Nằm trong thẻ <custom_tool_call name="apply_patch">
 * - Nằm trong chuỗi JSON của <tool_call> bị vỡ format
 * - Nằm trong code block ```patch ... ```, ```diff ... ``` hoặc văn bản trần
 * Tự động gọt sạch toàn bộ rác XML và BizChat ở đuôi để Lark grammar của Codex IDE luôn parse thành công.
 */
export class PatchToolCallDetector implements IToolCallDetector {
  readonly priority = 0;
  readonly name = "PatchToolCallDetector";

  detect(rawResponse: string): DetectedToolCall[] | DetectedToolCall | null {
    if (!rawResponse || !rawResponse.trim()) return null;

    // Chuẩn hóa ký tự * bị escape bởi Turndown trước khi tìm kiếm
    const unescaped = rawResponse.replaceAll("\\*", "*");

    // 1. Kiểm tra thẻ <custom_tool_call name="apply_patch">...</custom_tool_call> trước
    const customMatch = unescaped.match(/<\s*custom[\\_]*tool[\\_]*call(?:\s+name=["']apply_patch["'])?\s*>([\s\S]*?)<\s*\/custom[\\_]*tool[\\_]*call\s*>/i);
    if (customMatch) {
      const cleanedPatch = sanitizeCodexPatchContent(customMatch[1]);
      if (cleanedPatch.includes("*** Begin Patch")) {
        return {
          name: "apply_patch",
          arguments: { input: cleanedPatch },
        };
      }
    }

    // 2. Tìm tất cả các khối hoàn chỉnh: *** Begin Patch ... *** End Patch (hỗ trợ cả 2 hoặc 3 dấu sao)
    const matches = [...unescaped.matchAll(/\*{2,3}\s*Begin Patch([\s\S]*?)\*{2,3}\s*End Patch/gi)];
    if (matches.length > 0) {
      const calls: DetectedToolCall[] = [];
      for (const m of matches) {
        const cleanedPatch = sanitizeCodexPatchContent(m[0]);
        calls.push({
          name: "apply_patch",
          arguments: { input: cleanedPatch },
        });
      }
      return calls.length === 1 ? calls[0] : calls;
    }

    // 3. Nếu khối patch có Begin Patch và chứa header File (Update/Add/Delete),
    // cho phép auto-close *** End Patch khi stream đã kết thúc
    const openMatch = unescaped.match(/\*{2,3}\s*Begin Patch([\s\S]*)$/i);
    if (openMatch && /\*{2,3}\s*(?:Update|Add|Delete)\s*File:/i.test(openMatch[1])) {
      // Làm sạch rác XML/JSON ở đuôi trước khi auto-close
      let rawSnippet = openMatch[0];
      const junkIdx = rawSnippet.search(/["']\}\s*<\s*\/tool|Provide your feedback|BizChat/i);
      if (junkIdx >= 0) {
        rawSnippet = rawSnippet.slice(0, junkIdx);
      }
      let cleanedPatch = sanitizeCodexPatchContent(rawSnippet);
      if (!cleanedPatch.endsWith("*** End Patch")) {
        cleanedPatch = `${cleanedPatch}\n*** End Patch`;
      }
      return {
        name: "apply_patch",
        arguments: { input: cleanedPatch },
      };
    }

    return null;
  }
}

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

  private extractFromObject(obj: any): DetectedToolCall | null {
    if (!obj || typeof obj !== "object") return null;

    // TH1: { "action": "tool_call", "tool": "read_file", "arguments": { ... } }
    if (obj.action === "tool_call" && (obj.tool || obj.name)) {
      const toolName = String(obj.tool || obj.name);
      let args = obj.arguments || obj.args || obj.parameters || {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = { path: args }; }
      }
      return { name: toolName, arguments: args };
    }

    // TH2: { "name": "read_file", "arguments": { ... } }
    if (typeof obj.name === "string" && (obj.arguments !== undefined || obj.path !== undefined || obj.cmd !== undefined || obj.input !== undefined || obj.patch !== undefined)) {
      let args = obj.arguments || {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = { path: args }; }
      } else if (Object.keys(args).length === 0) {
        if (obj.path) args = { path: obj.path };
        else if (obj.cmd) args = { cmd: obj.cmd };
        else if (obj.input) args = { input: obj.input };
        else if (obj.patch) args = { input: obj.patch };
      }
      return { name: obj.name, arguments: args };
    }

    // TH3: { "tool": "read_file", "path": "pom.xml" }
    if (typeof obj.tool === "string") {
      const toolName = obj.tool;
      const args = obj.arguments || { ...obj };
      delete (args as any).tool;
      delete (args as any).action;
      return { name: toolName, arguments: args };
    }

    return null;
  }
}

/**
 * Bộ phát hiện XML Tool Call (Ưu tiên B)
 * Hỗ trợ nhiều thẻ <tool_call>...</tool_call> và <tool\_call>...</tool\_call>
 * TUYỆT ĐỐI KHÔNG thực thi khi chưa có thẻ đóng hợp lệ (Yêu cầu 4 & 5).
 */
export class XmlToolCallDetector implements IToolCallDetector {
  readonly priority = 2;
  readonly name = "XmlToolCallDetector";

  detect(rawResponse: string): DetectedToolCall[] | DetectedToolCall | null {
    if (!rawResponse || !rawResponse.trim()) return null;

    // 1. Tìm tất cả các thẻ <custom_tool_call name="...">...</custom_tool_call> (hỗ trợ cả custom_tool_call>)
    const customMatches = [...rawResponse.matchAll(/(?:<|\b)\s*custom[\\_]*tool[\\_]*call(?:\s+name=["']([^"']+)["'])?\s*>([\s\S]*?)(?:<\s*\/|\/\s*)custom[\\_]*tool[\\_]*call\s*>/gi)];
    if (customMatches.length > 0) {
      const calls: DetectedToolCall[] = [];
      for (const m of customMatches) {
        const name = m[1] || (m[2].includes("Begin Patch") ? "apply_patch" : "custom_tool");
        if (name === "apply_patch" || m[2].includes("Begin Patch")) {
          const cleaned = sanitizeCodexPatchContent(m[2]);
          calls.push({ name: "apply_patch", arguments: { input: cleaned } });
        } else {
          calls.push({ name, arguments: { input: m[2].trim() } });
        }
      }
      if (calls.length > 0) return calls.length === 1 ? calls[0] : calls;
    }

    // 2. Tìm tất cả các cặp thẻ: <tool_call>...</tool_call>, tool_call>...</tool_call> hoặc /tool_call>
    const matches = [...rawResponse.matchAll(/(?:<|\b)\s*tool[\\_]*call\s*>([\s\S]*?)(?:<\s*\/|\/\s*)tool[\\_]*call\s*>/gi)];
    if (matches.length > 0) {
      const calls: DetectedToolCall[] = [];
      for (const m of matches) {
        const item = this.parseInnerXml(m[1]);
        if (item) calls.push(item);
      }
      if (calls.length > 0) return calls.length === 1 ? calls[0] : calls;
    }

    // Nếu không có thẻ đóng, tool call chưa hoàn chỉnh -> Không được thực thi
    return null;
  }

  private parseInnerXml(innerContent: string): DetectedToolCall | null {
    const clean = cleanJsonPayload(innerContent);

    // 1. Thử parse với sanitizer xử lý raw newlines/control characters
    try {
      const sanitized = sanitizeJsonControlChars(clean);
      const parsed = JSON.parse(sanitized);
      if (parsed && typeof parsed === "object") {
        const name = typeof parsed.name === "string" ? parsed.name : (parsed.tool || "read_file");
        let args = parsed.arguments || parsed.args || {};
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch { args = { path: args }; }
        } else if (Object.keys(args).length === 0) {
          if (parsed.path) args = { path: parsed.path };
          else if (parsed.cmd) args = { cmd: parsed.cmd };
          else if (parsed.input) args = { input: parsed.input };
          else if (parsed.patch) args = { input: parsed.patch };
        }

        // Yêu cầu 4 & 5: Kiểm tra tính hoàn chỉnh bắt buộc cho write_file
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

        return { name, arguments: args };
      }
    } catch { }

    // 2. Thử parse nguyên bản
    try {
      const parsed = JSON.parse(clean);
      if (parsed && typeof parsed === "object") {
        const name = typeof parsed.name === "string" ? parsed.name : (parsed.tool || "read_file");
        let args = parsed.arguments || parsed.args || {};
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch { args = { path: args }; }
        } else if (Object.keys(args).length === 0) {
          if (parsed.path) args = { path: parsed.path };
          else if (parsed.cmd) args = { cmd: parsed.cmd };
          else if (parsed.input) args = { input: parsed.input };
          else if (parsed.patch) args = { input: parsed.patch };
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

/**
 * Bộ phát hiện Bash Command (Ưu tiên C)
 * Hỗ trợ một hoặc nhiều lệnh shell (cat file1 file2, cat file1\ncat file2, git status, v.v.)
 */
export class BashCommandDetector implements IToolCallDetector {
  readonly priority = 3;
  readonly name = "BashCommandDetector";

  constructor(private readonly translator = new BashCommandTranslator()) { }

  detect(rawResponse: string): DetectedToolCall[] | DetectedToolCall | null {
    const all = this.translator.translateAll(rawResponse);
    if (all.length === 0) return null;
    return all.length === 1 ? all[0] : all;
  }
}

/**
 * Mask arguments string cho log console để giấu secret / dữ liệu lớn
 */
export function maskArgumentsForLog(argsStr: string): string {
  try {
    const parsed = JSON.parse(argsStr);
    if (parsed && typeof parsed === "object") {
      const masked = { ...parsed };
      if (typeof masked.content === "string") {
        const sha = AtomicFileWriter.computeSha256(masked.content);
        const byteLen = Buffer.byteLength(masked.content, "utf8");
        masked.content = `[PROTECTED: ${byteLen} bytes, sha256: ${sha}]`;
      }
      if (typeof masked.patch === "string" && masked.patch.length > 200) {
        masked.patch = `[PROTECTED: ${Buffer.byteLength(masked.patch, "utf8")} bytes]`;
      }
      if (typeof masked.input === "string" && masked.input.length > 200) {
        masked.input = `[PROTECTED: ${Buffer.byteLength(masked.input, "utf8")} bytes]`;
      }
      return JSON.stringify(masked);
    }
  } catch { }
  if (argsStr.length > 300) {
    return `${argsStr.slice(0, 150)}... [TRUNCATED ${argsStr.length - 250} chars] ...${argsStr.slice(-100)}`;
  }
  return argsStr;
}

/**
 * Che giấu secret và dữ liệu lớn khi in log ra console (Yêu cầu 10)
 */
export function maskToolCallsForLog(toolCalls: OpenAIToolCall[]): any[] {
  return toolCalls.map(tc => {
    try {
      const parsedArgs = JSON.parse(tc.function.arguments);
      if (parsedArgs && typeof parsedArgs === "object") {
        const masked = { ...parsedArgs };
        if (typeof masked.content === "string") {
          const sha = AtomicFileWriter.computeSha256(masked.content);
          const byteLen = Buffer.byteLength(masked.content, "utf8");
          masked.content = `[PROTECTED: ${byteLen} bytes, sha256: ${sha}]`;
        }
        if (typeof masked.patch === "string" && masked.patch.length > 200) {
          masked.patch = `[PROTECTED: ${Buffer.byteLength(masked.patch, "utf8")} bytes]`;
        }
        if (typeof masked.input === "string" && masked.input.length > 200) {
          masked.input = `[PROTECTED: ${Buffer.byteLength(masked.input, "utf8")} bytes]`;
        }
        return {
          ...tc,
          function: {
            ...tc.function,
            arguments: masked,
          },
        };
      }
    } catch { }
    return tc;
  });
}

/**
 * Lớp chính Output Translator điều phối toàn bộ quá trình nhận diện và dịch
 * Tuân thủ Dependency Inversion (DIP) & Single Responsibility (SRP)
 */
export class M365OutputTranslator {
  private readonly detectors: IToolCallDetector[] = [];

  constructor(customDetectors?: IToolCallDetector[]) {
    if (customDetectors && customDetectors.length > 0) {
      this.detectors = [...customDetectors].sort((a, b) => a.priority - b.priority);
    } else {
      // Đăng ký theo thứ tự ưu tiên chuẩn: Patch (0) -> JSON (1) -> XML (2) -> Bash (3)
      this.detectors = [
        new PatchToolCallDetector(),
        new JsonToolCallDetector(),
        new XmlToolCallDetector(),
        new BashCommandDetector(),
      ].sort((a, b) => a.priority - b.priority);
    }
  }

  /**
   * Phương thức dịch phản hồi thô từ M365 thành TranslationResult
   * Hỗ trợ dịch đồng thời nhiều tool call (Parallel / Multi-tool calls)
   */
  translate(rawResponse: string): TranslationResult {
    const rawPreview = rawResponse.length > 2000
      ? `${rawResponse.slice(0, 1000)}\n... [TRUNCATED ${rawResponse.length - 1500} chars for privacy] ...\n${rawResponse.slice(-500)}`
      : rawResponse;
    console.log("\n[M365 RAW RESPONSE]");
    console.log(rawPreview);

    // Tự động lột bỏ lớp vỏ code block ngoài cùng (````markdown ... ```` hoặc ```...```)
    // để các detector phát hiện công cụ bên trong, hoặc trả về văn bản sạch cho Final Answer
    const unwrappedResponse = stripOuterCodeFence(rawResponse);

    // Nếu phản hồi chứa thẻ <proposed_plan>, đây là bản kế hoạch hoàn chỉnh cho Codex UI duyệt (Final Answer)
    if (/<\s*proposed[\\_]*plan\s*>[\s\S]*?<\s*\/proposed[\\_]*plan\s*>/i.test(unwrappedResponse)) {
      return {
        type: "final_answer",
        content: unwrappedResponse.trim(),
        rawResponse,
        parseDiagnostics: {
          terminalReason: "proposed_plan",
          warningMessage: "Phản hồi chứa bản kế hoạch <proposed_plan>. Trả về Final Answer cho người dùng/Codex duyệt kế hoạch.",
        },
      };
    }

    // Duyệt qua các detector theo thứ tự ưu tiên (kiểm tra trên unwrappedResponse trước, dự phòng rawResponse)
    for (const detector of this.detectors) {
      const detected = detector.detect(unwrappedResponse) || detector.detect(rawResponse);
      if (detected) {
        const callsList = Array.isArray(detected) ? detected : [detected];
        const toolCalls: OpenAIToolCall[] = callsList.map(item => ({
          id: generateToolCallId(),
          type: "function",
          function: {
            name: item.name,
            arguments: JSON.stringify(item.arguments),
          },
        }));

        console.log("\n[TRANSLATED TOOL CALL]");
        console.log(JSON.stringify({ tool_calls: maskToolCallsForLog(toolCalls) }, null, 2));

        return {
          type: "tool_call",
          tool_calls: toolCalls,
          rawResponse,
          parseDiagnostics: {
            terminalReason: "tool_calls_emitted",
            warningMessage: `Phát hiện ${toolCalls.length} tool call hợp lệ: ${toolCalls.map(t => t.function.name).join(", ")}.`,
          },
        };
      }
    }

    // Nếu không khớp với bất kỳ tool call nào, đây là Final Answer
    const trimmedAnswer = unwrappedResponse.trim();

    // Kiểm tra chẩn đoán: Có chứa dấu hiệu nghi vấn tool call mà không parse được hay không?
    const hasSuspiciousXml = /<\s*tool[\\_]*call\s*>/i.test(unwrappedResponse);
    const hasUnclosedXml = hasSuspiciousXml && !/<\s*\/tool[\\_]*call\s*>/i.test(unwrappedResponse);
    const hasSuspiciousJson = /"action"\s*:\s*"tool_call"|"name"\s*:\s*"(?:read_file|write_file|apply_patch|exec_command|run_command)"/i.test(unwrappedResponse);
    const hasSuspiciousPatch = /(?:\\?\*){3}\s*Begin Patch/i.test(unwrappedResponse);

    let diagnosticWarning = "";
    if (hasUnclosedXml) {
      diagnosticWarning = "Phát hiện thẻ <tool_call> chưa được đóng hoàn chỉnh từ M365 (thiếu </tool_call>). Codex dừng do nhận kết quả là văn bản thường.";
    } else if (hasSuspiciousXml) {
      diagnosticWarning = "Phát hiện khối <tool_call> hoàn chỉnh nhưng parse JSON thất bại. Codex bị dừng xử lý và chuyển sang Final Answer vì lý do này.";
    } else if (hasSuspiciousPatch) {
      diagnosticWarning = "Phát hiện khối *** Begin Patch nhưng khối patch chưa đóng hoặc bị lỗi cấu trúc. Codex dừng xử lý.";
    } else if (hasSuspiciousJson) {
      diagnosticWarning = "Phát hiện chuỗi JSON có thuộc tính tool_call nhưng không trích xuất được tham số hợp lệ.";
    }

    return {
      type: "final_answer",
      content: trimmedAnswer,
      rawResponse,
      ...(diagnosticWarning
        ? {
          parseDiagnostics: {
            suspiciousToolDetected: true,
            warningMessage: diagnosticWarning,
          },
        }
        : {
          parseDiagnostics: {
            terminalReason: "model_final_answer",
            warningMessage: "M365 Copilot hoàn tất câu trả lời dạng văn bản kết luận (Final Answer).",
          },
        }),
    };
  }

  /**
   * Helper chuyển đổi kết quả sang payload OpenAI tool_calls trực tiếp
   */
  toOpenAIPayload(rawResponse: string): { tool_calls: OpenAIToolCall[] } | { content: string } {
    const result = this.translate(rawResponse);
    if (result.type === "tool_call") {
      return { tool_calls: result.tool_calls };
    }
    return { content: result.content };
  }
}
