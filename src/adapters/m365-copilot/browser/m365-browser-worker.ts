import type { Page } from "playwright-core";
import {
  BaseChatBrowserWorker,
  ChatSelectorsDto,
  BrowserTurnOptionsDto,
  type BrowserAttachmentResult,
} from "../../base-web/browser";
import { defaultCapabilityPicker } from "./capability-picker";
import {
  M365_CHAT_EDITOR_SELECTOR,
  CHAT_SELECTORS,
  executeM365Turn,
  type M365TurnOptions,
} from "./browser-worker";
import { M365_CHAT_URL } from "./conversation-url";

/**
 * Lớp điều khiển Browser Worker chuyên biệt cho Microsoft 365 Copilot Web
 * Kế thừa BaseChatBrowserWorker theo chuẩn Enterprise Clean OOP
 */
export class M365BrowserWorker extends BaseChatBrowserWorker {
  readonly workerName = "m365-browser-worker";

  protected readonly selectors: ChatSelectorsDto;
  protected readonly modelSelector = defaultCapabilityPicker;

  constructor() {
    super();
    this.selectors = new ChatSelectorsDto({
      editor: M365_CHAT_EDITOR_SELECTOR,
      sendButton: CHAT_SELECTORS.sendButton,
      stopButton: CHAT_SELECTORS.stopButton,
      inputWrapper: CHAT_SELECTORS.inputWrapper,
      actions: CHAT_SELECTORS.actions,
      dictationButton: CHAT_SELECTORS.dictationButton,
    });
  }

  public getChatUrl(): string {
    return M365_CHAT_URL;
  }

  /**
   * Ủy quyền thực thi cho pipeline turn của M365 qua executeM365Turn
   */
  public async executeTurn(prompt: string, options: BrowserTurnOptionsDto): Promise<string> {
    const m365Options: M365TurnOptions = {
      onChunk: options.onChunk || (() => {}),
      signal: options.signal,
      descriptorPath: options.descriptorPath,
      traceId: options.traceId,
      conversationKey: options.conversationKey,
      isNewConversation: options.isNewConversation,
      shouldStop: options.shouldStop,
      modelSlug: options.modelSlug,
      reasoning: options.reasoning,
      traceContext: options.traceContext,
      images: options.images as any,
    };

    return executeM365Turn(prompt, m365Options);
  }

  // Hook thực thi CDP (được wrap bên trong executeM365Turn)
  protected async attachToBrowser(options: BrowserTurnOptionsDto): Promise<BrowserAttachmentResult> {
    throw new Error("attachToBrowser được quản lý bởi executeM365Turn");
  }

  protected async injectPromptContent(page: Page, prompt: string, options: BrowserTurnOptionsDto): Promise<void> {
    throw new Error("injectPromptContent được quản lý bởi executeM365Turn");
  }

  protected async observeStreamingResponse(page: Page, options: BrowserTurnOptionsDto): Promise<string> {
    throw new Error("observeStreamingResponse được quản lý bởi executeM365Turn");
  }
}

export const defaultM365BrowserWorker = new M365BrowserWorker();
