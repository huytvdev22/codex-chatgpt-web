import type { CodexMessage } from "../../../types";
import type { ConversationGuardState } from "../dto/conversation-guard-state.dto";
import type { ToolRepetitionPolicy } from "../dto/tool-repetition-policy.dto";
import type {
  IConversationLoopGuard,
  RecordToolCallResult,
} from "../contracts/conversation-loop-guard.interface";

export const DEFAULT_MAX_TOOL_ITERATIONS = 100;
export const DEFAULT_MAX_IDENTICAL_TOOL_CALLS = 10;
export const DEFAULT_MAX_IDENTICAL_READ_TOOL_CALLS = 20;
export const DEFAULT_MAX_IDENTICAL_WRITE_TOOL_CALLS = 6;
export const DEFAULT_GUARD_TTL_MS = 15 * 60 * 1000; // 15 phút

export const DEFAULT_READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_dir",
  "grep_code",
  "git_status",
  "git_diff",
  "view_file",
  "grep_search",
  "read_url_content",
]);

/**
 * Trình bảo vệ phiên hội thoại chống lặp công cụ vô hạn (Loop Guard).
 * Quản lý trạng thái in-memory theo conversationKey, nhận diện gọi lặp cùng tham số,
 * và tự động dọn dẹp bộ nhớ theo cơ chế TTL / LRU.
 */
export class ConversationLoopGuard implements IConversationLoopGuard {
  private readonly store = new Map<string, ConversationGuardState>();
  private readonly policy: ToolRepetitionPolicy;

  constructor(customPolicy?: Partial<ToolRepetitionPolicy>) {
    this.policy = {
      maxToolIterations: customPolicy?.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS,
      maxIdenticalToolCalls: customPolicy?.maxIdenticalToolCalls ?? DEFAULT_MAX_IDENTICAL_TOOL_CALLS,
      maxIdenticalReadToolCalls: customPolicy?.maxIdenticalReadToolCalls ?? DEFAULT_MAX_IDENTICAL_READ_TOOL_CALLS,
      maxIdenticalWriteToolCalls: customPolicy?.maxIdenticalWriteToolCalls ?? DEFAULT_MAX_IDENTICAL_WRITE_TOOL_CALLS,
      guardTtlMs: customPolicy?.guardTtlMs ?? DEFAULT_GUARD_TTL_MS,
      readOnlyTools: customPolicy?.readOnlyTools ?? DEFAULT_READ_ONLY_TOOLS,
    };
  }

  public getOrCreateState(conversationKey: string): ConversationGuardState {
    let state = this.store.get(conversationKey);
    if (!state) {
      state = {
        toolIterations: 0,
        identicalToolCount: 0,
        updatedAt: Date.now(),
      };
      this.store.set(conversationKey, state);
    }
    return state;
  }

  public recordToolCall(
    conversationKey: string,
    toolName: string,
    rawArgs: unknown
  ): RecordToolCallResult {
    const state = this.getOrCreateState(conversationKey);
    const fingerprint = ConversationLoopGuard.stableToolFingerprint(toolName, rawArgs);

    state.toolIterations += 1;
    if (state.lastToolFingerprint === fingerprint) {
      state.identicalToolCount += 1;
    } else {
      state.lastToolFingerprint = fingerprint;
      state.identicalToolCount = 1;
    }
    state.updatedAt = Date.now();

    const maxIdentical = this.getMaxIdenticalToolCalls(toolName);
    if (state.identicalToolCount > maxIdentical) {
      return {
        state,
        isLoopDetected: true,
        reason: `Vượt quá giới hạn lặp công cụ liên tiếp (${state.identicalToolCount} > ${maxIdentical}) cho '${toolName}'.`,
      };
    }

    if (state.toolIterations > this.policy.maxToolIterations) {
      return {
        state,
        isLoopDetected: true,
        reason: `Vượt quá tổng số lượt gọi công cụ tối đa (${state.toolIterations} > ${this.policy.maxToolIterations}).`,
      };
    }

    return {
      state,
      isLoopDetected: false,
    };
  }

