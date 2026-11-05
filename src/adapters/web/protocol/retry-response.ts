import { buildM365FormatRetryPrompt } from "../prompt";
import type { StrictWebResponseResult } from "./strict-response-parser";

export type SuccessfulWebProtocolResult = Exclude<
  StrictWebResponseResult,
  { kind: "protocol_error" }
>;

export interface WebProtocolRetryAttempt {
  attempt: number;
  prompt: string;
  isRetry: boolean;
}

export interface RunWebProtocolRetryOptions {
  initialPrompt: string;
  maxRetries: number;
  providerName: string;
  abortSignal?: AbortSignal;
  execute: (
    context: WebProtocolRetryAttempt,
  ) => Promise<StrictWebResponseResult>;
  onProtocolError?: (
    result: Extract<StrictWebResponseResult, { kind: "protocol_error" }>,
    context: WebProtocolRetryAttempt,
  ) => void;
}

/**
 * Runs the provider-neutral strict-response retry loop.
 *
 * Browser execution, response sanitization and tool validation remain
 * injectable so each provider can preserve its own runtime behavior.
 */
export async function runWebProtocolRetry(
  options: RunWebProtocolRetryOptions,
): Promise<SuccessfulWebProtocolResult> {
  let attemptPrompt = options.initialPrompt;
  let lastResult: StrictWebResponseResult | null = null;

  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    if (options.abortSignal?.aborted) {
      throw new DOMException(
        `${options.providerName} turn aborted`,
        "AbortError",
      );
    }

    const context: WebProtocolRetryAttempt = {
      attempt,
      prompt: attemptPrompt,
      isRetry: attempt > 0,
    };

    lastResult = await options.execute(context);
    if (lastResult.kind !== "protocol_error") {
      return lastResult;
    }

    options.onProtocolError?.(lastResult, context);
    if (attempt < options.maxRetries) {
      attemptPrompt = buildM365FormatRetryPrompt({
        code: lastResult.code,
        message: lastResult.message,
      });
    }
  }

  if (lastResult?.kind === "protocol_error") {
    throw new Error(
      `[${options.providerName} Format Error] Đã thử ${options.maxRetries + 1} lần nhưng phản hồi vẫn sai protocol (${lastResult.code}): ${lastResult.message}`,
    );
  }

  throw new Error(
    `[${options.providerName} Format Error] Không nhận được response protocol hợp lệ.`,
  );
}
