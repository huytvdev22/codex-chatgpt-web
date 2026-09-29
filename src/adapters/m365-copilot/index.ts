import type { AdapterEvent, CodexParsedRequest } from "../../types";
import type { IncomingMeta, ProviderAdapter } from "../base";
import { isTitleRequest, generateTitleResponse } from "./title-guard";
import { compileM365Prompt } from "./prompt";
import { executeM365Turn } from "./browser-worker";

export class M365CopilotAdapter implements ProviderAdapter {
  readonly name = "m365-copilot";

  async runTurn(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void
  ): Promise<void> {
    if (incoming.abortSignal?.aborted) {
      throw new DOMException("M365 Copilot turn aborted before start", "AbortError");
    }

    const compiledPrompt = compileM365Prompt(parsed);

    // 1. Title Guard: Phản hồi tức thì yêu cầu tiêu đề ngầm (5ms)
    if (isTitleRequest(parsed, compiledPrompt)) {
      const titleText = generateTitleResponse(compiledPrompt);
      emit({ type: "text_delta", text: titleText });
      emit({
        type: "done",
        usage: {
          inputTokens: Math.ceil(compiledPrompt.length / 4),
          outputTokens: Math.ceil(titleText.length / 4),
          totalTokens: Math.ceil((compiledPrompt.length + titleText.length) / 4),
        },
      });
      return;
    }

    // 2. Chuyển giao prompt thực tế cho WebContentsView M365 Copilot qua CDP
    try {
      const reply = await executeM365Turn(compiledPrompt, {
        onChunk: (delta) => {
          emit({ type: "text_delta", text: delta });
        },
        signal: incoming.abortSignal,
      });

      const inputTokens = Math.ceil(compiledPrompt.length / 4);
      const outputTokens = Math.ceil(reply.length / 4);

      emit({
        type: "done",
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
      });
    } catch (err: unknown) {
      if (incoming.abortSignal?.aborted) {
        throw new DOMException("M365 Copilot turn aborted", "AbortError");
      }
      const message = err instanceof Error ? err.message : String(err);
      emit({
        type: "error",
        message: `[M365 Copilot] ${message}`,
      });
    }
  }
}

export function createM365CopilotAdapter(): ProviderAdapter {
  return new M365CopilotAdapter();
}
