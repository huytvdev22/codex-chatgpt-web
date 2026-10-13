import { randomBytes } from "node:crypto";
import type { Page } from "playwright-core";
import {
  BaseChatBrowserWorker,
  CdpLauncherConnector,
  ClipboardPromptInjector,
  ClipboardCopySalvager,
  GuaranteedFormSubmitter,
  FastPathStreamObserver,
  type BrowserAttachmentResult,
  type ChatSelectorsDto,
  type BrowserTurnOptionsDto,
} from "../../base-web/browser";
import { M365CapabilityPicker } from "./capability-picker";
import { attachFilesViaPlusMenu, m365ImageFilePayloads } from "./attachments";
import { M365_CHAT_URL, parseM365ConversationId, waitForM365ConversationId } from "./conversation-url";
import { emitStructuredEvent } from "../../../observability/emitter";
import { logDebugPipelineStation } from "../../../observability/debug-logger";

export const M365_CHAT_EDITOR_SELECTOR = [
  '#m365-chat-editor-target-element',
  '.fai-BebopLiteChatInput [role="textbox"]',
  '.fai-ChatInput [role="textbox"]',
  'div[contenteditable="true"]:not([aria-readonly="true"]):not([aria-label*="Code editor" i])',
  '[role="textbox"]:not([aria-readonly="true"]):not([aria-label*="Code editor" i])',
  'textarea:not([aria-readonly="true"])',
].join(", ");

export const CHAT_SELECTORS: ChatSelectorsDto = {
  editor: M365_CHAT_EDITOR_SELECTOR,
  inputWrapper: '.fai-BebopLiteChatInput__inputWrapper',
  actions: '.fai-BebopLiteChatInput__actions',
  sendButton: 'button[type="submit"][aria-label="Send"]:not([aria-label*="Stop"]):not(:has(.fai-SendButton__stopIcon)), button[aria-label="Send"]:not([aria-label*="Stop"]):not(:has(.fai-SendButton__stopIcon)), .fai-BebopLiteChatInput__actions button[type="submit"]:has(.fai-SendButton__sendIcon):not(:has(.fai-SendButton__stopIcon))',
  stopButton: 'button[type="submit"][aria-label="Stop generating"], button[aria-label="Stop generating"], button[aria-label*="Stop generating" i], button[aria-label*="Dừng tạo" i], .fai-SendButton__stopIcon, [data-testid="stop-button"]',
  dictationButton: 'button[aria-label="Start dictation"]',
};

/**
 * Lớp Browser Worker chuyên biệt cho Microsoft 365 Copilot
 * Kế thừa BaseChatBrowserWorker chuẩn Clean Architecture OOP Template Method Pattern
 * Bảo toàn cuộc hội thoại tiếp diễn qua nhiều request và hỗ trợ làm sạch khi bắt đầu hội thoại mới.
 */
export class M365BrowserWorker extends BaseChatBrowserWorker {
  readonly workerName = "m365-worker";

  protected readonly selectors: ChatSelectorsDto = CHAT_SELECTORS;
  protected readonly modelSelector = new M365CapabilityPicker();

  private readonly promptInjector = new ClipboardPromptInjector();
  private readonly formSubmitter = new GuaranteedFormSubmitter();
  private readonly streamObserver = new FastPathStreamObserver({ providerName: "m365-copilot" });
  private readonly salvager = new ClipboardCopySalvager({
    aiMessageSelector: ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']",
    userMessageSelector: "[data-content='user-message']",
    codeBlockSelector: ".scriptor-component-code-block, [class*='code-block' i], [data-testid='one-copilot-code-identity'], .djlfcDli",
    copyButtonSelector: "button#copy-button, button[aria-label='Copy code']",
    previewToggleSelector: "button#preview-toggle-button, button[data-automation-id='codePreviewToggle'], button[aria-label='Code'], button[aria-label*='Code' i]",
  });

  public getChatUrl(): string {
    return M365_CHAT_URL;
  }

  protected override async attachToBrowser(options: BrowserTurnOptionsDto): Promise<BrowserAttachmentResult> {
    if (!options.conversationKey) {
      throw new Error("M365 multi-surface requires a stable conversation key");
    }
    const descriptorPath = CdpLauncherConnector.resolveDescriptorPath(options.descriptorPath);
    const traceId = options.traceId || randomBytes(12).toString("base64url");
    const connector = new CdpLauncherConnector();

    const lease = await connector.acquireLease(descriptorPath, {
      traceId,
      conversationKey: options.conversationKey,
      connectorIdentity: "m365-copilot",
      provider: "m365",
      signal: options.signal,
      requireRetainedConversation: false,
    });

    const connection = await connector.connect(descriptorPath, lease.surfaceId!, options.signal);
    return {
      page: connection.page,
      browser: connection.browser,
      descriptorPath,
      lease,
      context: { connector, traceId },
    };
  }

