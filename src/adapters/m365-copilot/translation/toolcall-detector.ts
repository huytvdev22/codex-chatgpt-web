/**
 * Facade tương thích ngược cho M365ToolCallDetector
 */
import { chatGptHtmlToMarkdown } from "./html-to-markdown";

export {
  M365ToolCallDetector,
  StreamingToolCallDetector,
  type M365ToolCallDetectorOptions,
  type ParsedToolCall,
  sanitizeJsonControlChars,
  sanitizeCodexPatchContent,
  stripOuterCodeFence,
  autoHealHtmlMangledTags,
} from "../../base-web/translation/core/streaming-tool-call-detector";

export { chatGptHtmlToMarkdown };
