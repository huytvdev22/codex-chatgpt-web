/**
 * Bộ chọn DOM chuẩn hóa cho giao diện ChatGPT Web (`chatgpt.com`),
 * được xác minh trực tiếp trên phiên bản UI hiện hành (Model/Power popover,
 * ProseMirror composer, turn containers & copy actions).
 */
export const CHATGPT_SELECTORS = {
  /** Khung nhập tin nhắn chính của ChatGPT (ProseMirror rich-text / markdown) */
  composer: [
    'div.ProseMirror[data-composer-markdown][role="textbox"]',
    'div.ProseMirror[contenteditable="true"][role="textbox"]',
    "#prompt-textarea",
  ].join(", "),

  /** Nút gửi tin nhắn (Send) */
  sendButton: [
    'button[type="submit"][aria-label="Send"]',
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Send"]',
    'button[aria-label="Gửi"]',
  ].join(", "),

  /** Nút dừng sinh câu trả lời (hiển thị khi đang suy nghĩ hoặc stream) */
  stopButton: [
    'button[aria-label="Stop"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop streaming"]',
    'button[data-testid="stop-button"]',
  ].join(", "),

  /** Nút Start Voice xuất hiện khi composer rảnh sau khi hoàn tất câu trả lời */
  startVoiceButton: [
    'button[aria-label="Start Voice"][data-composer-voice-start="true"]',
    'button[aria-label="Start Voice"]',
  ].join(", "),

  /** Nút mở popover chọn Model & Thinking effort nằm trong composer */
  modelPickerTrigger: [
    'button[aria-label="Select ChatGPT model"]',
    'button[data-composer-navigation-target="reasoning"]',
  ].join(", "),

  /** Menu popover Radix đang mở */
  openPickerMenu: [
    '[role="menu"][data-state="open"][data-radix-menu-content]',
    '[role="menu"][data-state="open"]',
  ].join(", "),

  /** Nút chuyển từ view slider sang danh sách chọn model */
  modelViewToggle: [
    '[data-model-picker-view-toggle="true"]',
    '[role="menuitem"][aria-label="Select model"]',
  ].join(", "),

  /** Các tùy chọn model trong danh sách radio */
  modelRadioItem: '[role="menuitemradio"]',

  /** Vùng điều khiển thanh trượt Thinking effort */
  reasoningSliderItem: '[data-reasoning-slider="true"]',
  reasoningSliderThumb: '[role="slider"]',

  /** Nút bật/tắt Thinking trên tài khoản Free khi không có Select ChatGPT model */
  thinkToggleButton: 'form button[aria-pressed]:has-text("Think")',

  /** Vùng nội dung Markdown của Assistant */
  assistantMessage: '[data-markdown-text-style="assistant-message"]',
  responseBodyWrapper:
    "[data-chatgpt-selection-message-id], [data-response-body]",
  turnContainer: "[data-talvt-turn-state]",

  /** Khối code block trong câu trả lời */
  codeBlock: 'div[data-code-block="true"], pre',

  /** Nút copy code nằm trên header code block */
  copyCodeButton: 'button[aria-label="Copy code"]',

  /**
   * Nút copy toàn bộ phản hồi dưới chân assistant turn.
   * Lưu ý: không dùng `button[aria-label="Copy message"]` vì nút đó thuộc user turn.
   */
  copyAssistantMessageButton: [
    'button[aria-label="Copy"]',
    'button[data-testid="copy-turn-action-button"]',
  ].join(", "),

  /** Input ẩn đính kèm ảnh/file */
  photoFileInput: [
    'input[type="file"][aria-label="Attach photos"]',
    'input[type="file"][aria-label="Attach photos or videos"]',
    'input[type="file"][accept*="image"]',
    'input[type="file"][aria-label="Attach files"]',
  ].join(", "),
  addFilesButton: [
    'button[aria-label="Add files and more"]',
    'button[data-composer-navigation-target="add-context"]',
  ].join(", "),

  /** Các banner lỗi/giới hạn ngoài nội dung chat */
  errorBanner: [
    ".text-token-text-error",
    '[role="alert"]',
    '[data-testid="error-banner"]',
  ].join(", "),
} as const;
