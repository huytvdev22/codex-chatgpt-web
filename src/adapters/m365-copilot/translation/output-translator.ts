import {
  BaseOutputTranslator,
  extractCognitiveBlocks,
  PatchToolCallDetector,
  JsonToolCallDetector,
  XmlToolCallDetector,
  BashCommandDetector,
  stripOuterCodeFence,
  normalizeToolName,
  balanceJsonBraces,
  cleanJsonPayload,
  normalizePatchEnvelope,
  generateToolCallId,
  sanitizeCodexPatchContent,
  maskArgumentsForLog,
  maskToolCallsForLog,
  type OpenAIToolCall,
  type ParseDiagnostics,
  type TranslationResult,
  type DetectedToolCall,
  type IToolCallDetector,
  type BaseToolCallDetector,
} from "../../base-web/translation";

// Re-export toàn bộ hợp đồng và helper để duy trì 100% tương thích ngược
export type {
  OpenAIToolCall,
  ParseDiagnostics,
  TranslationResult,
  DetectedToolCall,
  IToolCallDetector,
  BaseToolCallDetector,
};

export {
  PatchToolCallDetector,
  JsonToolCallDetector,
  XmlToolCallDetector,
  BashCommandDetector,
  stripOuterCodeFence,
  normalizeToolName,
  balanceJsonBraces,
  cleanJsonPayload,
  normalizePatchEnvelope,
  generateToolCallId,
  sanitizeCodexPatchContent,
  maskArgumentsForLog,
  maskToolCallsForLog,
  extractCognitiveBlocks,
};

/**
 * M365OutputTranslator kế thừa BaseOutputTranslator
 * Đảm bảo 100% tương thích ngược
 */
export class M365OutputTranslator extends BaseOutputTranslator {
  constructor(customDetectors?: IToolCallDetector[]) {
    super(customDetectors);
  }
}
