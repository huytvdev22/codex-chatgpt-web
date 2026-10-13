/**
 * DTO đại diện cho các khối nhận thức (Thinking & Narrative) bóc tách từ chuỗi phản hồi
 */
export interface CognitiveBlocksDto {
  readonly thinking?: string;
  readonly narrative?: string;
  readonly cleanedText: string;
}
