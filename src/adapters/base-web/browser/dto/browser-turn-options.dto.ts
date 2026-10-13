import type { TraceContext } from "../../../../observability/types";

export interface BrowserImageAttachment {
  readonly filename: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
  readonly detail?: string;
}

/**
 * Data Transfer Object: Tùy chọn thực thi một lượt tương tác trên trình duyệt
 * Tuân thủ Immutability
 */
export class BrowserTurnOptionsDto {
  readonly onChunk?: (text: string) => void;
  readonly signal?: AbortSignal;
  readonly descriptorPath?: string;
  readonly traceId?: string;
  readonly conversationKey?: string;
  readonly isNewConversation?: boolean;
  readonly shouldStop?: () => boolean;
  readonly modelSlug?: string;
  readonly reasoning?: string;
  readonly traceContext?: TraceContext;
  readonly images: readonly BrowserImageAttachment[];

  constructor(params: {
    onChunk?: (text: string) => void;
    signal?: AbortSignal;
    descriptorPath?: string;
    traceId?: string;
    conversationKey?: string;
    isNewConversation?: boolean;
    shouldStop?: () => boolean;
    modelSlug?: string;
    reasoning?: string;
    traceContext?: TraceContext;
    images?: readonly BrowserImageAttachment[];
  }) {
    this.onChunk = params.onChunk;
    this.signal = params.signal;
    this.descriptorPath = params.descriptorPath;
    this.traceId = params.traceId;
    this.conversationKey = params.conversationKey;
    this.isNewConversation = params.isNewConversation;
    this.shouldStop = params.shouldStop;
    this.modelSlug = params.modelSlug;
    this.reasoning = params.reasoning;
    this.traceContext = params.traceContext;
    this.images = Object.freeze(params.images ? [...params.images] : []);
    Object.freeze(this);
  }

  public static of(params: {
    onChunk?: (text: string) => void;
    signal?: AbortSignal;
    descriptorPath?: string;
    traceId?: string;
    conversationKey?: string;
    isNewConversation?: boolean;
    shouldStop?: () => boolean;
    modelSlug?: string;
    reasoning?: string;
    traceContext?: TraceContext;
    images?: readonly BrowserImageAttachment[];
  }): BrowserTurnOptionsDto {
    return new BrowserTurnOptionsDto(params);
  }
}
