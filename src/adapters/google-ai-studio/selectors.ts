/**
 * Bộ chọn DOM và Tiện ích URL cho Google AI Studio (aistudio.google.com).
 * Đã được kiểm tra và xác thực trực tiếp trên giao diện thực tế.
 */

export const GOOGLE_AI_STUDIO_ORIGIN = "https://aistudio.google.com";
export const GOOGLE_AI_STUDIO_NEW_CHAT_URL = "https://aistudio.google.com/u/0/prompts/new_chat?model=gemini-flash-latest";

export interface GoogleAIStudioDomSelectors {
  /** Ô nhập prompt chính (textarea) */
  composer: string;
  composerFallback: string;

  /** Nút Run khi sẵn sàng gửi */
  runButton: string;
  runButtonGeneric: string;

  /** Nút Stop khi đang sinh câu trả lời */
  stopButton: string;

  /** Thẻ chứa turn trả lời của model */
  chatTurn: string;

  /** Vùng chứa text output của model */
  textChunk: string;

  /** Vùng suy nghĩ nội tâm (Thinking Chunk) cần lọc bỏ */
  thoughtChunk: string;

  /** Output chunk dự phòng */
  outputChunkFallback: string;

  /** Component chọn Thinking Level */
  thinkingSettingWrapper: string;
  thinkingSelectTrigger: string;
  thinkingCurrentValue: string;
  thinkingSelectPanel: string;
  thinkingOptionItem: string;

  /** Nút Reset / New Prompt */
  newChatButton: string;
}

export const AI_STUDIO_SELECTORS: GoogleAIStudioDomSelectors = {
  // 1. Ô nhập prompt
  composer: 'textarea[aria-label="Start typing a prompt"], textarea[aria-label="Type something or tab to choose an example prompt"], textarea[aria-label="Enter a prompt"]',
  composerFallback: 'ms-prompt-editor textarea, div.buttons-row textarea',

  // 2. Nút Run / Send
  runButton: 'ms-run-button button:not(.stoppable)',
  runButtonGeneric: 'ms-run-button button',

  // 3. Nút Stop khi đang sinh câu trả lời
  stopButton: 'ms-run-button button.stoppable, ms-run-button button',

  // 4. Output phản hồi
  chatTurn: 'ms-chat-turn',
  textChunk: 'ms-chat-turn .model-prompt-container ms-text-chunk',
  thoughtChunk: 'ms-thought-chunk',
  outputChunkFallback: 'div.output-chunk',

  // 5. Cấu hình Thinking Level Setting
  thinkingSettingWrapper: 'ms-thinking-level-setting',
  thinkingSelectTrigger: 'ms-thinking-level-setting mat-select[aria-label="Thinking Level"], ms-thinking-level-setting mat-select',
  thinkingCurrentValue: 'ms-thinking-level-setting .mat-mdc-select-value-text .mat-mdc-select-min-line, ms-thinking-level-setting .mat-mdc-select-value',
  thinkingSelectPanel: 'div.mat-mdc-select-panel[aria-label="Thinking Level"], div[role="listbox"][aria-label="Thinking Level"]',
  thinkingOptionItem: 'mat-option',

  // 6. New chat / Reset
  newChatButton: 'a[href*="/prompts/new_chat"], button[aria-label*="New prompt"], button[aria-label*="Create prompt"]',
};

const PROMPT_URL_REGEX = /^https?:\/\/aistudio\.google\.com(?:\/u\/\d+)?\/prompts\/([A-Za-z0-9_-]+)\b/i;

/**
 * Trích xuất Prompt ID từ URL của Google AI Studio (bỏ qua 'new_chat').
 */
export function parseGoogleAIStudioPromptId(rawUrl: string): string | undefined {
  if (typeof rawUrl !== "string") return undefined;
  try {
    const match = rawUrl.trim().match(PROMPT_URL_REGEX);
    const id = match?.[1];
    if (!id || id.toLowerCase() === "new_chat") return undefined;
    return id;
  } catch {
    return undefined;
  }
}

/**
 * Tạo URL tiếp tục đoạn chat cũ từ Prompt ID.
 */
export function buildGoogleAIStudioPromptUrl(promptId: string): string {
  const cleanId = promptId.trim();
  return `https://aistudio.google.com/u/0/prompts/${encodeURIComponent(cleanId)}`;
}

