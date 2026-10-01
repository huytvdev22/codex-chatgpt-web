import { BashCommandTranslator } from "./bash-translator";

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

/**
 * Kết quả phân tích dịch từ M365 Output Translator
 */
export type TranslationResult =
  | {
      type: "tool_call";
      tool_calls: OpenAIToolCall[];
      rawResponse: string;
    }
  | {
      type: "final_answer";
      content: string;
      rawResponse: string;
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

/**
 * Chuẩn hóa và làm sạch chuỗi JSON thoát ký tự
 */
function cleanJsonPayload(raw: string): string {
  return raw
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .replaceAll("\\_", "_")
    .replaceAll("\\*", "*")
    .replaceAll("\\[", "[")
    .replaceAll("\\]", "]")
    .replaceAll("\\{", "{")
    .replaceAll("\\}", "}")
    .replaceAll("\\~", "~")
    .trim();
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
    const trimmed = rawResponse.trim();
    if (trimmed.startsWith("<tool_call>") || trimmed.startsWith("<tool\\_call>")) {
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
    if (typeof obj.name === "string" && (obj.arguments !== undefined || obj.path !== undefined || obj.cmd !== undefined)) {
      let args = obj.arguments || {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = { path: args }; }
      } else if (Object.keys(args).length === 0) {
        if (obj.path) args = { path: obj.path };
        else if (obj.cmd) args = { cmd: obj.cmd };
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
 */
export class XmlToolCallDetector implements IToolCallDetector {
  readonly priority = 2;
  readonly name = "XmlToolCallDetector";

  detect(rawResponse: string): DetectedToolCall[] | DetectedToolCall | null {
    if (!rawResponse || !rawResponse.trim()) return null;

    // Tìm tất cả các cặp thẻ <tool_call>...</tool_call> hoặc <tool\_call>...</tool\_call>
    const matches = [...rawResponse.matchAll(/<\s*tool[\\_]*call\s*>([\s\S]*?)<\s*\/tool[\\_]*call\s*>/gi)];
    if (matches.length > 0) {
      const calls: DetectedToolCall[] = [];
      for (const m of matches) {
        const item = this.parseInnerXml(m[1]);
        if (item) calls.push(item);
      }
      if (calls.length > 0) return calls;
    }

    // Trường hợp chỉ có 1 thẻ mở chưa đóng
    const openOnlyMatch = rawResponse.match(/<\s*tool[\\_]*call\s*>([\s\S]*)$/i);
    if (openOnlyMatch) {
      return this.parseInnerXml(openOnlyMatch[1]);
    }

    return null;
  }

  private parseInnerXml(innerContent: string): DetectedToolCall | null {
    const clean = cleanJsonPayload(innerContent);

    // Thử parse JSON bên trong thẻ
    try {
      const parsed = JSON.parse(clean);
      if (parsed && typeof parsed === "object") {
        const name = typeof parsed.name === "string" ? parsed.name : (parsed.tool || "read_file");
        let args = parsed.arguments || parsed.args || {};
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch { args = { path: args }; }
        } else if (Object.keys(args).length === 0 && parsed.path) {
          args = { path: parsed.path };
        }
        return { name, arguments: args };
      }
    } catch {
      // Fallback bằng regex nếu JSON bên trong bị lỗi formatting bởi LLM
      const nameMatch = clean.match(/"name"\s*:\s*"([^"]+)"/i) || clean.match(/"tool"\s*:\s*"([^"]+)"/i);
      const pathMatch = clean.match(/"path"\s*:\s*"([^"]+)"/i);
      const cmdMatch = clean.match(/"cmd"\s*:\s*"([^"]+)"/i);

      if (nameMatch) {
        const name = nameMatch[1];
        if (pathMatch) return { name, arguments: { path: pathMatch[1] } };
        if (cmdMatch) return { name, arguments: { cmd: cmdMatch[1] } };
        return { name, arguments: {} };
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

  constructor(private readonly translator = new BashCommandTranslator()) {}

  detect(rawResponse: string): DetectedToolCall[] | DetectedToolCall | null {
    const all = this.translator.translateAll(rawResponse);
    if (all.length === 0) return null;
    return all.length === 1 ? all[0] : all;
  }
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
      // Đăng ký theo thứ tự ưu tiên chuẩn: A (JSON) -> B (XML) -> C (Bash)
      this.detectors = [
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
    console.log("\n[M365 RAW RESPONSE]");
    console.log(rawResponse);

    // Duyệt qua các detector theo thứ tự ưu tiên
    for (const detector of this.detectors) {
      const detected = detector.detect(rawResponse);
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
        console.log(JSON.stringify({ tool_calls: toolCalls }, null, 2));

        return {
          type: "tool_call",
          tool_calls: toolCalls,
          rawResponse,
        };
      }
    }

    // Nếu không khớp với bất kỳ tool call nào, đây là Final Answer
    const trimmedAnswer = rawResponse.trim();
    return {
      type: "final_answer",
      content: trimmedAnswer,
      rawResponse,
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
