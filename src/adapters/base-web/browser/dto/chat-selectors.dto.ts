/**
 * Data Transfer Object: Danh mục bộ chọn CSS (Selectors) của giao diện Web Chat
 * Tuân thủ Immutability
 */
export class ChatSelectorsDto {
  readonly editor: string;
  readonly sendButton: string;
  readonly stopButton: string;
  readonly inputWrapper?: string;
  readonly actions?: string;
  readonly dictationButton?: string;

  constructor(params: {
    editor: string;
    sendButton: string;
    stopButton: string;
    inputWrapper?: string;
    actions?: string;
    dictationButton?: string;
  }) {
    if (!params.editor || !params.sendButton || !params.stopButton) {
      throw new Error("[ChatSelectorsDto] editor, sendButton và stopButton là các trường bắt buộc");
    }
    this.editor = params.editor;
    this.sendButton = params.sendButton;
    this.stopButton = params.stopButton;
    this.inputWrapper = params.inputWrapper;
    this.actions = params.actions;
    this.dictationButton = params.dictationButton;
    Object.freeze(this);
  }
}
