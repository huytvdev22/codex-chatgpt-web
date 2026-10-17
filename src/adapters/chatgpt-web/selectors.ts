/**
 * Các bộ chọn DOM (Selectors) cho giao diện ChatGPT Web
 * Được xây dựng dựa trên cấu trúc DOM thực tế được cung cấp bởi người dùng.
 */

export const CHATGPT_SELECTORS = {
  /** Khung nhập tin nhắn chính của ChatGPT (ProseMirror rich-text / markdown) */
  composer: [
    'div.ProseMirror[data-composer-markdown][role="textbox"]',
    '#prompt-textarea',
    'div[contenteditable="true"][role="textbox"]',
    'div.ProseMirror',
  ].join(", "),

  /** Nút gửi tin nhắn (Send button) */
  sendButton: [
    'button[type="submit"][aria-label="Send"]',
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
  ].join(", "),

  /** Nút dừng sinh câu trả lời (hiển thị trong quá trình model đang stream/suy nghĩ) */
  stopButton: [
    'button[type="button"][aria-label="Stop"]',
    'button[aria-label="Stop generating"]',
    'button[data-testid="stop-button"]',
  ].join(", "),

  /**
   * Nút Start Voice (xuất hiện sau khi câu trả lời hoàn tất và nút Stop biến mất)
   * Đây là tín hiệu nhận diện chính xác nhất việc ChatGPT đã sinh xong nội dung.
   */
  startVoiceButton: [
    'button[type="button"][aria-label="Start Voice"]',
    'button[aria-label="Start Voice"]',
  ].join(", "),

  /**
   * Nút bật/tắt chế độ Think (Suy nghĩ)
   * Trạng thái nhận diện qua aria-pressed="true" (bật) / "false" (tắt)
   */
  thinkButton: [
    'button[type="button"]:has(span:text-is("Think"))',
    'button:has(span:text-is("Think"))',
    'button:has-text("Think")',
  ].join(", "),

  /**
   * Khối tin nhắn của Assistant (ChatGPT)
   */
  assistantMessage: [
    'div[data-chatgpt-selection-message-id]',
    '[data-markdown-text-style="assistant-message"]',
    'article[data-testid^="conversation-turn-"]',
  ].join(", "),

  /**
   * Khối code block chứa phản hồi 4-backtick <webResponse>
   */
  codeBlock: [
    'div[data-code-block="true"]',
    '.CodeBlock-zu1QM3',
  ].join(", "),

  /**
   * Nút copy code nằm ngay trên header của code block
   */
  copyCodeButton: [
    'button[aria-label="Copy code"]',
    'div[data-code-block="true"] button[aria-label="Copy code"]',
    'button:has(svg use[href*="copy"])',
  ].join(", "),

  /**
   * Nút copy toàn bộ tin nhắn dưới chân message
   */
  copyMessageButton: [
    'button[aria-label="Copy"]',
    'button[data-testid="copy-turn-action-button"]',
  ].join(", "),

  /** Các thông báo lỗi nếu có */
  errorBanner: [
    '.text-token-text-error',
    '[data-testid="temporary-chat-banner"]',
  ].join(", "),
} as const;
