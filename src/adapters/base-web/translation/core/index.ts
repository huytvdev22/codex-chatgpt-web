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
  parseStrictWebResponse,
  WEB_ROOT_OPEN,
  WEB_ROOT_CLOSE,
  WEB_RESPONSE_OPEN_TAG,
  WEB_RESPONSE_CLOSE_TAG,
  type M365ProtocolErrorCode,
  type WebProtocolErrorCode,
  type StrictM365ToolCall,
  type StrictWebToolCall,
  type StrictM365ResponseResult,
  type StrictWebResponseResult,
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
