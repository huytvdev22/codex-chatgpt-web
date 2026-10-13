export * from "./dto";
export * from "./contracts";
export * from "./core";

import {
  ConversationLoopGuard,
  DEFAULT_MAX_IDENTICAL_TOOL_CALLS,
  DEFAULT_MAX_IDENTICAL_READ_TOOL_CALLS,
  DEFAULT_MAX_IDENTICAL_WRITE_TOOL_CALLS,
  DEFAULT_MAX_TOOL_ITERATIONS,
} from "./core";

export const conversationLoopGuard = new ConversationLoopGuard();
export const conversationGuard = conversationLoopGuard;
export const cleanExpiredConversationGuards = () => conversationLoopGuard.cleanExpired();
export const MAX_IDENTICAL_TOOL_CALLS = DEFAULT_MAX_IDENTICAL_TOOL_CALLS;
export const MAX_IDENTICAL_READ_TOOL_CALLS = DEFAULT_MAX_IDENTICAL_READ_TOOL_CALLS;
export const MAX_IDENTICAL_WRITE_TOOL_CALLS = DEFAULT_MAX_IDENTICAL_WRITE_TOOL_CALLS;
export const MAX_TOOL_ITERATIONS = DEFAULT_MAX_TOOL_ITERATIONS;
export const stableToolFingerprint = ConversationLoopGuard.stableToolFingerprint;
export const isAssistantFinalAnswer = ConversationLoopGuard.isAssistantFinalAnswer;
export const isReadOnlyTool = (toolName: string) => conversationLoopGuard.isReadOnlyTool(toolName);
export const getMaxIdenticalToolCalls = (toolName: string) => conversationLoopGuard.getMaxIdenticalToolCalls(toolName);
