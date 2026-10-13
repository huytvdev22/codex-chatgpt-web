export {
  PLAN_MODE_PROMPT,
  IMPLEMENT_PLAN_PROMPT,
  TOOL_REMINDER_PROMPT,
  TOOL_RESULT_HINTS,
  OUTPUT_FORMAT_HINTS,
  M365_IMAGE_ATTACHMENT_HINT,
  SHORT_OUTPUT_FORMAT_ANCHOR,
  SHORT_OUTPUT_FORMAT_PLAN_ANCHOR,
} from "./templates";

export {
  UNIFIED_TOOL_PROTOCOL,
  MINIMAL_TOOL_PROTOCOL,
  cleanToolDescription,
  renderDynamicToolDeclarations,
  renderCompactDynamicToolDeclarations,
  calculatePromptMetrics,
  promptCompiler,
  type PromptSectionMetrics,
  type PromptAuditData,
  type PromptCompileInput,
  type PromptCompileResult,
} from "./compiler";

export {
  buildM365FormatRetryPrompt,
  type M365FormatRetryOptions,
} from "./format-retry";

export {
  truncateToolResult,
  compileM365Prompt,
  isPlanModeRequest,
  isImplementingPlanRequest,
} from "./assembler";
