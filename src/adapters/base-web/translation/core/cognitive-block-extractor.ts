import type { CognitiveBlocksDto } from "../dto/cognitive-blocks.dto";

/**
 * Trích xuất các khối nhận thức (Thinking & Narrative) từ phản hồi của Web Chat Bot
 */
export class CognitiveBlockExtractor {
  /**
   * Bóc tách thinking và narrative từ chuỗi phản hồi thô
   */
  public static extract(rawText: string): CognitiveBlocksDto {
    let thinking: string | undefined;

    // 0. Gọt bỏ thẻ bọc envelope <m365Response>...</m365Response> (hoặc tương tự)
    const textWithoutEnvelope = rawText.replace(/<\s*\/?\s*m365[\\_]*response\s*>/gi, "");

    // 1. Trích xuất nội dung thẻ <thought>...</thought> hoặc <thinking>...</thinking>
    const thoughtMatch = textWithoutEnvelope.match(/<\s*(?:thought|thinking)\s*>([\s\S]*?)<\s*\/(?:thought|thinking)\s*>/i);
    if (thoughtMatch) {
      const rawThought = thoughtMatch[1].trim();
      if (rawThought.length > 0) {
        thinking = rawThought;
      }
    }

    // 2. Làm sạch chuỗi bằng cách xóa bỏ khối thought
    const textWithoutThought = textWithoutEnvelope.replace(/<\s*(?:thought|thinking)\s*>[\s\S]*?<\s*\/(?:thought|thinking)\s*>/gi, "").trim();

    // 3. Trích xuất narrative (lời dẫn dắt bước đi) bằng cách loại bỏ các khối tool call và patch
    const textWithoutTools = textWithoutThought
      .replace(/(?:<|\b)\s*(?:custom[\\_]*)?tool[\\_]*call(?:\s+[^>]*)?>[\s\S]*?(?:<\s*\/|\/\s*)(?:custom[\\_]*)?tool[\\_]*call\s*>/gi, "")
      .replace(/(?:\\?\*){2,3}\s*Begin Patch[\s\S]*?(?:\\?\*){2,3}\s*End Patch(?:\s*\\?\*+)?/gi, "");

    const narrativeCandidate = textWithoutTools.trim();
    const narrative = narrativeCandidate.length > 0 ? narrativeCandidate : undefined;

    return {
      thinking,
      narrative,
      cleanedText: textWithoutThought,
    };
  }
}

export function extractCognitiveBlocks(rawText: string): CognitiveBlocksDto {
  return CognitiveBlockExtractor.extract(rawText);
}
