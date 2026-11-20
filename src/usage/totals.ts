import { estimateTokens } from "../lib/token-estimate";
import type { CodexUsage } from "../types";
import type { ProviderReportedTokens, TokenSourceKind } from "./types";

/**
 * `inputTokens` already includes cache detail, so cache tokens are never added twice. A provider's
 * explicit total is accepted only when it is at least input+output.
 */
export function usageDisplayTotalTokens(usage: CodexUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const baseTotal = usage.inputTokens + usage.outputTokens;
  const explicitTotal = usage.totalTokens;
  return typeof explicitTotal === "number" ? Math.max(explicitTotal, baseTotal) : baseTotal;
}

export interface ComputeTurnUsageInput {
  prompts: readonly string[];
  rawOutputs: readonly string[];
  providerReportedTokens?: ProviderReportedTokens;
  modelId?: string;
}

export interface AccurateTurnUsageResult {
  usage: CodexUsage;
  tokenSource: TokenSourceKind;
  contextTokens?: number;
}

/**
 * Tính token sử dụng chính xác cho 1 lượt chạy Web Turn:
 * - Ưu tiên số liệu delta đo từ DOM Google AI Studio (nếu có và > 0), phân bổ in/out theo tỷ lệ tiktoken.
 * - Các trường hợp còn lại dùng `tiktoken` (`o200k_base`) thay cho phép chia thô `chars / 4`.
 */
export function computeAccurateTurnUsage(
  input: ComputeTurnUsageInput,
): AccurateTurnUsageResult {
  let estimatedInputTokens = 0;
  for (const prompt of input.prompts) {
    if (prompt) {
      estimatedInputTokens += estimateTokens(prompt, input.modelId);
    }
  }

  let estimatedOutputTokens = 0;
  for (const output of input.rawOutputs) {
    if (output) {
      estimatedOutputTokens += estimateTokens(output, input.modelId);
    }
  }

  const reported = input.providerReportedTokens;
  if (reported && typeof reported.turnDeltaTokens === "number" && reported.turnDeltaTokens > 0) {
    const totalTokens = Math.round(reported.turnDeltaTokens);
    const estTotal = estimatedInputTokens + estimatedOutputTokens;
    let inputTokens: number;
    let outputTokens: number;
    if (estTotal > 0) {
      inputTokens = Math.round((totalTokens * estimatedInputTokens) / estTotal);
      inputTokens = Math.max(0, Math.min(totalTokens, inputTokens));
      outputTokens = totalTokens - inputTokens;
    } else {
      inputTokens = totalTokens;
      outputTokens = 0;
    }
    return {
      usage: { inputTokens, outputTokens, totalTokens },
      tokenSource: reported.source,
      contextTokens: reported.contextTokens,
    };
  }

  const totalTokens = estimatedInputTokens + estimatedOutputTokens;
  return {
    usage: {
      inputTokens: estimatedInputTokens,
      outputTokens: estimatedOutputTokens,
      totalTokens,
    },
    tokenSource: "tiktoken",
    contextTokens: reported?.contextTokens,
  };
}
