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
    thinking?: string;
    narrative?: string;
    parseDiagnostics?: ParseDiagnostics;
  }
  | {
    type: "final_answer";
    content: string;
    rawResponse: string;
    thinking?: string;
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

/**
 * Type alias cho tương thích ngược
 */
export type BaseToolCallDetector = IToolCallDetector;
