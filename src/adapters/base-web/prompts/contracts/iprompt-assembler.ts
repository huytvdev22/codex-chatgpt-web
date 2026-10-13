import type { CodexParsedRequest } from "../../../../types";

export interface IPromptAssembler {
  assemble(parsed: CodexParsedRequest, isNewConversation?: boolean): string;
}