  protected override async preparePageNavigation(
    page: Page,
    options: BrowserTurnOptionsDto,
    attachment?: BrowserAttachmentResult,
  ): Promise<void> {
    const lease = attachment?.lease;
    const currentConversationId = parseM365ConversationId(page.url());

    // 1. Trường hợp tiếp diễn cuộc hội thoại: Đã có conversationId được giữ lại từ turn trước
    if (lease?.conversationId) {
      if (currentConversationId !== lease.conversationId.toLowerCase()) {
        throw new Error(
          `M365 retained conversation mismatch: expected ${lease.conversationId}, current URL is ${page.url()}`
        );
      }
      console.log(`[m365-worker] [continue] Tiếp tục cuộc hội thoại hiện tại: ${lease.conversationId}`);
      return;
    }

    // 2. Trường hợp surface tái sử dụng nhưng chưa được bind mà lại chứa URL hội thoại cũ
    if (lease?.reused && currentConversationId && !options.isNewConversation) {
      throw new Error("Launcher reused an unbound M365 surface that already contains a conversation");
    }

    // 3. Trường hợp bắt đầu cuộc trò chuyện mới: isNewConversation = true hoặc chưa có conversationId
    const shouldStartNewChat = Boolean(options.isNewConversation) || !currentConversationId;

    if (shouldStartNewChat) {
      if (currentConversationId || page.url() !== M365_CHAT_URL) {
        console.log(`[m365-worker] [new-chat] Điều hướng về chat mới từ URL: ${page.url()}`);
        await page.goto(M365_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await new Promise(r => setTimeout(r, 400));
      }

      // Thử bấm nút New Chat trên giao diện M365 để đảm bảo phiên chat sạch hoàn toàn
      await page.evaluate(() => {
        const newChatBtn = document.querySelector(
          'a[aria-label*="New chat" i], button[aria-label*="New chat" i], [aria-label*="New chat" i], [aria-label*="Cuộc trò chuyện mới" i], [aria-label*="New topic" i], [title*="New chat" i]'
        ) as HTMLElement | null;
        if (newChatBtn) {
          newChatBtn.click();
          newChatBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        }
      }).catch(() => {});

      await new Promise(r => setTimeout(r, 400));
    }
  }

  protected async injectPromptContent(page: Page, prompt: string, options: BrowserTurnOptionsDto): Promise<void> {
    logDebugPipelineStation(2, "BRIDGE SERVER ➔ M365 COPILOT WEB (RAW INJECTED PROMPT)", prompt);

    emitStructuredEvent({
      level: "info",
      event: "m365.provider.started",
      traceContext: (options as any).traceContext,
      safeDetails: {
        provider: "m365-copilot",
        modelSlug: options.modelSlug,
        isNewConversation: Boolean(options.isNewConversation),
        injectedPromptPreview: prompt,
        rawPrompt: prompt,
        promptBytes: Buffer.byteLength(prompt, "utf8"),
      },
      diagnosticDetails: {
        promptBytes: Buffer.byteLength(prompt, "utf8"),
      },
    });

    // 1. Đính kèm hình ảnh qua Plus Menu nếu có
    const images = (options as any).images;
    if (images && images.length > 0) {
      try {
        const payloads = m365ImageFilePayloads(images);
        console.log(`[m365-worker] Đang đính kèm ${payloads.length} hình ảnh vào Copilot Web qua Plus Menu...`);
        await attachFilesViaPlusMenu(page, payloads, { signal: options.signal });
        console.log(`[m365-worker] Đính kèm hình ảnh hoàn tất!`);
      } catch (err: any) {
        console.warn(`[m365-worker] Lỗi trong quá trình đính kèm hình ảnh:`, err?.message);
      }
    }

    // 2. Chèn prompt qua clipboard paste event
    await this.promptInjector.inject(page, prompt, this.selectors, options as any);

    // Chờ ngắn để React cập nhật DOM
    await new Promise(r => setTimeout(r, 300));

    // Nếu có ảnh, chờ nút Send được bật
    if (images && images.length > 0) {
      const sendLocator = page.locator(this.selectors.sendButton).first();
      const sendWaitDeadline = Date.now() + 30_000;
      while (Date.now() < sendWaitDeadline) {
        if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const isEnabled = await sendLocator.isEnabled().catch(() => false);
        if (isEnabled) break;
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }

  protected override async dispatchSend(page: Page, options: BrowserTurnOptionsDto): Promise<void> {
    const promptSubmitted = await this.formSubmitter.submit(page, this.selectors);
    if (!promptSubmitted) {
      console.warn("[m365-worker] [send] Cảnh báo: GuaranteedFormSubmitter không xác nhận được trạng thái generating.");
    }
  }

  protected async observeStreamingResponse(page: Page, options: BrowserTurnOptionsDto): Promise<string> {
    return this.streamObserver.observe(page, this.selectors, options);
  }

  protected override async salvageOutputIfNeeded(page: Page, currentText: string, options: BrowserTurnOptionsDto): Promise<string> {
    const needsEnvelopeFix = /<m365Response\b/i.test(currentText) && !/<\/m365Response\s*>/i.test(currentText);
    const hasUnclosedMarkers = /(?:<custom_tool_call|\*{3}\s*Begin Patch)/i.test(currentText) &&
      !(/(?:<\/custom_tool_call>|\*{3}\s*End Patch)/i.test(currentText));
    const hasCodeBlockOnPage = await page.locator(
      "button#copy-button, button#preview-toggle-button, button[aria-label='Copy code'], button[aria-label='Code']"
    ).count().catch(() => 0) > 0;

    let fullMarkdown = currentText;
    if (needsEnvelopeFix || hasUnclosedMarkers || hasCodeBlockOnPage) {
      console.log("[m365-worker] [salvage-eval] Kích hoạt ClipboardCopySalvager...");
      const copiedCode = await this.salvager.salvage(page);
      if (copiedCode) {
        const copiedHasClose = /<\/m365Response\s*>/i.test(copiedCode);
        const currentLacksClose = !/<\/m365Response\s*>/i.test(fullMarkdown);

        if ((currentLacksClose && copiedHasClose) || copiedCode.length > fullMarkdown.length) {
          console.log(`[m365-worker] [copy-salvage] ÁP DỤNG THAY THẾ: Chuỗi từ Copy Button (${copiedCode.length} chars) hoàn chỉnh hơn.`);
          if (copiedCode.length > fullMarkdown.length && !options.shouldStop?.()) {
            const extra = copiedCode.startsWith(fullMarkdown) ? copiedCode.slice(fullMarkdown.length) : copiedCode;
            if (extra) {
              options.onChunk?.(extra);
            }
          }
          fullMarkdown = copiedCode;
        }
      }
    }

    if (!fullMarkdown || !fullMarkdown.trim()) {
      throw new Error(`[M365 Format Error] M365 Copilot không trả về bất kỳ nội dung phản hồi nào.`);
    }

    emitStructuredEvent({
      level: "info",
      event: "m365.provider.finished",
      traceContext: (options as any).traceContext,
      safeDetails: {
        provider: "m365-copilot",
        status: "completed",
        outputChars: fullMarkdown.length,
        responsePreview: fullMarkdown,
        rawResponse: fullMarkdown,
        terminalReason: "completed_settled",
        terminalExplanation: "M365 đã hoàn tất và văn bản đã ổn định.",
      },
      diagnosticDetails: {
        outputBytes: Buffer.byteLength(fullMarkdown, "utf8"),
      },
    });

    logDebugPipelineStation(3, "M365 COPILOT WEB ➔ BRIDGE SERVER (RAW RESPONSE SCRAPING)", fullMarkdown);
    return fullMarkdown;
  }

  protected override async resolveConversationIdAfterTurn(
    page: Page,
    options: BrowserTurnOptionsDto,
    attachment?: BrowserAttachmentResult,
  ): Promise<string | undefined> {
    let conversationId = attachment?.lease?.conversationId || parseM365ConversationId(page.url());
    if (!conversationId) {
      conversationId = await waitForM365ConversationId(page, 15_000);
    }
    if (!conversationId) {
      throw new Error("M365 did not expose a persistent /chat/conversation/{id} URL after completing the turn");
    }
    return conversationId;
  }

  protected override async releaseBrowserAttachment(
    attachment: BrowserAttachmentResult,
    status: "completed" | "failed" | "aborted",
    conversationId: string | undefined,
    options: BrowserTurnOptionsDto,
  ): Promise<void> {
    const descriptorPath = attachment.descriptorPath
      || CdpLauncherConnector.resolveDescriptorPath(options.descriptorPath);
    const traceId = (attachment.context as any)?.traceId || options.traceId || "default-trace";
    const connector = (attachment.context as any)?.connector instanceof CdpLauncherConnector
      ? (attachment.context as any).connector
      : new CdpLauncherConnector();

    let releaseError: unknown;
    try {
      await connector.releaseLease(descriptorPath, {
        traceId,
        status,
        conversationId,
        retain: true,
      });
    } catch (error) {
      releaseError = error;
    }

    if (attachment.browser) {
      console.log(`[${this.workerName}] [cleanup] closing browser connection (timeout 3000ms)...`);
      await connector.closeConnectionWithTimeout(attachment.browser, 3000);
      console.log(`[${this.workerName}] [cleanup] browser closed`);
    }

    if (releaseError) {
      if (status === "completed") throw releaseError;
      console.warn(`[${this.workerName}] Failed to release launcher turn:`, releaseError);
    }
  }
}

export const defaultM365BrowserWorker = new M365BrowserWorker();

