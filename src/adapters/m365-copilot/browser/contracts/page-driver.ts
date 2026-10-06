import type { Page } from "playwright-core";
import type { TraceContext } from "../../../../observability/types";
import type { M365MarkdownBlock } from "../../translation/semantic-detector";

export interface M365BrowserRunOptions {
  onChunk: (text: string) => void;
  signal?: AbortSignal;
  descriptorPath?: string;
  traceId?: string;
  conversationKey?: string;
  isNewConversation?: boolean;
  shouldStop?: () => boolean;
  modelSlug?: string;
  providerId?: string;
  traceContext?: TraceContext;
  forceTemporaryChat?: boolean;
}

export type M365TurnOptions = M365BrowserRunOptions;
export type DriverTurnOptions = M365BrowserRunOptions;
export type M365TurnResult = { rawMarkdown: string; blocks: M365MarkdownBlock[] };

/**
 * Trạng thái chụp ảnh DOM tin nhắn AI trước khi gửi prompt.
 */
export interface BaselineState {
  aiCount: number;
  count: number;
  lastText: string;
  lastHtml: string;
}

/**
 * Kết quả trích xuất tiến độ phản hồi từ Live DOM.
 */
export interface ScrapeProgressResult {
  isGenerating: boolean;
  blocks: M365MarkdownBlock[];
  rawHtml: string;
  isNew: boolean;
  hasContent: boolean;
  detectedWebError?: string;
  fastPathRawText: string | null;
  isInputActionsIdle?: boolean;
}

/**
 * Hợp đồng PageDriver: Mọi trang web chat AI muốn tích hợp vào hệ thống
 * chỉ cần hiện thực hóa (implement) interface này.
 */
export interface PageDriver {
  /** Định danh duy nhất của driver (vd: 'm365-copilot', 'bing-copilot', 'copilot-studio') */
  readonly id: string;

  /** Tên hiển thị của trang web */
  readonly name: string;

  /** Danh sách selector đặc thù của trang */
  readonly selectors?: Record<string, string>;

  /** Kiểm tra URL và đảm bảo trang web đã nạp đúng vị trí */
  ensureReady(page: Page, options: M365BrowserRunOptions): Promise<void>;

  /** Chuẩn bị phiên trò chuyện mới nếu cần (New Chat / Reset thread) */
  prepareNewChat?(page: Page, options: M365BrowserRunOptions): Promise<void>;

  /** Thiết lập model/chế độ mong muốn trên giao diện */
  ensureModelMode?(page: Page, modelSlug?: string): Promise<void>;

  /** Chờ trang web ở trạng thái rảnh rỗi (không còn bận sinh từ lượt trước) */
  waitForIdle(page: Page, signal?: AbortSignal): Promise<void>;

  /** Chụp ảnh trạng thái DOM trước khi gửi prompt */
  captureBaseline(page: Page): Promise<BaselineState>;

  /** Nhập prompt vào ô soạn thảo và kích hoạt gửi */
  submitPrompt(page: Page, promptText: string): Promise<boolean>;

  /** Đọc trạng thái phản hồi của AI theo thời gian thực từ DOM */
  scrapeTurnProgress(page: Page, baseline: BaselineState): Promise<ScrapeProgressResult>;

  /** Dừng sinh mã khẩn cấp khi nhận tín hiệu hủy */
  abortGeneration(page: Page): Promise<void>;

  /** Hành động định kỳ trong chu kỳ polling (vd: cuộn trang, kích hoạt virtual scroll) */
  periodicAction?(page: Page, attempt: number): Promise<void>;

  /** Ghi nhận URL thread sau khi turn hoàn tất để khôi phục chính xác cho các cửa sổ VS Code khác nhau */
  recordConversationThread?(conversationKey: string, threadUrl: string): void;

  /** Lấy URL thread đã lưu của một conversationKey */
  getSavedThreadUrl?(conversationKey: string): string | undefined;

  /** Kiểm tra xem driver này có thể phục vụ request cụ thể hay không */
  canHandle?(options: { providerId?: string; modelSlug?: string }): boolean;
}
