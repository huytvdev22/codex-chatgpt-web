import type { CodexMessage } from "../../../../types";
import type { ConversationGuardState } from "../dto/conversation-guard-state.dto";

export interface RecordToolCallResult {
  state: ConversationGuardState;
  isLoopDetected: boolean;
  reason?: string;
}

export interface IConversationLoopGuard {
  getOrCreateState(conversationKey: string): ConversationGuardState;
  recordToolCall(conversationKey: string, toolName: string, rawArgs: unknown): RecordToolCallResult;
  resetIteration(conversationKey: string): void;
  cleanExpired(now?: number): void;
  isAssistantFinalAnswer(msg: CodexMessage | undefined): boolean;
}
