import type { TranslationResult } from "../dto/translation-result.dto";
import type { OpenAIToolCall } from "../dto/openai-tool-call.dto";

/**
 * Hợp đồng cho bộ biên dịch đầu ra từ Web Chat phản hồi sang chuẩn OpenAI
 */
export interface IOutputTranslator {
  /**
   * Phân tích và dịch phản hồi thô thành TranslationResult
   */
  translate(rawResponse: string): TranslationResult;

  /**
   * Chuyển đổi sang payload OpenAI tương thích
   */
  toOpenAIPayload(rawResponse: string): { tool_calls: OpenAIToolCall[] } | { content: string };
}
