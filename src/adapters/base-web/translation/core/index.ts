export { stripOuterCodeFence } from "./strip-code-fence";
export { maskArgumentsForLog, maskToolCallsForLog } from "./log-masker";
export { CognitiveBlockExtractor, extractCognitiveBlocks } from "./cognitive-block-extractor";
export { BaseOutputTranslator } from "./base-output-translator";
export {
  BashCommandTranslator,
  stripShellPrefix,
  CatRule,
  LsRule,
  GrepRule,
  GitStatusRule,
  GitDiffRule,
  FindRule,
  isDestructiveCommand,
  type IBashCommandRule,
} from "./bash-translator";
export {
  parseStrictM365Response,
  M365_RESPONSE_OPEN_TAG,
  M365_RESPONSE_CLOSE_TAG,
  type M365ProtocolErrorCode,
  type StrictM365ToolCall,
  type StrictM365ResponseResult,
} from "./strict-response-parser";
export {
  M365ToolCallDetector,
  StreamingToolCallDetector,
  autoHealHtmlMangledTags,
  type M365ToolCallDetectorOptions,
  type ParsedToolCall,
} from "./streaming-tool-call-detector";
export {
  SemanticMarkdownBuffer,
  M365MarkdownBuffer,
  type SemanticMarkdownBlock,
  type M365MarkdownBlock,
} from "./semantic-markdown-buffer";
export {
  chatGptHtmlToMarkdown,
  m365HtmlToMarkdown,
  normalizeMarkdownFences,
  STATUS_PATTERNS,
} from "./html-to-markdown";
