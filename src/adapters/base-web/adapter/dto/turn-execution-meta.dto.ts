import type { TraceContext } from "../../../../observability/types";

/**
 * Data Transfer Object: Siêu dữ liệu thực thi lượt tương tác
 * Tuân thủ Immutability
 */
export class TurnExecutionMetaDto {
  readonly conversationKey?: string;
  readonly isNewConversation: boolean;
  readonly traceContext?: TraceContext;
  readonly traceId?: string;

  constructor(params: {
    conversationKey?: string;
    isNewConversation: boolean;
    traceContext?: TraceContext;
    traceId?: string;
  }) {
    this.conversationKey = params.conversationKey;
    this.isNewConversation = params.isNewConversation;
    this.traceContext = params.traceContext;
    this.traceId = params.traceId;
    Object.freeze(this);
  }

  public static of(params: {
    conversationKey?: string;
    isNewConversation: boolean;
    traceContext?: TraceContext;
    traceId?: string;
  }): TurnExecutionMetaDto {
    return new TurnExecutionMetaDto(params);
  }
}
