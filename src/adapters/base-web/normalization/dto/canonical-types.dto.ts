import type { CodexRawRequestWire } from "./codex-raw-wire.dto";

export interface NormalizedToolIdentity {
  namespace?: string;
  name: string;
  qualifiedName: string;
}

export interface NormalizedFunctionTool {
  kind: "function";
  identity: NormalizedToolIdentity;
  description: string;
  strict?: boolean;
  rawParameters: Record<string, unknown>;
}

export interface NormalizedCustomTool {
  kind: "custom";
  identity: NormalizedToolIdentity;
  description: string;
  format?: unknown;
}

export type NormalizedTool = NormalizedFunctionTool | NormalizedCustomTool;

export interface NormalizedToolResult {
  callId: string;
  toolName?: string;
  kind?: "function" | "custom";
  output: string;
}

export interface NormalizedTurn {
  id?: string;
  role: "user" | "assistant" | "developer" | "tool";
  content: string;
  isUserText?: boolean;
  callId?: string;
  toolName?: string;
}

export interface NormalizedExecutionPolicy {
  parallelToolCalls: boolean;
  toolChoice?: unknown;
}

export const DEFAULT_MAX_INPUT_IMAGES = 3;

export interface NormalizedImageAttachment {
  ref: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  buffer: Buffer;
  detail?: string;
}

export interface NormalizedCodexRequest {
  model: string;
  stream: boolean;
  threadId?: string;
  turnId?: string;
  systemInstructions?: string[];
  environmentContext?: string;
  developerInstructions?: string[];
  priorHistory: NormalizedTurn[];
  latestUserInstruction?: string;
  trailingToolResults: NormalizedToolResult[];
  tools: NormalizedTool[];
  activeCodingTools: NormalizedTool[];
  executionPolicy: NormalizedExecutionPolicy;
  collaborationMode: "default" | "plan";
  rawSnapshot: CodexRawRequestWire;
  images?: NormalizedImageAttachment[];
}
