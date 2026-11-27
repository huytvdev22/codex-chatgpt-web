import type { StrictWebToolCall, WebProtocolErrorCode } from "../adapters/web/protocol/strict-response-parser";

export type AssistantStreamGateState =
  | "BUFFERING"
  | "STREAMING_TEXT"
  | "BLOCKED_TOOL_CALL";

export type AssistantParsedResponse =
  | {
      kind: "final_answer";
      content: string;
      rawResponse: string;
    }
  | {
      kind: "tool_calls";
      calls: StrictWebToolCall[];
      commentaryText?: string;
      rawResponse: string;
    }
  | {
      kind: "protocol_error";
      code: WebProtocolErrorCode;
      message: string;
      rawResponse: string;
    };

export type AssistantPromptScenario =
  | "STRUCTURED_JSON_OUTPUT"
  | "FIRST_HANDSHAKE"
  | "USER_INPUT_ANSWER"
  | "TOOL_ERROR_FEEDBACK"
  | "TOOL_RESULT_CONTINUATION"
  | "CONVERSATION";

export interface AssistantPromptCompileResult {
  finalPrompt: string;
  scenario: AssistantPromptScenario;
}

export interface AssistantTurnContext {
  providerId: string;
  modelId: string;
  reasoning?: string;
}
