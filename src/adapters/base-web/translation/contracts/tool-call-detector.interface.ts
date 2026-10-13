import type { DetectedToolCall } from "../dto/detected-tool-call.dto";

/**
 * Giao diện trừu tượng cho các bộ phát hiện Tool Call từ phản hồi web chat
 * Tuân thủ Single Responsibility & Interface Segregation Principle
 */
export interface IToolCallDetector {
  readonly priority: number; // Mức độ ưu tiên (số nhỏ hơn = ưu tiên cao hơn)
  readonly name: string;
  detect(rawResponse: string): DetectedToolCall[] | DetectedToolCall | null;
}

/**
 * Type alias hỗ trợ tương thích ngược
 */
export type BaseToolCallDetector = IToolCallDetector;
