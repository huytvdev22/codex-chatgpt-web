import { ToolDescriptionCurator } from "./tool-description-curator";
import { ToolDeclarationRenderer } from "./tool-declaration-renderer";
import { PromptSanitizer } from "./prompt-sanitizer";
import { FormatRetryBuilder } from "./format-retry-builder";
import { PlanModeDetector } from "./plan-mode-detector";
import { BasePromptCompiler } from "./base-prompt-compiler";
import { BasePromptAssembler } from "./base-prompt-assembler";

export {
  ToolDescriptionCurator,
  ToolDeclarationRenderer,
  PromptSanitizer,
  FormatRetryBuilder,
  PlanModeDetector,
  BasePromptCompiler,
  BasePromptAssembler,
};

// Top-level compatibility helper functions
export const cleanToolDescription = ToolDescriptionCurator.cleanToolDescription;
export const renderDynamicToolDeclarations = ToolDeclarationRenderer.renderDynamicToolDeclarations;
export const renderCompactDynamicToolDeclarations = ToolDeclarationRenderer.renderCompactDynamicToolDeclarations;
export const truncateToolResult = PromptSanitizer.truncateToolResult;
export const sanitizeCodexInstructions = PromptSanitizer.sanitizeCodexInstructions;
export const buildFormatRetryPrompt = FormatRetryBuilder.buildFormatRetryPrompt;
export const isPlanModeRequest = PlanModeDetector.isPlanModeRequest.bind(PlanModeDetector);
export const isImplementingPlanRequest = PlanModeDetector.isImplementingPlanRequest;
