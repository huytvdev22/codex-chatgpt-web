import type { CodexParsedRequest } from "../../types";
import {
  CodexPayloadNormalizer,
  CodexRawPayload,
  type NormalizedCodexRequest,
} from "./normalization";
import {
  isImplementingPlanRequest,
  WebPromptCompiler,
  type McpToolDeltaOptions,
  type PromptCompileResult,
} from "./prompt";

export interface CompileWebPromptOptions {
  assistantName: string;
  isNewConversation: boolean;
  maxPromptChars?: number;
  maxInputImages?: number;
  normalized?: NormalizedCodexRequest;
  toolDelta?: McpToolDeltaOptions;
  includeEnvironment?: boolean;
  includeUserInstruction?: boolean;
}

/**
 * Compiles a provider-neutral Web prompt from the original Codex request.
 * Provider adapters only supply the assistant name, limits, and conversation state.
 */
export function compileWebPrompt(
  parsed: CodexParsedRequest,
  options: CompileWebPromptOptions,
): PromptCompileResult {
  const normalized = options.normalized ?? CodexPayloadNormalizer.normalize(
    CodexRawPayload.from(parsed._rawBody || parsed),
    {
      ...(options.maxInputImages !== undefined ? { maxImages: options.maxInputImages } : {}),
      parsed,
    },
  );
  const compiler = new WebPromptCompiler({
    assistantName: options.assistantName,
    maxPromptChars: options.maxPromptChars,
  });

  return compiler.compile({
    normalized,
    parsed,
    isNewConversation: options.isNewConversation,
    assistantName: options.assistantName,
    maxPromptChars: options.maxPromptChars,
    toolDelta: options.toolDelta,
    includeEnvironment: options.includeEnvironment,
    includeUserInstruction: options.includeUserInstruction,
  });
}

/**
 * Kiểm tra yêu cầu hiện tại có đang ở Plan Mode (chỉ khảo sát và lập kế hoạch) hay không.
 */
export function isPlanModeRequest(parsed?: CodexParsedRequest): boolean {
  if (!parsed || isImplementingPlanRequest(parsed)) {
    return false;
  }
  const normalized = CodexPayloadNormalizer.normalize(
    CodexRawPayload.from(parsed._rawBody || parsed),
    { parsed },
  );
  return normalized.collaborationMode === "plan";
}
