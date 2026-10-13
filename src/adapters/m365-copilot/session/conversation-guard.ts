import type { CodexMessage } from "../../../types";
import type { ConversationGuardState } from "./conversation-state";
import {
  ConversationLoopGuard,
  DEFAULT_MAX_TOOL_ITERATIONS,
  DEFAULT_MAX_IDENTICAL_TOOL_CALLS,
  DEFAULT_MAX_IDENTICAL_READ_TOOL_CALLS,
  DEFAULT_MAX_IDENTICAL_WRITE_TOOL_CALLS,
  DEFAULT_GUARD_TTL_MS,
  DEFAULT_READ_ONLY_TOOLS,
} from "../../base-web/session";

export const MAX_TOOL_ITERATIONS = DEFAULT_MAX_TOOL_ITERATIONS;
export const MAX_IDENTICAL_TOOL_CALLS = DEFAULT_MAX_IDENTICAL_TOOL_CALLS;
export const MAX_IDENTICAL_READ_TOOL_CALLS = DEFAULT_MAX_IDENTICAL_READ_TOOL_CALLS;
export const MAX_IDENTICAL_WRITE_TOOL_CALLS = DEFAULT_MAX_IDENTICAL_WRITE_TOOL_CALLS;
export const GUARD_TTL_MS = DEFAULT_GUARD_TTL_MS;
export const READ_ONLY_TOOLS = DEFAULT_READ_ONLY_TOOLS;

const defaultLoopGuard = new ConversationLoopGuard();
export const conversationGuard = defaultLoopGuard.getRawStore();

export const isReadOnlyTool = ConversationLoopGuard.isReadOnlyTool;
export const getMaxIdenticalToolCalls = ConversationLoopGuard.getMaxIdenticalToolCalls;
export const cleanExpiredConversationGuards = (now = Date.now()): void => {
  defaultLoopGuard.cleanExpired(now);
};
export const stableSortValue = ConversationLoopGuard.stableSortValue;
export const stableToolFingerprint = ConversationLoopGuard.stableToolFingerprint;
export const isToolCallPart = ConversationLoopGuard.isToolCallPart;
export const isAssistantFinalAnswer = ConversationLoopGuard.isAssistantFinalAnswer;
