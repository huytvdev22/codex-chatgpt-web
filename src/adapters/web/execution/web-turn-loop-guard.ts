import type { AdapterEvent, CodexTool, CodexUsage } from "../../../types";
import type { StrictWebResponseResult } from "../protocol/strict-response-parser";
import { WebToolBridge } from "../tools/tool-bridge";
import {
  cleanExpiredConversationGuards,
  conversationGuard,
  getMaxIdenticalToolCalls,
  MAX_TOOL_ITERATIONS,
  stableToolFingerprint,
} from "./turn-guard";

export interface WebTurnLoopGuardInput {
  protocolResult: StrictWebResponseResult;
  clientTools: CodexTool[];
  conversationKey?: string;
  logPrefix: string;
  emit: (event: AdapterEvent) => void;
  usage?: CodexUsage;
  previousToolFailed?: boolean;
  nudgedRepeatedFailure?: boolean;
}

/**
 * Bộ bảo vệ chống vòng lặp vô hạn khi mô hình web yêu cầu gọi cùng một công cụ
 * lặp đi lặp lại hoặc vượt quá tổng số lượt tool call trong một phiên hội thoại.
 */
export class WebTurnLoopGuard {
  private computeFingerprint(
    protocolResult: Extract<StrictWebResponseResult, { kind: "tool_calls" }>,
    clientTools: CodexTool[],
  ): {
    fingerprint: string;
    primaryToolName: string;
  } {
    const mappedCalls = protocolResult.calls.map(rawCall => ({
      rawCall,
      mapped: WebToolBridge.mapToolCall(rawCall, clientTools),
    }));
    const fingerprint = mappedCalls
      .map(call =>
        stableToolFingerprint(call.mapped.name, call.mapped.arguments),
      )
      .sort()
      .join("|");
    return {
      fingerprint,
      primaryToolName: mappedCalls[0]?.mapped.name || "unknown",
    };
  }

  /**
   * Kiểm tra xem lượt tool call vừa nhận có trùng hệt công cụ + tham số của lượt liền trước không.
   */
  public wouldRepeatPreviousToolCall(input: {
    protocolResult: StrictWebResponseResult;
    clientTools: CodexTool[];
    conversationKey?: string;
  }): boolean {
    const { protocolResult, clientTools, conversationKey } = input;
    if (!conversationKey || protocolResult.kind !== "tool_calls") {
      return false;
    }
    cleanExpiredConversationGuards();
    const prevFingerprint = conversationGuard.get(conversationKey)?.lastToolFingerprint;
    if (!prevFingerprint) {
      return false;
    }
    const { fingerprint } = this.computeFingerprint(protocolResult, clientTools);
    return fingerprint === prevFingerprint;
  }

  /**
   * Kiểm tra kết quả giao thức. Trả về true nếu loop guard đã chặn và kết thúc lượt.
   */
  public evaluate(input: WebTurnLoopGuardInput): boolean {
    const {
      protocolResult,
      clientTools,
      conversationKey,
      logPrefix,
      emit,
      usage,
      previousToolFailed,
      nudgedRepeatedFailure,
    } = input;

    if (protocolResult.kind !== "tool_calls") {
      if (conversationKey) {
        conversationGuard.delete(conversationKey);
      }
      return false;
    }

    cleanExpiredConversationGuards();
    const guardKey =
      conversationKey ||
      `transient_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`;
    const guardState = conversationGuard.get(guardKey) || {
      toolIterations: 0,
      identicalToolCount: 0,
      updatedAt: Date.now(),
    };

    guardState.toolIterations += 1;
    guardState.updatedAt = Date.now();
    const { fingerprint: currentFingerprint, primaryToolName: currentToolName } =
      this.computeFingerprint(protocolResult, clientTools);

    if (currentFingerprint === guardState.lastToolFingerprint) {
      guardState.identicalToolCount += 1;
    } else {
      guardState.lastToolFingerprint = currentFingerprint;
      guardState.identicalToolCount = 1;
    }

    conversationGuard.set(guardKey, guardState);

    const maxIdenticalAllowed = getMaxIdenticalToolCalls(currentToolName, {
      previousToolFailed,
    });
    const effectiveRepeatCount =
      guardState.identicalToolCount +
      (previousToolFailed && nudgedRepeatedFailure ? 1 : 0);
    if (effectiveRepeatCount >= maxIdenticalAllowed) {
      console.warn(
        `[${logPrefix}] Ngắt vòng lặp: Công cụ ${currentToolName} bị gọi lặp lại ${guardState.identicalToolCount} lần liên tiếp${previousToolFailed ? " sau khi thất bại" : ""}.`,
      );
      conversationGuard.delete(guardKey);
      const warningText = previousToolFailed
        ? `\n\n> [!WARNING]\n> **Phát hiện vòng lặp lỗi công cụ (Repeated Failed Tool Calls):** Công cụ \`${currentToolName}\` vừa thất bại ở lượt trước nhưng vẫn bị yêu cầu lặp lại ${guardState.identicalToolCount} lần liên tiếp với cùng tham số${nudgedRepeatedFailure ? " (dù đã nhắc đổi hướng)" : ""}. Hệ thống tự động dừng để tránh lặp vô hạn.`
        : `\n\n> [!WARNING]\n> **Phát hiện vòng lặp vô hạn (Repeated Tool Calls):** Công cụ \`${currentToolName}\` đã được yêu cầu lặp lại ${maxIdenticalAllowed} lần liên tiếp với cùng tham số. Hệ thống tự động kết thúc để bảo vệ môi trường làm việc.`;
      emit({
        type: "text_delta",
        text: warningText,
      });
      emit({
        type: "done",
        stopReason: "stop",
        endTurn: true,
        usage,
      });
      return true;
    }

    if (guardState.toolIterations > MAX_TOOL_ITERATIONS) {
      console.warn(
        `[${logPrefix}] Ngắt vòng lặp: Vượt quá giới hạn tối đa ${MAX_TOOL_ITERATIONS} lượt gọi công cụ trong phiên.`,
      );
      conversationGuard.delete(guardKey);
      emit({
        type: "text_delta",
        text: `\n\n> [!WARNING]\n> **Giới hạn an toàn (Max Tool Iterations Exceeded):** Đã chạm ngưỡng tối đa ${MAX_TOOL_ITERATIONS} lượt thực thi công cụ liên tiếp trong phiên. Hệ thống tự động kết thúc để bảo vệ tài nguyên.`,
      });
      emit({
        type: "done",
        stopReason: "stop",
        endTurn: true,
        usage,
      });
      return true;
    }

    return false;
  }

  public clear(conversationKey?: string): void {
    if (conversationKey) {
      conversationGuard.delete(conversationKey);
    }
  }
}
