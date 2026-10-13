export interface GenericDetectedToolCall {
  readonly id?: string;
  readonly name: string;
  readonly arguments: string | Record<string, unknown>;
}

export type ResponseTranslationKind = "tool_calls" | "final_answer" | "protocol_error";

/**
 * Data Transfer Object: Kết quả dịch phản hồi từ Web Chat sang chuẩn Codex
 * Tuân thủ Immutability
 */
export class ResponseTranslationResultDto {
  readonly kind: ResponseTranslationKind;
  readonly calls: readonly GenericDetectedToolCall[];
  readonly content?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly rawResponse?: string;

  constructor(params: {
    kind: ResponseTranslationKind;
    calls?: readonly GenericDetectedToolCall[];
    content?: string;
    errorCode?: string;
    errorMessage?: string;
    rawResponse?: string;
  }) {
    this.kind = params.kind;
    this.calls = Object.freeze(params.calls ? [...params.calls] : []);
    this.content = params.content;
    this.errorCode = params.errorCode;
    this.errorMessage = params.errorMessage;
    this.rawResponse = params.rawResponse;
    Object.freeze(this);
  }

  public static toolCalls(calls: readonly GenericDetectedToolCall[]): ResponseTranslationResultDto {
    return new ResponseTranslationResultDto({ kind: "tool_calls", calls });
  }

  public static finalAnswer(content: string): ResponseTranslationResultDto {
    return new ResponseTranslationResultDto({ kind: "final_answer", content });
  }

  public static protocolError(code: string, message: string, raw?: string): ResponseTranslationResultDto {
    return new ResponseTranslationResultDto({
      kind: "protocol_error",
      errorCode: code,
      errorMessage: message,
      rawResponse: raw,
    });
  }
}
