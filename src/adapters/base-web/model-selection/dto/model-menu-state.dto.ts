/**
 * Data Transfer Object: Trạng thái tức thời của menu chọn Model trên giao diện
 */
export class ModelMenuStateDto {
  readonly isMenuVisible: boolean;
  readonly activeOptionLabel?: string;
  readonly availableOptionLabels: readonly string[];
  readonly timestamp: number;

  constructor(params: {
    isMenuVisible: boolean;
    activeOptionLabel?: string;
    availableOptionLabels?: readonly string[];
  }) {
    this.isMenuVisible = params.isMenuVisible;
    this.activeOptionLabel = params.activeOptionLabel;
    this.availableOptionLabels = Object.freeze(params.availableOptionLabels ?? []);
    this.timestamp = Date.now();
    Object.freeze(this);
  }
}
