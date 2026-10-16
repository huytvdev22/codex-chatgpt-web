/**
 * Các Selector DOM tiêu chuẩn cho ChatGPT Web (https://chatgpt.com)
 */

export interface ChatGptDomSelectors {
  /**
   * Đường dẫn trang web của ChatGPT
   */
  appUrl: string;

  /**
   * Khung soạn thảo tin nhắn (Composer textarea / contenteditable)
   */
  composerInput: string;

  /**
   * Nút gửi tin nhắn (Send Button)
   */
  sendButton: string;

  /**
   * Nút dừng sinh câu trả lời (Stop Button)
   */
  stopButton: string;

  /**
   * Vùng chứa câu trả lời của Trợ lý (Assistant Response Container)
   */
  responseContainer: string;

  /**
   * Thẻ chứa code Markdown do ChatGPT Web render (Code block)
   */
  codeContainer: string;

  /**
   * Header trang trí của code block (chứa nhãn ngôn ngữ và nút sao chép)
   */
  codeBlockHeader: string;

  /**
   * Nút "Copy code" của khối code Markdown (Code block copy button)
   */
  codeCopyButton: string;

  /**
   * Nút mở menu chuyển đổi Model / Intelligence control
   */
  modelSelectorButton: string;

  /**
   * Menu chứa các options model
   */
  modelMenu: string;

  /**
   * Các nút hoàn tất lượt (dấu hiệu model đã trả lời xong và sẵn sàng lượt mới)
   */
  completionAction: string;

  /**
   * Nút "Show more" (Xem thêm) thu gọn khối code dài
   */
  expandCodeButton: string;

  /**
   * Nút sao chép toàn bộ lượt trả lời (Copy turn)
   */
  turnCopyButton: string;
}

export const CHATGPT_SELECTORS: ChatGptDomSelectors = {
  appUrl: "https://chatgpt.com/?temporary-chat=true",

  // 1. Khung nhập prompt
  composerInput: [
    '#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    'div.ProseMirror[role="textbox"]',
    'div.ProseMirror',
    'form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]',
    'div#prompt-textarea[contenteditable="true"]',
    '[contenteditable="true"][data-lexical-editor="true"]',
    'textarea[data-id="root"]',
  ].join(", "),

  // 2. Nút gửi prompt
  sendButton: [
    '[data-testid="send-button"]',
    'button[data-testid="send-button"]',
    'form[data-chatgpt-composer] button[type="submit"]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="Gửi" i]',
  ].join(", "),

  // 3. Nút dừng khi đang sinh văn bản
  stopButton: [
    '[data-testid="stop-button"]',
    'button[data-testid="stop-button"]',
    'form[data-chatgpt-composer] button[type="button"][aria-label="Stop"]',
    'button[aria-label*="Stop" i]',
    'button[aria-label*="Dừng" i]',
  ].join(", "),

  // 4. Vùng chứa câu trả lời của trợ lý
  responseContainer: [
    '[data-turn-key]',
    '[data-virtualized-turn-content]',
    'article[data-testid^="conversation-turn-"] [data-message-author-role="assistant"]',
    'div[data-message-author-role="assistant"]',
    '[data-message-author-role="assistant"] .markdown',
  ].join(", "),

  // 5. Khối code Markdown do ChatGPT render
  codeContainer: [
    'pre code',
    'div.code-block__wrapper',
    '.dark.bg-gray-950 code',
    'pre',
  ].join(", "),

  // 6. Header của code block
  codeBlockHeader: [
    '.code-block__wrapper > div:first-child',
    '.dark.bg-gray-950 > div:first-child',
  ].join(", "),

  // 7. Nút Sao chép mã của code block (Tầng 1 Copy Button Salvage)
  codeCopyButton: [
    'button[aria-label*="Copy code" i]',
    'button[aria-label*="Sao chép mã" i]',
    'button:has-text("Copy code")',
    'button:has-text("Sao chép mã")',
    'div.code-block__wrapper button',
    '.dark.bg-gray-950 button',
  ].join(", "),

  // 8. Nút mở Menu chọn Model / Effort Control
  modelSelectorButton: [
    'button[data-testid="model-switcher-dropdown-button"]',
    'button[aria-haspopup="menu"][data-tone="neutral"]',
    'button[data-codex-intelligence-trigger="true"]',
    '[data-testid="model-switcher"]',
  ].join(", "),

  // 9. Menu Model
  modelMenu: [
    '[data-testid="composer-intelligence-picker-content"]',
    '[role="menu"]:has([role="menuitemradio"])',
    '[role="menu"]',
  ].join(", "),

  // 10. Dấu hiệu hoàn tất lượt
  completionAction: [
    'button[data-testid="composer-speech-button"]',
    'button[data-testid="copy-turn-action-button"]',
    '[data-turn-key] .turn-action-controls button',
    'button[aria-label="Copy"]',
    'button[aria-label*="Copy" i]',
  ].join(", "),

  // 11. Nút mở rộng khối code dài bị thu gọn (Show more)
  expandCodeButton: [
    'button:has-text("Show more")',
    'button:has-text("Xem thêm")',
    'button[aria-label*="Show more" i]',
    'button[aria-label*="Xem thêm" i]',
  ].join(", "),

  // 12. Nút sao chép toàn bộ lượt trả lời của Assistant
  turnCopyButton: [
    'button[aria-label="Copy"]',
    'button[data-testid="copy-turn-action-button"]',
    '[data-turn-key] .turn-action-controls button[aria-label*="Copy" i]',
  ].join(", "),
};
