/**
 * Data Transfer Object: Yêu cầu chọn Model trên giao diện Web Chat
 * Tuân thủ Immutability và Enterprise Validation
 */
export class ModelSelectionRequestDto<TMode extends string = string> {
  readonly targetMode: TMode;
  readonly timeoutMs: number;
  readonly settleDelayMs: number;
  readonly forceReselect: boolean;
  readonly traceId?: string;

  private constructor(params: {
    targetMode: TMode;
    timeoutMs?: number;
    settleDelayMs?: number;
    forceReselect?: boolean;
    traceId?: string;
  }) {
    this.targetMode = params.targetMode;
    this.timeoutMs = params.timeoutMs ?? 5000;
    this.settleDelayMs = params.settleDelayMs ?? 300;
    this.forceReselect = params.forceReselect ?? false;
    this.traceId = params.traceId;
    Object.freeze(this);
  }

  /**
   * Static Factory Method tạo DTO hợp lệ
   */
  public static of<TMode extends string>(
    targetMode: TMode,
    options?: {
      timeoutMs?: number;
      settleDelayMs?: number;
      forceReselect?: boolean;
      traceId?: string;
    }
  ): ModelSelectionRequestDto<TMode> {
    if (!targetMode || typeof targetMode !== "string" || targetMode.trim() === "") {
      throw new IllegalArgumentException("[ModelSelectionRequestDto] targetMode không được rỗng");
    }
    return new ModelSelectionRequestDto({
      targetMode,
      timeoutMs: options?.timeoutMs,
      settleDelayMs: options?.settleDelayMs,
      forceReselect: options?.forceReselect,
      traceId: options?.traceId,
    });
  }

  public toJSON(): Record<string, unknown> {
    return {
      targetMode: this.targetMode,
      timeoutMs: this.timeoutMs,
      settleDelayMs: this.settleDelayMs,
      forceReselect: this.forceReselect,
      traceId: this.traceId,
    };
  }
}

export class IllegalArgumentException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IllegalArgumentException";
  }
}
