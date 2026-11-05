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
  thoughtAdherenceRate: number;
  narrativeClarityRate: number;
  toolSuccessRate: number;
  overallCognitiveScore: number;
  turnEvaluations: CognitiveTurnEvaluation[];
}

/**
 * Bộ đánh giá năng lực nhận thức (Cognitive Evaluator)
 * Đo lường mức độ tuân thủ giao thức Cognitive Loop (Thinking -> Narrative -> Tool Action)
 */
export class CognitiveEvaluator {
  private getToolCallIds(message: AgentMessage): string[] {
    if (message.role !== "assistant") return [];

    try {
      const parsed = JSON.parse(message.content) as {
        tool_calls?: Array<{ id?: unknown }>;
      };
      if (!Array.isArray(parsed.tool_calls)) return [];
      return parsed.tool_calls
        .map(call => call?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    } catch {
      return [];
    }
  }

  private hasToolCall(message: AgentMessage): boolean {
    if (message.toolCallId) return true;
    if (message.role !== "assistant") return false;

    try {
      const parsed = JSON.parse(message.content) as {
        tool_calls?: unknown;
      };
      return Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0;
    } catch {
      return false;
    }
  }

  evaluateTurn(
    message: AgentMessage,
    turnIndex: number,
  ): CognitiveTurnEvaluation {
    const hasThought = Boolean(
      message.thinking && message.thinking.trim().length > 0,
    );
    const thoughtLength = message.thinking ? message.thinking.trim().length : 0;
    const hasNarrative = Boolean(
      message.narrative && message.narrative.trim().length > 0,
    );
    const hasToolCall = this.hasToolCall(message);
    const isError = Boolean(message.isError);

    let score = 0;
    if (hasThought) {
      score += 40;
      if (thoughtLength >= 30) score += 10;
    }
    if (hasNarrative) {
      score += 30;
    }
    if (hasToolCall && !isError) {
      score += 20;
    } else if (!hasToolCall) {
      score += 20;
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

  evaluateSession(result: AgentLoopResult): CognitiveSessionMetrics {
    const assistantMessages = result.messages.filter(
      m => m.role === "assistant",
    );
    const toolResultMessages = result.messages.filter(
      m => m.role === "tool_result",
    );
    const failedToolCallIds = new Set(
      toolResultMessages
        .filter(message => message.isError && message.toolCallId)
        .map(message => message.toolCallId as string),
    );

    const turnEvaluations: CognitiveTurnEvaluation[] = assistantMessages.map(
      (msg, idx) =>
        this.evaluateTurn(
          {
            ...msg,
            isError: Boolean(
              msg.isError ||
                this.getToolCallIds(msg).some(callId =>
                  failedToolCallIds.has(callId),
                ),
            ),
          },
          idx + 1,
        ),
    );

    const totalAssistantTurns = assistantMessages.length || 1;
    const turnsWithThought = turnEvaluations.filter(t => t.hasThought).length;
    const turnsWithNarrative = turnEvaluations.filter(
      t => t.hasNarrative,
    ).length;

    const successfulTools = toolResultMessages.filter(m => !m.isError).length;
    const totalTools = toolResultMessages.length || 1;

    const thoughtAdherenceRate = turnsWithThought / totalAssistantTurns;
    const narrativeClarityRate = turnsWithNarrative / totalAssistantTurns;
    const toolSuccessRate =
      toolResultMessages.length > 0 ? successfulTools / totalTools : 1.0;

    const averageTurnScore =
      turnEvaluations.length > 0
        ? turnEvaluations.reduce((sum, t) => sum + t.cognitiveScore, 0) /
          turnEvaluations.length
        : 0;

    let completionBonus = 0;
    if (result.status === "completed") {
      completionBonus = 10;
    } else if (result.status === "failed") {
      completionBonus = -20;
    }

    const overallCognitiveScore = Math.max(
      0,
      Math.min(100, Math.round(averageTurnScore * 0.9 + completionBonus)),
    );

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
