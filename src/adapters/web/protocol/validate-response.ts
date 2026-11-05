import type { CodexTool } from "../../../types";
import {
  normalizeM365ToolArguments,
  validateM365ToolCall,
  type ToolValidationFailure,
} from "../tools";
import type {
  M365ProtocolErrorCode,
  StrictM365ResponseResult,
} from "./strict-response-parser";

export interface ValidateWebProtocolOptions {
  classifyFailure?: (
    failure: ToolValidationFailure,
  ) => M365ProtocolErrorCode;
}

/**
 * Validates every tool call in an already parsed response as one atomic batch.
 * The first invalid call converts the complete response into a protocol error,
 * preventing adapters from executing a valid prefix of an invalid batch.
 */
export function validateWebProtocolResponse(
  result: StrictM365ResponseResult,
  clientTools: readonly CodexTool[],
  options: ValidateWebProtocolOptions = {},
): StrictM365ResponseResult {
  if (result.kind !== "tool_calls") return result;

  for (const call of result.calls) {
    const normalizedCall = normalizeM365ToolArguments(
      call.name,
      call.arguments,
    );
    const validation = validateM365ToolCall(
      normalizedCall.name,
      normalizedCall.arguments,
      clientTools,
    );

    if (!validation.ok) {
      const failure = validation as ToolValidationFailure;
      return {
        kind: "protocol_error",
        code: options.classifyFailure?.(failure) ?? "INVALID_TOOL_CALL",
        message: `${failure.code}: ${failure.message}`,
        rawResponse: result.rawResponse,
      };
    }
  }

  return result;
}
