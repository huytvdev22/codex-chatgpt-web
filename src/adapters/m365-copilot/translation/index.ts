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
  type BashTranslationResult,
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
  balanceJsonBraces,
} from "./output-translator";
