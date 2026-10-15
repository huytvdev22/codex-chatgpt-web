/**
 * Cấu trúc các Selector trên giao diện Google Gemini Web (https://gemini.google.com)
 *
 * Lưu ý: Google thường dùng Web Components (<rich-textarea>) và có thể xáo trộn (obfuscate)
 * các class CSS. Do đó, ưu tiên sử dụng selector theo thẻ ngữ nghĩa, thuộc tính role,
 * aria-label, hoặc cấu trúc DOM ổn định.
 */

export interface GeminiDomSelectors {
  /**
   * Vùng nhập tin nhắn (Input / Editor)
   * Gemini thường dùng thẻ <rich-textarea> bên trong có contenteditable <p> hoặc <div.ql-editor>
   */
  editor: string;

  /**
   * Nút gửi tin nhắn (Send button)
   * Nút gửi xuất hiện khi đã có văn bản trong editor
   */
  sendButton: string;

  /**
   * Nút dừng sinh câu trả lời (Stop generating button)
   * Khi Gemini đang viết câu trả lời, nút Send sẽ biến thành nút Stop
   */
  stopButton: string;

  /**
   * Vùng chứa toàn bộ câu trả lời cuối cùng của Gemini (Response message container)
   * Thường là các thẻ <message-content> hoặc div.response-content
   */
  responseContainer: string;

  /**
   * Khối suy nghĩ nội tâm (Thinking block - dành cho model Gemini Thinking)
   * Thường là thẻ collapsible hoặc có class "thinking-content" cần lọc bỏ khi parse
   */
  thinkingBlock?: string;

  /**
   * Nút / Menu chuyển đổi Model (Model Picker Menu)
   * Nút dropdown ở góc trên (ví dụ chọn 2.0 Flash / Advanced / Pro)
   */
  modelSelectorButton?: string;

  /**
   * Nút tạo cuộc trò chuyện mới (New Chat Button)
   * Nút ở sidebar (ví dụ [aria-label*="New chat"], [aria-label*="Cuộc trò chuyện mới"])
   */
  newChatButton?: string;

  /**
   * Nút Sao chép phản hồi (Copy button)
   * Dùng để nhận diện câu trả lời đã sinh xong hoàn tất
   */
  copyButton?: string;

  /**
   * Nhãn text hiển thị model hiện tại trên nút trigger (ví dụ "Flash-Lite", "Pro")
   */
  currentModelLabel?: string;

  /**
   * Khung menu danh sách model sau khi click nút trigger
   */
  modelMenuContainer?: string;

  /**
   * Từng mục model trong menu
   */
  modelMenuItem?: string;

  /**
   * Thẻ chứa tên của model trong menu item
   */
  modelMenuItemLabel?: string;

  /**
   * Mục mở submenu cấp độ tư duy (Thinking Level)
   */
  thinkingSubmenuTrigger?: string;

  /**
   * Khung submenu cấp độ tư duy
   */
  thinkingSubmenuContainer?: string;

  /**
   * Từng mục cấp độ tư duy (Thấp, Trung bình, Cao)
   */
  thinkingSubmenuItem?: string;
}

/**
 * Cấu hình selector mặc định cho Gemini Web.
 * Có thể ghi đè linh hoạt qua biến môi trường hoặc khi người dùng cập nhật selector mới.
 */
