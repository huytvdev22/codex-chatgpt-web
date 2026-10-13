import {
  BasePromptCompiler,
  cleanToolDescription,
  renderDynamicToolDeclarations,
  renderCompactDynamicToolDeclarations,
  calculatePromptMetrics,
  logPromptMetrics,
  logPromptAudit,
  truncateToolResult,
  PlanModeDetector,
  UNIFIED_TOOL_PROTOCOL,
  MINIMAL_TOOL_PROTOCOL,
  type PromptSectionMetrics,
  type PromptAuditData,
  type PromptCompileInput,
  type PromptCompileResult,
} from "../../base-web/prompts";

export const isImplementingPlanRequest = PlanModeDetector.isImplementingPlanRequest;

export class M365PromptCompiler extends BasePromptCompiler {}

export const promptCompiler = new M365PromptCompiler();

export {
  cleanToolDescription,
  renderDynamicToolDeclarations,
  renderCompactDynamicToolDeclarations,
  calculatePromptMetrics,
  logPromptMetrics,
  logPromptAudit,
  truncateToolResult,
  UNIFIED_TOOL_PROTOCOL,
  MINIMAL_TOOL_PROTOCOL,
  type PromptSectionMetrics,
  type PromptAuditData,
  type PromptCompileInput,
  type PromptCompileResult,
};
