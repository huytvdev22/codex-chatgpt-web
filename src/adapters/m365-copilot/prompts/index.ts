export {
  buildUnifiedToolProtocol,
  buildShortOutputFormatAnchor,
  buildShortOutputFormatPlanAnchor,
  buildPureConversationAnchor,
  PLAN_MODE_PROMPT,
  IMPLEMENT_PLAN_PROMPT,
  IMPLEMENT_PLAN_CONTINUATION_PROMPT,
  TOOL_REMINDER_PROMPT,
  TOOL_ERROR_FEEDBACK_PROMPT,
  TOOL_RESULT_HINTS,
  OUTPUT_FORMAT_HINTS,
  M365_IMAGE_ATTACHMENT_HINT,
  SHORT_OUTPUT_FORMAT_ANCHOR,
  SHORT_OUTPUT_FORMAT_PLAN_ANCHOR,
  PURE_CONVERSATION_ANCHOR,
} from "./templates";

export {
  conversationScenarioBuilder,
  detectConversationScenario,
  type ConversationScenario,
  type ScenarioBuilderInput,
  type ScenarioBuildResult,
} from "./conversation-scenario-builder";

export {
  UNIFIED_TOOL_PROTOCOL,
  MINIMAL_TOOL_PROTOCOL,
  cleanToolDescription,
  renderDynamicToolDeclarations,
  renderCompactDynamicToolDeclarations,
  calculatePromptMetrics,
  sanitizeCodexInstructions,
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
