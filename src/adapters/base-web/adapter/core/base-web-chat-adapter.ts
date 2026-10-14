import type { AdapterEvent, CodexParsedRequest } from "../../../../types";
import type { IncomingMeta, ProviderAdapter } from "../../../base";
import type { IChatBrowserWorker } from "../../browser/contracts/chat-browser-worker.interface";
import type { IModelSelector } from "../../model-selection/contracts/model-selector.interface";
import { BrowserTurnOptionsDto } from "../../browser/dto/browser-turn-options.dto";
import { TurnExecutionMetaDto } from "../dto/turn-execution-meta.dto";
import { ResponseTranslationResultDto, type GenericDetectedToolCall } from "../dto/response-translation-result.dto";
import { LoopGuardResultDto } from "../dto/loop-guard-result.dto";

/**
 * Lớp trừu tượng hóa điều phối vòng đời của một lượt tương tác (Turn Lifecycle)
 * Áp dụng Template Method Pattern để chuẩn hóa quy trình 10 bước cho mọi Web Chat Adapters
 */
export abstract class BaseWebChatAdapter implements ProviderAdapter {
  abstract readonly name: string;
  abstract readonly browserWorker: IChatBrowserWorker;
  abstract readonly modelSelector?: IModelSelector;

  // ===========================================================================
  // TEMPLATE METHOD: Cố định thuật toán điều phối 10 bước của một Turn
  // ===========================================================================
  public async runTurn(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void
  ): Promise<void> {
    const startTime = Date.now();

    // BƯỚC 1: Kiểm tra AbortSignal trước khi bắt đầu
    if (incoming.abortSignal?.aborted) {
      this.handleEarlyAbort(incoming);
      throw new DOMException(`[${this.name}] Turn aborted before start`, "AbortError");
    }

    // BƯỚC 2: Chuẩn bị siêu dữ liệu thực thi lượt (Execution Meta)
    const meta = this.resolveExecutionMeta(parsed, incoming);

    // BƯỚC 3: Kiểm tra hoàn tất sớm nếu tin nhắn cuối đã là Assistant Final Answer
    if (this.isAssistantAlreadyCompleted(parsed)) {
      console.log(`[${this.name}] Cuộc hội thoại đã kết thúc bằng phản hồi trước đó của trợ lý. Hoàn tất lượt.`);
      this.cleanupSessionGuard(meta.conversationKey);
      this.emitAssistantAlreadyCompleted(meta, emit);
      return;
    }

    // BƯỚC 4: Biên dịch Prompt cho lượt tương tác
    const compiledPrompt = this.buildTurnPrompt(parsed, meta);

    // BƯỚC 5: Đánh chặn nhanh yêu cầu tiêu đề (Title Guard Fast-path)
    if (await this.handleTitleGuardFastPath(parsed, compiledPrompt, meta, emit)) {
      return;
    }

    // BƯỚC 6: Thực thi gửi prompt và thu nhận kết quả từ trình duyệt (kèm vòng lặp Format Retry)
    try {
      const maxFormatRetries = this.getMaxFormatRetries();
      let attemptPrompt = compiledPrompt;
      let reply = "";
      let translationResult: ResponseTranslationResultDto | null = null;
      let totalPromptChars = compiledPrompt.length;
      let previousProtocolFailureFingerprint: string | undefined;

      for (let attempt = 0; attempt <= maxFormatRetries; attempt++) {
        const browserOptions = this.createBrowserTurnOptions(parsed, incoming, meta, attempt);
        reply = await this.browserWorker.executeTurn(attemptPrompt, browserOptions);

        translationResult = this.translateResponse(reply, parsed);
        if (translationResult.kind !== "protocol_error") {
          break;
        }

        // Dừng sớm nếu model/browser trả lại đúng cùng một lỗi với cùng raw
        // response sau Format Retry. Việc tiếp tục gửi cùng chỉ dẫn không thể
        // tự chữa lỗi extraction và chỉ làm model lặp vô ích.
        const normalizedRawResponse = (translationResult.rawResponse || reply)
          .replace(/\s+/g, " ")
          .trim();
        const currentProtocolFailureFingerprint = JSON.stringify({
          code: translationResult.errorCode || "PROTOCOL_ERROR",
          rawResponse: normalizedRawResponse,
        });

        if (
          previousProtocolFailureFingerprint !== undefined &&
          previousProtocolFailureFingerprint === currentProtocolFailureFingerprint
        ) {
          throw new Error(
            `[${this.name} Format Error] Dừng retry sớm vì cùng lỗi protocol ` +
            `'${translationResult.errorCode || "PROTOCOL_ERROR"}' và cùng raw response ` +
            `đã lặp lại sau lần phát lại. Khả năng cao browser extraction hoặc clipboard ` +
            `salvage đang trả lại cùng nội dung lỗi.`
          );
        }

        previousProtocolFailureFingerprint = currentProtocolFailureFingerprint;
        this.emitFormatRetryWarning(attempt, maxFormatRetries, translationResult, meta, reply);

        if (attempt >= maxFormatRetries) {
          throw new Error(
            `[${this.name} Format Error] Đã hủy response sau ${maxFormatRetries + 1} lần vì sai protocol (${translationResult.errorCode}): ${translationResult.errorMessage}`
          );
        }

        const retryPrompt = this.buildFormatRetryPrompt(
          translationResult.errorCode || "PROTOCOL_ERROR",
          translationResult.errorMessage || "Sai định dạng protocol"
        );
        attemptPrompt = retryPrompt;
        totalPromptChars += attemptPrompt.length;
      }

      if (!translationResult || translationResult.kind === "protocol_error") {
        throw new Error(`[${this.name} Format Error] Không nhận được response protocol hợp lệ.`);
      }

      const usage = this.calculateTokenUsage(totalPromptChars, reply.length);

      // BƯỚC 7: Xử lý nếu kết quả là Tool Calls
      if (translationResult.kind === "tool_calls" && translationResult.calls.length > 0) {
        await this.dispatchToolCalls(translationResult.calls, parsed, meta, usage, emit);
        return;
      }

      // BƯỚC 8: Xử lý nếu kết quả là Final Answer
      const finalContent = translationResult.content || "";
      await this.dispatchFinalAnswer(finalContent, meta, usage, emit);

    } catch (error) {
      // BƯỚC 9: Xử lý lỗi ngoại lệ an toàn
      await this.handleTurnError(error, meta, incoming, emit);
    }
  }