  public resetIteration(conversationKey: string): void {
    const state = this.store.get(conversationKey);
    if (state) {
      state.toolIterations = 0;
      state.identicalToolCount = 0;
      state.lastToolFingerprint = undefined;
      state.updatedAt = Date.now();
    }
  }

  public cleanExpired(now = Date.now()): void {
    for (const [key, state] of this.store.entries()) {
      if (now - state.updatedAt > this.policy.guardTtlMs) {
        this.store.delete(key);
      }
    }
    if (this.store.size > 1000) {
      const entries = [...this.store.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      for (let i = 0; i < Math.min(200, entries.length); i++) {
        this.store.delete(entries[i][0]);
      }
    }
  }

  public isReadOnlyTool(name?: string): boolean {
    if (!name || typeof name !== "string") return false;
    return this.policy.readOnlyTools.has(name.trim().toLowerCase());
  }

  public getMaxIdenticalToolCalls(name?: string): number {
    return this.isReadOnlyTool(name)
      ? this.policy.maxIdenticalReadToolCalls
      : this.policy.maxIdenticalWriteToolCalls;
  }

  public isAssistantFinalAnswer(msg: CodexMessage | undefined): boolean {
    return ConversationLoopGuard.isAssistantFinalAnswer(msg);
  }

  public getRawStore(): Map<string, ConversationGuardState> {
    return this.store;
  }

  // --- Static Utility Methods ---

  public static isReadOnlyTool(name?: string): boolean {
    if (!name || typeof name !== "string") return false;
    return DEFAULT_READ_ONLY_TOOLS.has(name.trim().toLowerCase());
  }

  public static getMaxIdenticalToolCalls(name?: string): number {
    return ConversationLoopGuard.isReadOnlyTool(name)
      ? DEFAULT_MAX_IDENTICAL_READ_TOOL_CALLS
      : DEFAULT_MAX_IDENTICAL_WRITE_TOOL_CALLS;
  }

  public static stableSortValue(value: unknown): unknown {
    if (value === null || typeof value !== "object") {
      if (typeof value === "string") {
        return value.replace(/\\/g, "/").trim();
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(ConversationLoopGuard.stableSortValue);
    }
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = ConversationLoopGuard.stableSortValue(obj[key]);
    }
    return sorted;
  }

  public static stableToolFingerprint(name: string, rawArgs: unknown): string {
    let parsedArgs = rawArgs;
    if (typeof rawArgs === "string") {
      try {
        parsedArgs = JSON.parse(rawArgs);
      } catch {
        parsedArgs = rawArgs.trim();
      }
    }
    const normalized = ConversationLoopGuard.stableSortValue(parsedArgs);
    return `${name.trim()}:${JSON.stringify(normalized)}`;
  }

  public static isToolCallPart(part: unknown): boolean {
    if (!part || typeof part !== "object") return false;
    const p = part as Record<string, unknown>;
    const typeStr = typeof p.type === "string" ? p.type.toLowerCase() : "";
    return (
      typeStr === "toolcall" ||
      typeStr === "tool_call" ||
      typeStr === "function_call" ||
      typeStr === "functioncall" ||
      typeStr === "custom_tool_call" ||
      typeStr === "tool_search_call" ||
      p.call_id !== undefined ||
      p.callId !== undefined ||
      p.function !== undefined
    );
  }

  public static isAssistantFinalAnswer(msg: CodexMessage | undefined): boolean {
    if (!msg || msg.role !== "assistant") return false;
    if (typeof msg.content === "string") {
      if (/<tool[\\_]*call>/i.test(msg.content)) {
        return false;
      }
      return true;
    }
    if (Array.isArray(msg.content)) {
      const hasToolCall = msg.content.some(ConversationLoopGuard.isToolCallPart);
      return !hasToolCall;
    }
    return true;
  }
}
