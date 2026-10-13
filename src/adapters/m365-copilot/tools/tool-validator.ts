import {
  ToolCallValidator,
  DEFAULT_BRIDGE_TOOLS,
  type ToolValidationResult,
  type ToolValidationSuccess,
  type ToolValidationFailure,
} from "../../base-web/tools";
import type { CodexTool } from "../../../types";

export const BRIDGE_TOOLS = DEFAULT_BRIDGE_TOOLS;
export type { ToolValidationResult, ToolValidationSuccess, ToolValidationFailure };

export function validateM365ToolCall(
  name: string,
  args: Record<string, unknown>,
  clientTools: CodexTool[] = []
): ToolValidationResult {
  return ToolCallValidator.validateToolCall(name, args, clientTools);
}
