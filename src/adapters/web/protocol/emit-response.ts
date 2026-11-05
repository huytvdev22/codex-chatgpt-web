import type {
  AdapterEvent,
  CodexTool,
  CodexUsage,
} from "../../../types";
import { WebToolBridge } from "../tools";
import type { StrictWebResponseResult } from "./strict-response-parser";

type SuccessfulWebProtocolResult = Exclude<
  StrictWebResponseResult,
  { kind: "protocol_error" }
>;

export interface EmitWebProtocolResponseOptions {
  result: SuccessfulWebProtocolResult;
  clientTools: CodexTool[];
  emit: (event: AdapterEvent) => void;
  createCallId: () => string;
  usage?: CodexUsage;
  includeDetailedDoneEvent?: boolean;
  toolCallStopReason?: string;
  toolCallEndTurn?: boolean;
}

/**
 * Maps one validated Web protocol response into canonical adapter events.
 *
 * Provider adapters remain responsible for logging, status tracking and
 * Launcher lifecycle. This helper only owns the shared event wire format.
 */
export function emitWebProtocolResponse(
  options: EmitWebProtocolResponseOptions,
): void {
  const {
    result,
    clientTools,
    emit,
    createCallId,
    usage,
    includeDetailedDoneEvent = false,
    toolCallStopReason = "tool_calls",
    toolCallEndTurn,
  } = options;

  if (result.kind === "final_answer") {
    emit({
      type: "text_delta",
      text: result.content,
    });
    emit({
      type: "done",
      ...(includeDetailedDoneEvent
        ? {
            stopReason: "stop",
            endTurn: true,
            usage,
          }
        : {}),
    });
    return;
  }

  for (const rawCall of result.calls) {
    const mapped = WebToolBridge.mapToolCall(rawCall, clientTools);
    const callId = rawCall.id || createCallId();
    const serializedArguments = typeof mapped.arguments === "string"
      ? mapped.arguments
      : JSON.stringify(mapped.arguments ?? {});

    emit({
      type: "tool_call_start",
      id: callId,
      name: mapped.name,
    });
    emit({
      type: "tool_call_delta",
      arguments: serializedArguments,
    });
    emit({
      type: "tool_call_end",
    });
  }

  emit({
    type: "done",
    ...(includeDetailedDoneEvent
      ? {
          stopReason: toolCallStopReason,
          ...(toolCallEndTurn !== undefined ? { endTurn: toolCallEndTurn } : {}),
          usage,
        }
      : {}),
  });
}
