/**
 * DTO đại diện cho một Tool Call chuẩn OpenAI
 */
export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string theo chuẩn OpenAI
  };
}
