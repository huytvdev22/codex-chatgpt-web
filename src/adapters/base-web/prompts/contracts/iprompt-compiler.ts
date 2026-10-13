import type { PromptCompileInput } from "../dto/prompt-compile-input.dto";
import type { PromptCompileResult } from "../dto/prompt-compile-result.dto";

export interface IPromptCompiler {
  compile(input: PromptCompileInput): PromptCompileResult;
}
