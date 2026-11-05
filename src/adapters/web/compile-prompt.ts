import type { CodexParsedRequest } from "../../types";
import { CodexPayloadNormalizer, CodexRawPayload } from "./normalization";
import { M365PromptCompiler, type PromptCompileResult } from "./prompt";

export interface CompileWebPromptOptions {
  assistantName: string;
  isNewConversation: boolean;
}

/**
 * Compiles a provider-neutral Web prompt from the original Codex request.
 * Provider adapters only supply the assistant name and conversation state.
 */
export function compileWebPrompt(
  parsed: CodexParsedRequest,
  options: CompileWebPromptOptions,
): PromptCompileResult {
  const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
  const normalized = CodexPayloadNormalizer.normalize(rawPayload);
  const compiler = new M365PromptCompiler({
    assistantName: options.assistantName,
  });

  return compiler.compile({
    normalized,
    parsed,
    isNewConversation: options.isNewConversation,
    assistantName: options.assistantName,
  });
}
