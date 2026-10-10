export {
  STATUS_PATTERNS,
  normalizeMarkdownFences,
  m365HtmlToMarkdown,
} from "./html-to-markdown";

export {
  M365MarkdownBuffer,
  type M365MarkdownBlock,
} from "./semantic-detector";

export {
  M365ToolCallDetector,
  type ParsedToolCall,
  sanitizeCodexPatchContent,
  sanitizeJsonControlChars,
  autoHealHtmlMangledTags,
} from "./toolcall-detector";

export {
  parseStrictM365Response,
  M365_RESPONSE_OPEN_TAG,
  M365_RESPONSE_CLOSE_TAG,
  type M365ProtocolErrorCode,
  type StrictM365ToolCall,
  type StrictM365ResponseResult,
} from "./strict-response-parser";

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
} from "./bash-translator";

export {
  M365OutputTranslator,
  extractCognitiveBlocks,
  type OpenAIToolCall,
  type TranslationResult,
  type BaseToolCallDetector,
  PatchToolCallDetector,
  JsonToolCallDetector,
  XmlToolCallDetector,
  BashCommandDetector,
  normalizePatchEnvelope,
  normalizeToolName,
  maskArgumentsForLog,
  maskToolCallsForLog,
  balanceJsonBraces,
} from "./output-translator";

export * from "./detectors";
export * from "./log-masker";
