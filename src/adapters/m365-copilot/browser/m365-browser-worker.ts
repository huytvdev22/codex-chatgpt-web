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
import { defaultM365CapabilityPicker } from "./m365-capability-specs";
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

export interface M365ImagePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export const PLUS_MENU_SELECTORS = {
  plusButton: [
    'button[data-testid="PlusMenuButton"]',
    '#plus-menu-container button',
    'button[aria-label="Add and manage sources"]',
    'button[aria-label*="manage sources" i]',
    'button[aria-label*="Add" i][aria-haspopup="menu"]',
  ].join(", "),
  popover: [
    '[data-testid="PlusMenuPopover"]',
    '.fui-MenuPopover',
  ].join(", "),
  uploadMenuItem: [
    '[data-testid="PlusMenuPopover"] [role="menuitem"]',
    '.fui-MenuPopover [role="menuitem"]',
    '[role="menuitem"]',
  ].join(", "),
  fileInput: 'input[type="file"]',
};

export function m365ImageFilePayloads(images: { name: string; mimeType: string; buffer: Buffer }[]): M365ImagePayload[] {
  return images.map(img => ({
    name: img.name,
    mimeType: img.mimeType,
    buffer: img.buffer,
  }));
}

/**
 * Đính kèm hình ảnh/tệp tin vào M365 Copilot Web qua Plus Menu
 */
export async function attachFilesViaPlusMenu(
  page: Page,
  files: M365ImagePayload[],
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<boolean> {
  if (!files || files.length === 0) return false;
  if (options?.signal?.aborted) {
    throw new DOMException("Đã hủy lượt đính kèm file do nhận tín hiệu abort", "AbortError");
  }

  // M365 Copilot chỉ cho phép tối đa 3 ảnh/files trong 1 lần gửi
  let effectiveFiles = files;
  if (effectiveFiles.length > 3) {
    console.warn(
      `[m365-attachments] Số lượng file (${effectiveFiles.length}) vượt quá giới hạn 3 ảnh của M365 Copilot. Chỉ giữ lại 3 file.`
    );
    effectiveFiles = effectiveFiles.slice(0, 3);
  }

  const popover = page.locator(PLUS_MENU_SELECTORS.popover).first();
  const plusButton = page.locator(PLUS_MENU_SELECTORS.plusButton).first();

  let isPopoverVisible = await popover.isVisible().catch(() => false);
  if (!isPopoverVisible) {
    const hasPlusButton = (await plusButton.count().catch(() => 0)) > 0;
    if (hasPlusButton) {
      await plusButton.click({ timeout: 4000, force: true }).catch(() => {});
      if (typeof popover.waitFor === "function") {
        isPopoverVisible = await popover.waitFor({ state: "visible", timeout: 4000 }).then(() => true).catch(() => false);
      } else {
        isPopoverVisible = await popover.isVisible().catch(() => false);
      }
    }
  }

  let uploadTarget = popover.locator('[role="menuitem"]').filter({
    hasText: /Upload images and files/i,
  }).first();

  let targetFound = isPopoverVisible && (await uploadTarget.count().catch(() => 0)) > 0;

  if (!targetFound && isPopoverVisible) {
    const fallbackTarget = popover.locator('[role="menuitem"]').filter({
      hasText: /upload|tải lên|images and files|attach/i,
    }).first();
    if ((await fallbackTarget.count().catch(() => 0)) > 0) {
      uploadTarget = fallbackTarget;
      targetFound = true;
    }
  }

  if (targetFound) {
    try {
      const [fileChooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 10_000 }),
        uploadTarget.click({ timeout: 4000, force: true }),
      ]);
      await fileChooser.setFiles(effectiveFiles);
    } catch {
      const directInput = page.locator(PLUS_MENU_SELECTORS.fileInput).first();
      if ((await directInput.count().catch(() => 0)) > 0) {
        await directInput.setInputFiles(effectiveFiles);
      } else {
        throw new Error("Không thể đính kèm file qua Plus Menu");
      }
    }
  } else {
    const directInput = page.locator(PLUS_MENU_SELECTORS.fileInput).first();
    if ((await directInput.count().catch(() => 0)) > 0) {
      await directInput.setInputFiles(effectiveFiles);
    } else {
      throw new Error("Không tìm thấy nút Upload images and files hoặc thẻ input file để đính kèm!");
    }
  }

  if (await popover.isVisible().catch(() => false)) {
    await page.keyboard?.press("Escape").catch(() => {});
  }

  await new Promise(r => setTimeout(r, 600));
  return true;
}

/**
 * Lớp Browser Worker chuyên biệt cho Microsoft 365 Copilot
 * Kế thừa BaseChatBrowserWorker chuẩn Clean Architecture OOP Template Method Pattern
 */
export class M365BrowserWorker extends BaseChatBrowserWorker {
  readonly workerName = "m365-worker";
  protected readonly selectors: ChatSelectorsDto = CHAT_SELECTORS;
  protected readonly modelSelector = defaultM365CapabilityPicker;

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
        const payloads = images.map((img: any) => ({
          name: img.name,
          mimeType: img.mimeType,
          buffer: img.buffer,
        }));
        console.log(`[m365-worker] Đang đính kèm ${payloads.length} hình ảnh vào Copilot Web qua Plus Menu...`);
        await attachFilesViaPlusMenu(page, payloads, { signal: options.signal });
      } catch (err: any) {
        console.warn(`[m365-worker] Lỗi trong quá trình đính kèm hình ảnh:`, err?.message);
      }
    }

    // 2. Chèn prompt qua clipboard paste event
    await this.promptInjector.inject(page, prompt, this.selectors, options as any);
    await new Promise(r => setTimeout(r, 300));

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
    const needsEnvelopeFix = /<webResponse\b/i.test(currentText) && !/<\/webResponse\s*>/i.test(currentText);
    const hasUnclosedMarkers = /(?:<custom_tool_call|\*{3}\s*Begin Patch)/i.test(currentText) &&
      !(/(?:<\/custom_tool_call>|\*{3}\s*End Patch)/i.test(currentText));
    const hasCodeBlockOnPage = await page.locator(
      "button#copy-button, button#preview-toggle-button, button[aria-label='Copy code'], button[aria-label='Code']"
    ).count().catch(() => 0) > 0;

    let fullMarkdown = currentText;
    if (needsEnvelopeFix || hasUnclosedMarkers || hasCodeBlockOnPage) {
      const copiedCode = await this.salvager.salvage(page);
      if (copiedCode) {
        const copiedHasClose = /<\/webResponse\s*>/i.test(copiedCode);
        const currentLacksClose = !/<\/webResponse\s*>/i.test(fullMarkdown);

        if ((currentLacksClose && copiedHasClose) || copiedCode.length > fullMarkdown.length) {
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
