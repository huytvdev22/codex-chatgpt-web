import type { CodexParsedRequest } from "../../../types";
import {
  BasePromptAssembler,
  truncateToolResult,
  PlanModeDetector,
  PLAN_MODE_PROMPT,
  IMPLEMENT_PLAN_PROMPT,
  TOOL_REMINDER_PROMPT,
  TOOL_RESULT_HINTS,
  OUTPUT_FORMAT_HINTS,
} from "../../base-web/prompts";

export const isPlanModeRequest = PlanModeDetector.isPlanModeRequest.bind(PlanModeDetector);
export const isImplementingPlanRequest = PlanModeDetector.isImplementingPlanRequest;

const defaultAssembler = new BasePromptAssembler();

export function compileM365Prompt(parsed: CodexParsedRequest, isNewConversation = true): string {
  return defaultAssembler.assemble(parsed, isNewConversation);
}

export {
  truncateToolResult,
  PLAN_MODE_PROMPT,
  IMPLEMENT_PLAN_PROMPT,
  TOOL_REMINDER_PROMPT,
  TOOL_RESULT_HINTS,
  OUTPUT_FORMAT_HINTS,
};
