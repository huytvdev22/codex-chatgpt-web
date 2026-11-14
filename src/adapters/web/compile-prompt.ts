import type { CodexParsedRequest } from "../../types";
import {
  CodexPayloadNormalizer,
  CodexRawPayload,
  type NormalizedCodexRequest,
} from "./normalization";
import { WebPromptCompiler, type PromptCompileResult } from "./prompt";

export interface CompileWebPromptOptions {
  assistantName: string;
  isNewConversation: boolean;
  maxPromptChars?: number;
  maxInputImages?: number;
  normalized?: NormalizedCodexRequest;
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
    options.maxInputImages !== undefined ? { maxImages: options.maxInputImages } : undefined,
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
  });
}
