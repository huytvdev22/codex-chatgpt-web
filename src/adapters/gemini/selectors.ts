/**
 * Bộ chọn DOM chuẩn hóa cho giao diện Gemini Web (`gemini.google.com`),
 * được xác minh trực tiếp qua Playwright CDP trên tài khoản thật.
 */
export const GEMINI_SELECTORS = {
  /** Khung nhập tin nhắn chính của Gemini (Angular rich-textarea / Quill editor) */
  composer: [
    'rich-textarea .ql-editor[contenteditable="true"][role="textbox"]',
    'div.ql-editor[contenteditable="true"][role="textbox"]',
    'rich-textarea [contenteditable="true"]',
    '[role="textbox"][contenteditable="true"]',
  ].join(", "),

  /** Nút gửi tin nhắn (Send) */
  sendButton: [
    'button[aria-label="Send message"]',
    "button.send-button",
    'button[aria-label*="Send" i]',
  ].join(", "),

  /** Nút dừng sinh câu trả lời */
  stopButton: [
    'button[aria-label="Stop response"]',
    'button[aria-label*="Stop generating" i]',
    'button[aria-label*="Stop streaming" i]',
    'button[aria-label*="Stop" i]',
  ].join(", "),

  /** Nút mở Mode / Model Picker nằm trong khu vực composer */
  modePickerTrigger: 'button[data-test-id="bard-mode-menu-button"]',
  modePickerPrimaryText:
    '[data-test-id="logo-pill-label-container"] .picker-primary-text',

  /** Menu popover Mode Picker đang mở */
  modeMenu: [
    'gem-menu[data-test-id="gem-mode-menu"]',
    '[data-test-id="bard-mode-desktop-gem-menu"] gem-menu[role="menu"]',
    'gem-menu[role="menu"][data-visible="true"]',
  ].join(", "),

  /** Các tùy chọn model/mode trong danh sách radio */
  modeRadioItem:
    'gem-menu-item[role="menuitemradio"][data-mode-id], gem-menu-item[role="menuitemradio"]',

  /** Mục mở submenu Thinking level (Low / Medium / High) */
  thinkingLevelTrigger: 'gem-menu-item[value="thinking_level"]',

  /** Nút bật / tắt Temporary Chat */
  tempChatOnButton: [
    'button[aria-label="Turn on temporary chat"]',
    '[data-test-id="temp-chat-button-container"] button[aria-label*="temporary chat" i]',
  ].join(", "),
  tempChatOffButton: 'button[aria-label="Turn off temporary chat"]',

  /** Nút mở menu Upload & tools và thẻ input file ảnh ẩn */
  uploadAndToolsButton: 'button[aria-label="Upload & tools"]',
  imageFileInput:
    'input[type="file"][accept*="image/"], input[type="file"][accept*="image"]',
  attachmentPreview: "uploader-file-preview, gem-media-attachment",
  attachmentLoading:
    "span.gem-attachment-content.loading, .gem-attachment-loading-container",

  /** Vùng turn & nội dung Markdown của Assistant */
  assistantResponse: "model-response",
  assistantMessage:
    "model-response message-content .markdown-main-panel, model-response message-content, message-content .markdown-main-panel",
  thinkingContainers: "thinking-overlay, model-thoughts, .thoughts-container",

  /** Khối code block & các nút Copy */
  codeBlock: "code-block, pre",
  codeBlockDecoration: ".code-block-decoration",
  copyCodeButton:
    'gem-icon-button[data-test-id="gem-copy-button"] button, button[aria-label="Copy code"]',
  copyAssistantResponseButton: 'button[aria-label="Copy"]',
  redoButton: 'button[aria-label="Redo"]',

  /** Các banner lỗi / cảnh báo hệ thống ngoài vùng nội dung chat */
  errorBanner: [
    ".error-banner",
    '[role="alert"]',
    "mat-snack-bar-container",
    "simple-snack-bar",
  ].join(", "),

  /** Điều khiển chế độ tạo ảnh (Upload & tools -> Create image, Aspect ratio, Format) */
  createImageMenuItem:
    'gem-menu-item[role="menuitemcheckbox"], [role="menuitemcheckbox"]',
  deselectImagesChip: 'button[aria-label="Deselect Images"]',
  companionChipButtons: "input-companion-chip button, input-companion button",
  aspectRatioChipButton: 'button[aria-label^="Aspect ratio,"]',
  formatChipButton: 'button[aria-label^="Format,"]',
  companionMenuRadioItem:
    'input-companion-item[role="menuitemradio"], [role="menuitemradio"]',

  /** Kết quả ảnh sinh ra trong model-response (scoped tách biệt khỏi Download code) */
  generatedImageElement:
    "model-response generated-image img, model-response single-image img, model-response img.image",
} as const;
