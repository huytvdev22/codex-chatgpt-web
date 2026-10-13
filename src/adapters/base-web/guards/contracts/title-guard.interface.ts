import type { CodexParsedRequest } from "../../../../types";

export interface ITitleGuard {
  isEnabled(customFlag?: boolean): boolean;
  isTitleRequest(parsed: CodexParsedRequest, compiledPrompt: string, customFlag?: boolean): boolean;
  generateTitleResponse(compiledPrompt: string): string;
}
