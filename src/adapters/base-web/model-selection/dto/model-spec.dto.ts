/**
 * Data Transfer Object: Bản đặc tả thông tin nhận diện của một Model trên Web UI
 */
export class ModelSpecDto<TMode extends string = string> {
  readonly mode: TMode;
  readonly label: string;
  readonly aliasLabels: readonly string[];
  readonly iconTestId?: string;
  readonly isSubmenu: boolean;
  readonly parentMenuIdentifier?: string;
  readonly description?: string;

  constructor(params: {
    mode: TMode;
    label: string;
    aliasLabels?: readonly string[];
    iconTestId?: string;
    isSubmenu?: boolean;
    parentMenuIdentifier?: string;
    description?: string;
  }) {
    if (!params.mode || !params.label) {
      throw new Error("[ModelSpecDto] mode và label là các trường bắt buộc");
    }
    this.mode = params.mode;
    this.label = params.label;
    this.aliasLabels = Object.freeze(params.aliasLabels ?? []);
    this.iconTestId = params.iconTestId;
    this.isSubmenu = params.isSubmenu ?? false;
    this.parentMenuIdentifier = params.parentMenuIdentifier;
    this.description = params.description;
    Object.freeze(this);
  }

  public matchesText(text: string): boolean {
    const normalized = (text || "").trim().toLowerCase();
    if (normalized.includes(this.label.toLowerCase())) return true;
    return this.aliasLabels.some(alias => normalized.includes(alias.toLowerCase()));
  }
}
