import type { OpenAIToolCall } from "./openai-tool-call.dto";

export interface ParseDiagnostics {
  suspiciousToolDetected?: boolean;
  unclosedTagDetected?: boolean;
  terminalReason?: string;
  warningMessage?: string;
}

/**
 * Kết quả phân tích dịch từ Output Translator
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
      narrative?: string;
      parseDiagnostics?: ParseDiagnostics;
    };
