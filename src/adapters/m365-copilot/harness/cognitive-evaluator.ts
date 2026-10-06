import { logFunctionInput } from "../debug-logger";
import type { AgentLoopResult, AgentMessage } from "./agent-loop";

export interface CognitiveTurnEvaluation {
  turnIndex: number;
  hasThought: boolean;
  thoughtLength: number;
  hasNarrative: boolean;
  narrativeText?: string;
  hasToolCall: boolean;
  isError: boolean;
  cognitiveScore: number; // 0 - 100
}

export interface CognitiveSessionMetrics {
  totalTurns: number;
  thoughtAdherenceRate: number; // Tỷ lệ phần trăm turn có <thought> (0 - 1.0)
  narrativeClarityRate: number; // Tỷ lệ phần trăm turn có lời dẫn dắt (0 - 1.0)
  toolSuccessRate: number;      // Tỷ lệ thực thi công cụ thành công (0 - 1.0)
  overallCognitiveScore: number;// Điểm nhận thức tổng hợp (0 - 100)
  turnEvaluations: CognitiveTurnEvaluation[];
}

/**
 * Bộ đánh giá năng lực nhận thức (Cognitive Evaluator) dành cho M365 Copilot Adapter
 * Đo lường mức độ tuân thủ giao thức Cognitive Loop (Thinking -> Narrative -> Tool Action)
 */
export class CognitiveEvaluator {
  /**
   * Đánh giá một turn cụ thể trong lịch sử trao đổi của agent
   */
  evaluateTurn(message: AgentMessage, turnIndex: number): CognitiveTurnEvaluation {
    logFunctionInput("harness:cognitive-evaluator", "evaluateTurn", { turnIndex, role: message.role });
    const hasThought = Boolean(message.thinking && message.thinking.trim().length > 0);
    const thoughtLength = message.thinking ? message.thinking.trim().length : 0;
    const hasNarrative = Boolean(message.narrative && message.narrative.trim().length > 0);
    const hasToolCall = Boolean(message.toolCallId || (message.role === "assistant" && message.content.includes("tool_calls")));
    const isError = Boolean(message.isError);

    // Tính điểm nhận thức cho turn (0 - 100)
    let score = 0;
    if (hasThought) {
      score += 40; // 40 điểm cho việc có suy luận nội tâm
      if (thoughtLength >= 30) score += 10; // 10 điểm thưởng nếu suy luận có độ sâu
    }
    if (hasNarrative) {
      score += 30; // 30 điểm cho việc có lời dẫn dắt thân thiện với người dùng
    }
    if (hasToolCall && !isError) {
      score += 20; // 20 điểm cho hành động thực thi thành công
    } else if (!hasToolCall) {
      score += 20; // 20 điểm nếu là final answer hoàn chỉnh
    }

    return {
      turnIndex,
      hasThought,
      thoughtLength,
      hasNarrative,
      narrativeText: message.narrative,
      hasToolCall,
      isError,
      cognitiveScore: Math.min(100, score),
    };
  }

  /**
   * Đánh giá tổng thể phiên làm việc của Agent Loop
   */
  evaluateSession(result: AgentLoopResult): CognitiveSessionMetrics {
    logFunctionInput("harness:cognitive-evaluator", "evaluateSession", { turns: result.turns, status: result.status });
    const assistantMessages = result.messages.filter(m => m.role === "assistant");
    const toolResultMessages = result.messages.filter(m => m.role === "tool_result");

    const turnEvaluations: CognitiveTurnEvaluation[] = assistantMessages.map((msg, idx) =>
      this.evaluateTurn(msg, idx + 1)
    );

    const totalAssistantTurns = assistantMessages.length || 1;
    const turnsWithThought = turnEvaluations.filter(t => t.hasThought).length;
    const turnsWithNarrative = turnEvaluations.filter(t => t.hasNarrative).length;

    const successfulTools = toolResultMessages.filter(m => !m.isError).length;
    const totalTools = toolResultMessages.length || 1;

    const thoughtAdherenceRate = turnsWithThought / totalAssistantTurns;
    const narrativeClarityRate = turnsWithNarrative / totalAssistantTurns;
    const toolSuccessRate = toolResultMessages.length > 0 ? successfulTools / totalTools : 1.0;

    const averageTurnScore = turnEvaluations.length > 0
      ? turnEvaluations.reduce((sum, t) => sum + t.cognitiveScore, 0) / turnEvaluations.length
      : 0;

    // Trừ điểm nếu bị lỗi crash hoặc vượt quá số lượt tối đa
    let completionBonus = 0;
    if (result.status === "completed") {
      completionBonus = 10;
    } else if (result.status === "failed") {
      completionBonus = -20;
    }

    const overallCognitiveScore = Math.max(0, Math.min(100, Math.round(averageTurnScore * 0.9 + completionBonus)));

    return {
      totalTurns: result.turns,
      thoughtAdherenceRate: Math.round(thoughtAdherenceRate * 100) / 100,
      narrativeClarityRate: Math.round(narrativeClarityRate * 100) / 100,
      toolSuccessRate: Math.round(toolSuccessRate * 100) / 100,
      overallCognitiveScore,
      turnEvaluations,
    };
  }
}
