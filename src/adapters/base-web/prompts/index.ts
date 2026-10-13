export * from "./dto";
export * from "./contracts";
export * from "./templates";
export * from "./core";

import { BasePromptCompiler } from "./core";
import { CodexPayloadNormalizer } from "../normalization";
export const promptCompiler = new BasePromptCompiler();
export const compileM365Prompt = (parsed: any, optionsOrIsNew?: any): string => {
  const isNew = typeof optionsOrIsNew === "boolean"
    ? optionsOrIsNew
    : (optionsOrIsNew?.isNewConversation ?? true);
  const normalized = CodexPayloadNormalizer.normalize(parsed);
  return promptCompiler.compile({
    parsed,
    normalized,
    isNewConversation: isNew,
  }).finalPrompt;
};
