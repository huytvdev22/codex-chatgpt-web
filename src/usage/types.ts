export type TokenSourceKind = "ai-studio-dom" | "tiktoken";

export interface ProviderReportedTokens {
  beforeContextTokens?: number;
  contextTokens?: number;
  turnDeltaTokens?: number;
  source: "ai-studio-dom";
}

export interface UsageSettings {
  version: 1;
  showChatFooter: boolean;
  updatedAt: string | null;
}

export interface PromptBreakdownMetrics {
  toolDeclarationChars: number;
  developerChars: number;
  historyChars: number;
  toolResultsChars: number;
  environmentChars: number;
  userRequestChars: number;
  finalPromptChars: number;
}

export interface UsageTurnRecord {
  id: string;
  timestamp: string;
  providerId: string;
  profileId?: string;
  modelId: string;
  threadId?: string;
  conversationKey?: string;
  scenario?: string;
  status: "completed" | "failed";
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens?: number;
  tokenSource: TokenSourceKind;
  durationMs: number;
  attempts: number;
  breakdown?: PromptBreakdownMetrics;
}

export function createDefaultUsageSettings(): UsageSettings {
  return {
    version: 1,
    showChatFooter: false,
    updatedAt: null,
  };
}