export const GEMINI_SELECTORS: GeminiDomSelectors = {
  // 1. Ô nhập tin nhắn (Chat Input / Editor)
  editor: [
    'rich-textarea div[contenteditable="true"]',
    'rich-textarea .ql-editor[contenteditable="true"]',
    'rich-textarea div[role="textbox"]',
    'div[data-test-id="textarea-inner"] [contenteditable="true"]',
    'div.ql-editor[contenteditable="true"]',
    'rich-textarea p',
    '[aria-label*="Nhập câu lệnh cho Gemini" i]',
    '[aria-label*="Hỏi Gemini" i]',
    'div[contenteditable="true"]',
    'div[role="textbox"]',
  ].join(", "),

  // 2. Nút gửi tin nhắn (Send button)
  sendButton: [
    'button[aria-label*="Gửi câu lệnh" i]',
    'button[aria-label*="Gửi" i]:not([aria-label*="Ngừng" i]):not([aria-label*="Dừng" i])',
    'button[aria-label*="Send" i]:not([aria-label*="Stop" i])',
    'button:has(mat-icon[fonticon="send"])',
    'button:has(mat-icon[data-mat-icon-name="send"])',
    'button.send-button:not([disabled])',
    'button[data-test-id="send-button"]',
  ].join(", "),

  // 3. Nút dừng tạo (khi đang streaming)
  stopButton: [
    'button[aria-label="Ngừng tạo câu trả lời"]',
    'button[aria-label*="Ngừng tạo" i]',
    'button[aria-label*="Dừng" i]',
    'button[aria-label*="Stop" i]',
    'button:has(mat-icon[fonticon="stop"])',
    'button:has(mat-icon[data-mat-icon-name="stop"])',
    'button.stop-button',
    '[data-test-id="stop-button"]',
    '.stop-generating-button',
  ].join(", "),

  // 4. Vùng chứa nội dung phản hồi của Gemini
  responseContainer: [
    'message-content',
    '.model-response-text',
    'model-response',
    '.response-content',
    'div[data-test-id="model-response"]',
    '.chat-history message-content:last-of-type',
  ].join(", "),

  // 5. Khối suy nghĩ nội tâm (Thinking block - nếu có)
  thinkingBlock: [
    '.thinking-content',
    'collapsible-thought-block',
    '[data-test-id="thought-container"]',
    'details.thought-process',
  ].join(", "),

  // 6. Menu chọn Model (Model Selector Button)
  modelSelectorButton: [
    '[data-test-id="bard-mode-menu-button"] button',
    '[data-test-id="bard-mode-menu-button"]',
    'button[aria-label*="Mở công cụ chọn chế độ" i]',
    'button[aria-label*="chọn chế độ" i]',
    '.gds-mode-switch-button button',
    '.logo-pill-btn button',
    'bard-mode-switcher button',
  ].join(", "),

  // 7. Nút New Chat
  newChatButton: [
    'button[aria-label*="New chat" i]',
    'button[aria-label*="Cuộc trò chuyện mới" i]',
    'a[aria-label*="New chat" i]',
    'a[href="/app"]',
  ].join(", "),

  // 8. Nút Copy (dấu hiệu đã hoàn thành)
  copyButton: [
    'button[aria-label*="Copy" i]',
    'button[aria-label*="Sao chép" i]',
    '[data-test-id="copy-button"]',
  ].join(", "),

  // 9. Nhãn model hiện tại trên nút trigger
  currentModelLabel: [
    'button[data-test-id="bard-mode-menu-button"] .picker-primary-text',
    'button[data-test-id="bard-mode-menu-button"] [data-test-id="logo-pill-label-container"] span',
    '.pill-ui-logo-container .picker-primary-text',
  ].join(", "),

  // 10. Khung menu danh sách model
  modelMenuContainer: [
    'gem-menu[data-test-id="gem-mode-menu"]',
    'div[role="menu"][data-test-id="gem-mode-menu"]',
    '.cdk-overlay-container gem-menu[role="menu"]',
  ].join(", "),

  // 11. Từng mục model trong menu
  modelMenuItem: [
    'gem-menu-item[role="menuitem"]:not([value="thinking_level"])',
    '[data-test-id^="bard-mode-option-"]',
  ].join(", "),

  // 12. Thẻ chứa tên của model trong menu
  modelMenuItemLabel: [
    '.label-container .label',
    '.label',
  ].join(", "),

  // 13. Mục mở submenu Cấp độ tư duy
  thinkingSubmenuTrigger: [
    'gem-menu-item[value="thinking_level"]',
    'gem-menu-item:has(.label:has-text("Cấp độ tư duy"))',
    'gem-menu-item:has-text("Cấp độ tư duy")',
  ].join(", "),

  // 14. Khung submenu Cấp độ tư duy
  thinkingSubmenuContainer: [
    '.submenu-container gem-menu',
    '.cdk-overlay-pane .submenu-container',
  ].join(", "),

  // 15. Từng mục cấp độ tư duy (Thấp, Trung bình, Cao)
  thinkingSubmenuItem: [
    '.submenu-container gem-menu-item[role="menuitem"]',
    '.submenu-container .label',
  ].join(", "),
};
