import type { CodexParsedRequest } from "../../../../types";
import type { NormalizedCodexRequest } from "../../normalization";

export interface PromptCompileInput {
  normalized: NormalizedCodexRequest;
  parsed?: CodexParsedRequest;
  isPlanMode?: boolean;
  isImplementingPlan?: boolean;
  isNewConversation?: boolean;
}
