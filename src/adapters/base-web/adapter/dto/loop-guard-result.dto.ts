/**
 * Data Transfer Object: Kết quả kiểm tra bộ bảo vệ chống lặp vô hạn (Loop Guard)
 * Tuân thủ Immutability
 */
export class LoopGuardResultDto {
  readonly blocked: boolean;
  readonly reason?: "repeated_tool_call" | "max_iterations_exceeded";
  readonly warningMessage?: string;
  readonly toolName?: string;
  readonly count?: number;
  readonly maxAllowed?: number;

  constructor(params: {
    blocked: boolean;
    reason?: "repeated_tool_call" | "max_iterations_exceeded";
    warningMessage?: string;
    toolName?: string;
    count?: number;
    maxAllowed?: number;
  }) {
    this.blocked = params.blocked;
    this.reason = params.reason;
    this.warningMessage = params.warningMessage;
    this.toolName = params.toolName;
    this.count = params.count;
    this.maxAllowed = params.maxAllowed;
    Object.freeze(this);
  }

  public static ok(): LoopGuardResultDto {
    return new LoopGuardResultDto({ blocked: false });
  }

  public static blocked(params: {
    reason: "repeated_tool_call" | "max_iterations_exceeded";
    warningMessage: string;
    toolName?: string;
    count?: number;
    maxAllowed?: number;
  }): LoopGuardResultDto {
    return new LoopGuardResultDto({ blocked: true, ...params });
  }
}
