export enum SelectionStatusCode {
  SUCCESS = "SUCCESS",
  ALREADY_ACTIVE = "ALREADY_ACTIVE",
  ITEM_NOT_FOUND = "ITEM_NOT_FOUND",
  MENU_OPEN_FAILED = "MENU_OPEN_FAILED",
  VERIFICATION_FAILED = "VERIFICATION_FAILED",
  TIMEOUT = "TIMEOUT",
  DRIVER_ERROR = "DRIVER_ERROR",
}

/**
 * Data Transfer Object: Kết quả của thao tác chọn Model
 * Cung cấp đầy đủ thông tin kiểm toán (audit/metrics)
 */
export class ModelSelectionResultDto<TMode extends string = string> {
  readonly success: boolean;
  readonly statusCode: SelectionStatusCode;
  readonly targetMode: TMode;
  readonly durationMs: number;
  readonly message?: string;
  readonly previousActiveLabel?: string;
  readonly error?: Error;

  private constructor(params: {
    success: boolean;
    statusCode: SelectionStatusCode;
    targetMode: TMode;
    durationMs: number;
    message?: string;
    previousActiveLabel?: string;
    error?: Error;
  }) {
    this.success = params.success;
    this.statusCode = params.statusCode;
    this.targetMode = params.targetMode;
    this.durationMs = params.durationMs;
    this.message = params.message;
    this.previousActiveLabel = params.previousActiveLabel;
    this.error = params.error;
    Object.freeze(this);
  }

  // --- Static Factory Constructors (Java-style) ---

  public static createSuccess<TMode extends string>(
    targetMode: TMode,
    durationMs: number,
    previousLabel?: string
  ): ModelSelectionResultDto<TMode> {
    return new ModelSelectionResultDto({
      success: true,
      statusCode: SelectionStatusCode.SUCCESS,
      targetMode,
      durationMs,
      previousActiveLabel: previousLabel,
      message: `Chuyển sang model '${targetMode}' thành công`,
    });
  }

  public static createAlreadyActive<TMode extends string>(
    targetMode: TMode,
    durationMs: number,
    activeLabel?: string
  ): ModelSelectionResultDto<TMode> {
    return new ModelSelectionResultDto({
      success: true,
      statusCode: SelectionStatusCode.ALREADY_ACTIVE,
      targetMode,
      durationMs,
      previousActiveLabel: activeLabel,
      message: `Model '${targetMode}' đã được kích hoạt sẵn từ trước trên giao diện`,
    });
  }

  public static createFailure<TMode extends string>(
    targetMode: TMode,
    statusCode: SelectionStatusCode,
    durationMs: number,
    message: string,
    error?: Error
  ): ModelSelectionResultDto<TMode> {
    return new ModelSelectionResultDto({
      success: false,
      statusCode,
      targetMode,
      durationMs,
      message,
      error,
    });
  }

  public isOk(): boolean {
    return this.success;
  }

  public toJSON(): Record<string, unknown> {
    return {
      success: this.success,
      statusCode: this.statusCode,
      targetMode: this.targetMode,
      durationMs: this.durationMs,
      message: this.message,
      previousActiveLabel: this.previousActiveLabel,
      error: this.error ? this.error.message : undefined,
    };
  }
}