  // ===========================================================================
  // EXTENSION POINTS / ABSTRACT HOOKS (Lớp con triển khai cụ thể)
  // ===========================================================================

  protected abstract resolveExecutionMeta(parsed: CodexParsedRequest, incoming: IncomingMeta): TurnExecutionMetaDto;
  protected abstract buildTurnPrompt(parsed: CodexParsedRequest, meta: TurnExecutionMetaDto): string;
  protected abstract translateResponse(rawReply: string, parsed: CodexParsedRequest): ResponseTranslationResultDto;
  protected abstract buildFormatRetryPrompt(code: string, message: string): string;

  // ===========================================================================
  // VIRTUAL HOOKS (Có triển khai mặc định, lớp con có thể override)
  // ===========================================================================

  protected getMaxFormatRetries(): number {
    return 3;
  }

  protected isAssistantAlreadyCompleted(parsed: CodexParsedRequest): boolean {
    const allMsgs = parsed.context.messages || [];
    if (allMsgs.length === 0) return false;
    const lastMsg = allMsgs[allMsgs.length - 1];
    if (lastMsg.role !== "assistant") return false;

    // Nếu assistant message có tool call thì chưa phải là final answer
    if (Array.isArray(lastMsg.content)) {
      const hasToolCall = lastMsg.content.some((part: any) => part.type === "toolCall");
      if (hasToolCall) return false;
    }
    return true;
  }

  protected emitAssistantAlreadyCompleted(meta: TurnExecutionMetaDto, emit: (event: AdapterEvent) => void): void {
    emit({
      type: "done",
      stopReason: "stop",
      endTurn: true,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
  }

  protected async handleTitleGuardFastPath(
    parsed: CodexParsedRequest,
    prompt: string,
    meta: TurnExecutionMetaDto,
    emit: (event: AdapterEvent) => void
  ): Promise<boolean> {
    return false;
  }

  protected createBrowserTurnOptions(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    meta: TurnExecutionMetaDto,
    attempt: number
  ): BrowserTurnOptionsDto {
    return BrowserTurnOptionsDto.of({
      signal: incoming.abortSignal,
      traceId: meta.traceId,
      conversationKey: meta.conversationKey,
      isNewConversation: attempt === 0 ? meta.isNewConversation : false,
      modelSlug: parsed.modelId,
      reasoning: parsed.options.reasoning,
      traceContext: meta.traceContext,
    });
  }

  protected calculateTokenUsage(promptChars: number, replyChars: number): { inputTokens: number; outputTokens: number; totalTokens: number } {
    const inputTokens = Math.ceil(promptChars / 4);
    const outputTokens = Math.ceil((replyChars || 10) / 4);
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }

  protected async dispatchToolCalls(
    calls: readonly GenericDetectedToolCall[],
    parsed: CodexParsedRequest,
    meta: TurnExecutionMetaDto,
    usage: { inputTokens: number; outputTokens: number; totalTokens: number },
    emit: (event: AdapterEvent) => void
  ): Promise<void> {
    for (const call of calls) {
      const callId = call.id || `call_${Math.random().toString(36).slice(2, 10)}`;
      const serializedArgs = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {});
      emit({ type: "tool_call_start", id: callId, name: call.name });
      emit({ type: "tool_call_delta", arguments: serializedArgs });
      emit({ type: "tool_call_end" });
    }
    emit({
      type: "done",
      stopReason: "tool_use",
      endTurn: false,
      usage,
    });
  }

  protected async dispatchFinalAnswer(
    content: string,
    meta: TurnExecutionMetaDto,
    usage: { inputTokens: number; outputTokens: number; totalTokens: number },
    emit: (event: AdapterEvent) => void
  ): Promise<void> {
    if (content) {
      emit({ type: "text_delta", text: content });
    } else {
      emit({ type: "text_delta", text: "" });
    }
    emit({
      type: "done",
      stopReason: "stop",
      endTurn: true,
      usage,
    });
    this.cleanupSessionGuard(meta.conversationKey);
  }

  protected handleEarlyAbort(incoming: IncomingMeta): void {}
  protected cleanupSessionGuard(conversationKey?: string): void {}
  protected emitFormatRetryWarning(
    attempt: number,
    maxRetries: number,
    result: ResponseTranslationResultDto,
    meta: TurnExecutionMetaDto,
    rawReply: string
  ): void {}

  protected async handleTurnError(
    err: unknown,
    meta: TurnExecutionMetaDto,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void
  ): Promise<void> {
    this.cleanupSessionGuard(meta.conversationKey);
    if (incoming.abortSignal?.aborted) {
      throw new DOMException(`[${this.name}] Turn aborted`, "AbortError");
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${this.name}] [error] ${message}`);
    emit({
      type: "error",
      message: `[${this.name}] ${message}`,
    });
  }
}
