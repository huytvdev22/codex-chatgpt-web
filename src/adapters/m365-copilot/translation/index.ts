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
} from "./toolcall-detector";

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

