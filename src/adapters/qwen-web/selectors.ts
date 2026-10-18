/**
 * Bộ chọn DOM thực tế cho giao diện Qwen Web (https://chat.qwen.ai).
 * Được xác thực và tinh chỉnh trực tiếp từ cấu trúc HTML của Qwen Web.
 */
export const QWEN_SELECTORS = {
  // Ô nhập tin nhắn (textarea thực thụ)
  composer: 'textarea.message-input-textarea',
  composerFallback: 'div.message-input-container textarea',

  // Nút gửi tin nhắn (khi đã sẵn sàng / enabled)
  sendButton: 'button.send-button:not([disabled]):not(.disabled)',
  // Nút gửi ở trạng thái bị vô hiệu hóa (disabled / chưa có chữ hoặc vừa gửi xong)
  sendButtonDisabled: 'button.send-button.disabled, button.send-button[disabled]',

  // Nút dừng sinh câu trả lời (khi Qwen đang trả lời)
  stopButton: 'button.stop-button, button[aria-label="Stop"], .icon-stop',

  // Khối tin nhắn câu trả lời của Qwen bot
  assistantMessage: '.chat-response-message',
  // Khối nội dung câu trả lời thực tế (loại bỏ phần thinking status card)
  phaseAnswer: '.response-message-content.phase-answer, .custom-qwen-markdown, .qwen-markdown',

  // Khối codeblock markdown được render bên trong câu trả lời
  codeBlock: 'pre.qwen-markdown-code',
  // Nút copy code trên header của codeblock markdown
  codeCopyButton: 'button.qwen-markdown-code-header-action-item[aria-label="Copy"]',
  // Nút copy toàn bộ câu trả lời ở footer tin nhắn
  responseCopyButton: 'button.qwen-chat-package-comp-new-action-control-container-copy',

  // Nút tạo cuộc trò chuyện mới (New Chat) ở sidebar bên trái
  newChatButton: 'div[role="button"][aria-label="New Chat"], .sidebar-entry-fixed-list-content',

  // Bộ chọn chế độ suy nghĩ (Thinking Mode)
  thinkingSelector: '.qwen-thinking-selector',
} as const;

/**
 * Regex kiểm tra URL cuộc trò chuyện của Qwen Web: https://chat.qwen.ai/c/<uuid>
 */
const QWEN_CONVERSATION_URL_REGEX =
  /^https?:\/\/chat\.qwen\.ai\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

const QWEN_CONVERSATION_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Kiểm tra xem một URL có phải là URL cuộc trò chuyện Qwen Web hợp lệ không
 */
export function isQwenConversationUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  return QWEN_CONVERSATION_URL_REGEX.test(url.trim());
}

/**
 * Trích xuất conversation ID (UUID) từ URL của Qwen Web
 */
export function extractConversationIdFromUrl(url: string): string | null {
  if (typeof url !== "string") return null;
  const match = url.trim().match(QWEN_CONVERSATION_URL_REGEX);
  return match?.[1] ? match[1].toLowerCase() : null;
}

/**
 * Kiểm tra xem một chuỗi có phải là Conversation ID hợp lệ của Qwen Web không
 */
export function isValidQwenConversationId(id: string): boolean {
  if (typeof id !== "string") return false;
  return QWEN_CONVERSATION_ID_REGEX.test(id.trim());
}
