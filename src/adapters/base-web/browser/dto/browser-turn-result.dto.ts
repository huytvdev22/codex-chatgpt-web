/**
 * Data Transfer Object: Kết quả của lượt tương tác trình duyệt
 * Tuân thủ Immutability
 */
export class BrowserTurnResultDto {
  readonly text: string;
  readonly durationMs: number;
  readonly wasSalvaged: boolean;

  constructor(params: {
    text: string;
    durationMs: number;
    wasSalvaged?: boolean;
  }) {
    this.text = params.text;
    this.durationMs = params.durationMs;
    this.wasSalvaged = params.wasSalvaged ?? false;
    Object.freeze(this);
  }

  public static of(params: {
    text: string;
    durationMs: number;
    wasSalvaged?: boolean;
  }): BrowserTurnResultDto {
    return new BrowserTurnResultDto(params);
  }
}
