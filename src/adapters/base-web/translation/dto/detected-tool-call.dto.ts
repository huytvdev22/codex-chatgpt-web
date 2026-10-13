/**
 * DTO đại diện cho một Tool Call được phát hiện từ phản hồi thô của Web Chat Bot
 */
export interface DetectedToolCall {
  name: string;
  arguments: Record<string, any>;
}
