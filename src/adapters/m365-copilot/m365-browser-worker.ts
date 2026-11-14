import type { Locator, Page } from "playwright-core";
import {
  BaseWebBrowserWorker,
  BrowserHardTimeoutError,
  BrowserIdleTimeoutError,
  type BaseBrowserRunOptions,
  type BrowserCompletionContext,
} from "../web/browser";
import {
  ensureM365CapabilityMode,
  resolveM365CapabilityMode,
} from "./capability-picker";
import { attachFilesViaPlusMenu, m365ImageFilePayloads } from "./attachments";
import type { NormalizedImageAttachment } from "../web/normalization/canonical-types";
import {
  M365_CHAT_URL,
  parseM365ConversationId,
  waitForM365ConversationId,
} from "./conversation-url";
import { M365ClipboardSalvage } from "./m365-clipboard-salvage";
import {
  M365DomObserver,
  type M365ResponseBaseline,
  type M365ResponseObservation,
  type M365ResponseRuntimeState,
} from "./m365-dom-observer";

export interface M365BrowserRunOptions extends BaseBrowserRunOptions {
  conversationKey?: string;
  existingConversationId?: string;
  launcherReused?: boolean;
  shouldStop?: () => boolean;
  modelSlug?: string;
  reasoning?: string;
  images?: NormalizedImageAttachment[];
}

export const M365_CHAT_EDITOR_SELECTOR = [
  '#m365-chat-editor-target-element',
  '.fai-BebopLiteChatInput [role="textbox"]',
  '.fai-ChatInput [role="textbox"]',
  'div[contenteditable="true"]:not([aria-readonly="true"]):not([aria-label*="Code editor" i])',
  '[role="textbox"]:not([aria-readonly="true"]):not([aria-label*="Code editor" i])',
  'textarea:not([aria-readonly="true"])',
].join(", ");

export const CHAT_SELECTORS = {
  editor: M365_CHAT_EDITOR_SELECTOR,
  inputWrapper: '.fai-BebopLiteChatInput__inputWrapper',
  actions: '.fai-BebopLiteChatInput__actions',
  sendButton: 'button[type="submit"][aria-label="Send"]:not([aria-label*="Stop"]):not(:has(.fai-SendButton__stopIcon)), button[aria-label="Send"]:not([aria-label*="Stop"]):not(:has(.fai-SendButton__stopIcon)), .fai-BebopLiteChatInput__actions button[type="submit"]:has(.fai-SendButton__sendIcon):not(:has(.fai-SendButton__stopIcon))',
  stopButton: 'button[type="submit"][aria-label="Stop generating"], button[aria-label="Stop generating"], button[aria-label*="Stop generating" i], button[aria-label*="Dừng tạo" i], .fai-SendButton__stopIcon, [data-testid="stop-button"]',
  dictationButton: 'button[aria-label="Start dictation"]',
};

export type M365TurnOptions = M365BrowserRunOptions;
export type M365TurnResult = {
  rawResponse: string;
  conversationId: string;
};

/**
 * Thực thi một lượt hội thoại với Microsoft 365 Copilot nhúng trong Launcher Desktop
 * thông qua Page do WebTurnEngine cấp, đồng nhất contract với các Web Adapter khác.
 */
export class M365BrowserWorker extends BaseWebBrowserWorker<
  M365BrowserRunOptions,
  M365TurnResult,
  M365ResponseBaseline,
  M365ResponseObservation
> {
  protected readonly logPrefix = "m365-worker";
  protected readonly defaultHardTimeoutMs = 20 * 60_000;
  protected readonly defaultIdleTimeoutMs = 30_000;
  protected readonly defaultPollingIntervalMs = 250;
  protected readonly defaultHeartbeatIntervalMs = 10_000;
  private readonly domObserver = new M365DomObserver();
  private readonly clipboardSalvage = new M365ClipboardSalvage();
  private readonly activeEditors = new WeakMap<Page, Locator>();
  private readonly retainedConversationIds = new WeakMap<Page, string>();
  private readonly responseStates = new WeakMap<
    Page,
    M365ResponseRuntimeState
  >();

  private createResponseRuntimeState(): M365ResponseRuntimeState {
    return this.domObserver.createRuntimeState();
  }

  private getResponseRuntimeState(page: Page): M365ResponseRuntimeState {
    const existing = this.responseStates.get(page);
    if (existing) return existing;

    const created = this.createResponseRuntimeState();
    this.responseStates.set(page, created);
    return created;
  }

  private clearTurnRuntimeState(page: Page): void {
    this.activeEditors.delete(page);
    this.retainedConversationIds.delete(page);
    this.responseStates.delete(page);
  }

  protected async initializeTurnState(
    page: Page,
    options: M365BrowserRunOptions,
  ): Promise<void> {
    if (!options.conversationKey) {
      throw new Error("M365 multi-surface requires a stable conversation key");
    }
    this.responseStates.set(page, this.createResponseRuntimeState());
  }

  protected async cleanupTurnState(
    page: Page,
    _options: M365BrowserRunOptions,
  ): Promise<void> {
    this.clearTurnRuntimeState(page);
  }

  protected async handleExecutionError(
    error: unknown,
    _page: Page,
    options: M365BrowserRunOptions,
  ): Promise<void> {
    if (options.signal?.aborted) {
      console.log("[m365-worker] [aborted] turn aborted by client");
      return;
    }

    console.error("[m365-worker] [error]", error);
  }

  protected createResult(result: {
    rawResponse: string;
    conversationId?: string;
  }): M365TurnResult {
    if (!result.conversationId) {
      throw new Error(
        "M365 completed turn did not resolve a conversation ID",
      );
    }

    return {
      rawResponse: result.rawResponse,
      conversationId: result.conversationId,
    };
  }

  protected shouldStopPolling(
    observation: M365ResponseObservation,
    options: M365BrowserRunOptions,
  ): boolean {
    return Boolean(
      options.shouldStop?.() &&
        !observation.isGenerating &&
        observation.status.hasContent,
    );
  }

  protected shouldEmitObservationDelta(
    _observation: M365ResponseObservation,
    _options: M365BrowserRunOptions,
  ): boolean {
    // M365MarkdownBuffer và FastPathStreamBuffer đã phát semantic delta trong
    // applyResponseStatus. Không để shared lifecycle phát lại observation.text.
    return false;
  }

  protected override shouldDelayFirstObservation(
    _options: M365BrowserRunOptions,
  ): boolean {
    // Compatibility polling cũ luôn chờ 250ms sau submit trước lần đọc DOM đầu tiên.
    return true;
  }

  protected override async beforeObserveResponse(
    page: Page,
    baseline: M365ResponseBaseline,
    _options: M365BrowserRunOptions,
  ): Promise<void> {
    const responseState = this.getResponseRuntimeState(page);
    responseState.attempts++;
    responseState.pendingStatus = await this.domObserver.captureStatus(
      page,
      baseline,
    );
  }

  protected override shouldEnforceIdleTimeout(
    observation: M365ResponseObservation,
    _options: M365BrowserRunOptions,
  ): boolean {
    // Không ngắt idle timeout trong lúc Copilot Web vẫn đang hiển thị trạng thái generating.
    return !observation.isGenerating;
  }

  protected override onWaitTimeout(
    error: BrowserHardTimeoutError | BrowserIdleTimeoutError,
    lastObservation: M365ResponseObservation | undefined,
    _options: M365BrowserRunOptions,
  ): M365ResponseObservation | undefined {
    if (lastObservation?.status.hasContent) {
      console.warn(
        `[m365-worker] [timeout] ${error.message} — trả về nội dung đã thu thập để tiếp tục salvage.`,
      );
      return {
        ...lastObservation,
        timedOut: true,
      };
    }

    return undefined;
  }

  protected async observeResponse(
    page: Page,
    _baseline: M365ResponseBaseline,
    options: M365BrowserRunOptions,
  ): Promise<M365ResponseObservation> {
    const responseState = this.getResponseRuntimeState(page);
    const status = responseState.pendingStatus;
    if (!status) {
      throw new Error(
        "M365 observeResponse requires a DOM status captured for the current polling cycle",
      );
    }

    responseState.pendingStatus = null;
    return await this.domObserver.applyStatus(
      page,
      responseState,
      status,
      options,
    );
  }

  protected async extractCompletedResponse(
    page: Page,
    context: BrowserCompletionContext<
      M365ResponseBaseline,
      M365ResponseObservation
    >,
    options: M365BrowserRunOptions,
  ): Promise<string> {
    const responseState = this.getResponseRuntimeState(page);
    let fullMarkdown = "";
    let finalDelta = "";

    if (
      responseState.fastPathActive ||
      responseState.fastPathBuffer.getText().length > 0
    ) {
      const result = responseState.fastPathBuffer.finish(
        responseState.lastFastPathText ||
          responseState.fastPathBuffer.getText(),
      );
      fullMarkdown =
        result.markdown || responseState.fastPathBuffer.getText();
      finalDelta = result.delta;
    }

    if (!fullMarkdown.trim()) {
      const result = responseState.markdownBuffer.finish(
        responseState.lastBlocks,
      );
      if (result.markdown?.trim()) {
        fullMarkdown = result.markdown;
        finalDelta = result.delta;
      }
    }

    if (!fullMarkdown.trim()) {
      fullMarkdown =
        responseState.fastPathBuffer.getText() ||
        responseState.lastFastPathText ||
        responseState.lastBlocks.map(block => block.text).join("\n");
      if (fullMarkdown && !finalDelta) {
        finalDelta = fullMarkdown;
      }
    }

    const needsEnvelopeFix =
      /<(?:web|m365)Response\b/i.test(fullMarkdown) &&
      !/<\/(?:web|m365)Response\s*>/i.test(fullMarkdown);
    const hasUnclosedMarkers =
      /(?:<custom_tool_call|\*{3}\s*Begin Patch)/i.test(fullMarkdown) &&
      !/(?:<\/custom_tool_call>|\*{3}\s*End Patch)/i.test(fullMarkdown);
    const hasCodeBlockOnPage =
      (await page
        .locator(
          "button#copy-button, button#preview-toggle-button, button[aria-label='Copy code'], button[aria-label='Code']",
        )
        .count()
        .catch(() => 0)) > 0;

    console.log(
      `[m365-worker] [salvage-eval] Đánh giá điều kiện cứu hộ: needsEnvelopeFix=${needsEnvelopeFix}, hasUnclosedMarkers=${hasUnclosedMarkers}, fastPathActive=${responseState.fastPathActive}, hasCodeBlockOnPage=${hasCodeBlockOnPage}, textLen=${fullMarkdown.length}`,
    );

    if (
      needsEnvelopeFix ||
      hasUnclosedMarkers ||
      responseState.fastPathActive ||
      hasCodeBlockOnPage
    ) {
      console.log(
        "[m365-worker] [salvage-eval] -> Phát hiện response cần cứu hộ hoặc có Code Block trên trang. Kích hoạt tryExtractCodeViaCopyButton...",
      );
      const copiedCode = await this.clipboardSalvage.tryExtractCodeViaCopyButton(
        page,
      );
      if (copiedCode) {
        const copiedHasClose =
          /<\/(?:web|m365)Response\s*>/i.test(copiedCode);
        const currentLacksClose =
          !/<\/(?:web|m365)Response\s*>/i.test(fullMarkdown);

        if (
          (currentLacksClose && copiedHasClose) ||
          copiedCode.length > fullMarkdown.length
        ) {
          console.log(
            `[m365-worker] [copy-salvage] ÁP DỤNG THAY THẾ: Chuỗi từ Copy Button (${copiedCode.length} chars) hoàn chỉnh hơn chuỗi cào DOM (${fullMarkdown.length} chars). Hoàn tất cứu hộ 100%!`,
          );
          if (
            copiedCode.length > fullMarkdown.length &&
            !options.shouldStop?.()
          ) {
            const extra = copiedCode.startsWith(fullMarkdown)
              ? copiedCode.slice(fullMarkdown.length)
              : copiedCode;
            if (extra) finalDelta = extra;
          }
          fullMarkdown = copiedCode;
        } else {
          console.log(
            `[m365-worker] [copy-salvage] Nội dung copy (${copiedCode.length} chars) không dài hơn hoặc không cải thiện envelope so với DOM (${fullMarkdown.length} chars). Giữ nguyên DOM text.`,
          );
        }
      } else {
        console.warn(
          "[m365-worker] [copy-salvage] Không trích xuất được code qua nút Copy. Tiếp tục sử dụng kết quả cào DOM.",
        );
      }
    } else {
      console.log(
        "[m365-worker] [salvage-eval] Phản hồi đã có cấu trúc hoàn chỉnh và không có Code Block cần cứu hộ.",
      );
    }

    if (!fullMarkdown.trim()) {
      throw new Error(
        "[M365 Format Error] M365 Copilot không trả về bất kỳ nội dung phản hồi nào. Vui lòng kiểm tra kết nối mạng hoặc thử lại.",
      );
    }

    if (finalDelta && !options.shouldStop?.()) {
      options.onChunk?.(finalDelta);
    }

    console.log(
      `[m365-worker] [completed] totalChars=${fullMarkdown.length} finalStatus=completed timedOut=${context.observation.timedOut}`,
    );
    return fullMarkdown;
  }

  /**
   * M365 có thể giữ nhiều editor/control cho responsive layout. Chỉ thao tác
   * trên phần tử đang hiển thị để không đọc nhầm editor ẩn đang rỗng hoặc click
   * nhầm Send button không thuộc composer hiện hành.
   */
  private async findVisibleLocator(
    page: Page,
    selector: string,
  ): Promise<Locator | undefined> {
    const locators = page.locator(selector);
    const count = await locators.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = locators.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }
    return undefined;
  }

  /**
   * Xác thực surface và điều hướng theo retained-conversation contract.
   * Mismatch luôn fail-closed để không làm Codex tiếp tục nhầm conversation.
   */
  protected async navigate(
    page: Page,
    options: M365BrowserRunOptions,
  ): Promise<void> {
    const currentConversationId = parseM365ConversationId(page.url());

    if (options.existingConversationId) {
      if (
        currentConversationId !==
        options.existingConversationId.toLowerCase()
      ) {
        throw new Error(
          `M365 retained conversation mismatch: expected ${options.existingConversationId}, current URL is ${page.url()}`,
        );
      }
      this.retainedConversationIds.set(page, currentConversationId);
      return;
    }

    if (options.launcherReused && currentConversationId) {
      throw new Error(
        "Launcher reused an unbound M365 surface that already contains a conversation",
      );
    }

    if (page.url() !== M365_CHAT_URL) {
      await page.goto(M365_CHAT_URL, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
    }

  }

  /**
   * Chuẩn bị provider trước khi khóa response baseline.
   */
  protected async prepareProvider(
    page: Page,
    options: M365BrowserRunOptions,
  ): Promise<void> {
    await page.waitForSelector(M365_CHAT_EDITOR_SELECTOR, {
      timeout: 15_000,
    });

    if (options.modelSlug) {
      const targetMode = resolveM365CapabilityMode(
        options.modelSlug,
        options.reasoning,
      );
      await ensureM365CapabilityMode(page, targetMode).catch(error => {
        console.warn(
          `[m365-worker] Warning: Failed to ensure capability mode '${targetMode}':`,
          error,
        );
      });
    }

    // Chờ tối đa 12 giây cho lượt trước hoàn tất. Chỉ dừng generation cũ khi
    // surface thực sự bị kẹt, sau đó chờ editor trở lại trạng thái idle.
    await page
      .evaluate(async ({ editorSelector, stopSelector }) => {
        const isIdle = () => {
          const stopButton = document.querySelector(stopSelector);
          const editors = Array.from(
            document.querySelectorAll<HTMLElement>(editorSelector),
          );
          const visibleEditor = editors.find(editor => {
            const style = window.getComputedStyle(editor);
            const rect = editor.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              rect.width > 0 &&
              rect.height > 0
            );
          });
          const editorDisabled =
            visibleEditor?.getAttribute("aria-disabled") === "true";
          return !stopButton && !editorDisabled;
        };

        if (isIdle()) return;

        const idleDeadline = Date.now() + 12_000;
        while (Date.now() < idleDeadline) {
          await new Promise(resolve => setTimeout(resolve, 250));
          if (isIdle()) return;
        }

        const stopButton = document.querySelector(
          stopSelector,
        ) as HTMLButtonElement | null;
        if (!stopButton) return;

        stopButton.click();
        const stopDeadline = Date.now() + 3_000;
        while (Date.now() < stopDeadline) {
          await new Promise(resolve => setTimeout(resolve, 200));
          if (isIdle()) break;
        }
        await new Promise(resolve => setTimeout(resolve, 800));
      }, {
        editorSelector: M365_CHAT_EDITOR_SELECTOR,
        stopSelector: CHAT_SELECTORS.stopButton,
      })
      .catch(() => {});
  }

  /**
   * Khóa các assistant message đã tồn tại trước lượt gửi.
   */
  protected async captureResponseBaseline(
    page: Page,
    _options?: M365BrowserRunOptions,
  ): Promise<M365ResponseBaseline> {
    return await this.domObserver.captureBaseline(page);
  }

  /**
   * Dừng generation bằng đúng Stop control đang hiển thị. Helper này là contract
   * sẽ được BaseWebBrowserWorker gọi khi abort, hard timeout hoặc idle timeout.
   */
  protected async stopGeneration(page: Page): Promise<boolean> {
    const stopLocator = await this.findVisibleLocator(
      page,
      CHAT_SELECTORS.stopButton,
    );
    if (!stopLocator) return false;

    return await stopLocator
      .click({ timeout: 1_000 })
      .then(() => true)
      .catch(error => {
        console.warn(
          "[m365-worker] Không thể click Stop generation:",
          error,
        );
        return false;
      });
  }

  /**
   * Resolve conversation ID sau khi response hoàn tất, giữ retained ID làm
   * fallback nhưng vẫn yêu cầu M365 công bố URL persistent cho conversation mới.
   */
  protected async resolveConversationId(
    page: Page,
    options: M365BrowserRunOptions,
  ): Promise<string> {
    const conversationId =
      parseM365ConversationId(page.url()) ||
      (await waitForM365ConversationId(page)) ||
      this.retainedConversationIds.get(page) ||
      options.existingConversationId?.toLowerCase();

    if (!conversationId) {
      throw new Error(
        "M365 did not expose a persistent /chat/conversation/{id} URL after completing the turn",
      );
    }

    return conversationId;
  }

  /**
   * Đính kèm ảnh và nhập prompt vào đúng editor đang hiển thị.
   * Thứ tự baseline -> attachment -> prompt được giữ nguyên để attachment của
   * lượt hiện tại không làm sai response identity.
   */
  protected async insertPrompt(
    page: Page,
    promptText: string,
    options: M365BrowserRunOptions,
  ): Promise<void> {
    if (options.images && options.images.length > 0) {
      try {
        const payloads = m365ImageFilePayloads(options.images);
        console.log(
          `[m365-worker] Đang đính kèm ${payloads.length} hình ảnh vào Copilot Web qua Plus Menu...`,
        );
        await attachFilesViaPlusMenu(page, payloads, {
          signal: options.signal,
        });
        console.log("[m365-worker] Đính kèm hình ảnh hoàn tất!");
      } catch (error: any) {
        console.warn(
          "[m365-worker] Lỗi trong quá trình đính kèm hình ảnh:",
          error?.message,
        );
      }
    }

    const editorLocator = await this.findVisibleLocator(
      page,
      M365_CHAT_EDITOR_SELECTOR,
    );
    if (!editorLocator) {
      throw new Error(
        "Không tìm thấy ô nhập liệu M365 Copilot đang hiển thị!",
      );
    }

    await editorLocator.evaluate((editor, text) => {
      const target = editor as HTMLElement;
      delete (window as any).__m365_code_lines_cache;
      delete (window as any).__m365_code_lines_cache_by_block;
      target.focus();

      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(target);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand("delete", false, undefined);

      const dataTransfer = new DataTransfer();
      dataTransfer.setData("text/plain", text);
      target.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: dataTransfer,
          bubbles: true,
          cancelable: true,
        }),
      );
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }, promptText);

    await page.waitForTimeout(300);
    this.activeEditors.set(page, editorLocator);
  }

  /**
   * Gửi prompt bằng một trusted Playwright click cho mỗi attempt.
   */
  protected async submitPrompt(
    page: Page,
    options: M365BrowserRunOptions,
  ): Promise<void> {
    const editorLocator =
      this.activeEditors.get(page) ||
      (await this.findVisibleLocator(page, M365_CHAT_EDITOR_SELECTOR));
    if (!editorLocator) {
      throw new Error(
        "Không tìm thấy ô nhập liệu M365 Copilot đang hiển thị để gửi prompt!",
      );
    }
    const activeEditor = editorLocator;

    if (options.images && options.images.length > 0) {
      const sendWaitDeadline = Date.now() + 30_000;
      while (Date.now() < sendWaitDeadline) {
        if (options.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }

        const sendLocator = await this.findVisibleLocator(
          page,
          CHAT_SELECTORS.sendButton,
        );
        const enabled = sendLocator
          ? await sendLocator.isEnabled().catch(() => false)
          : false;
        if (enabled) break;
        await page.waitForTimeout(200);
      }
    }

    let promptSubmitted = false;
    for (let submitAttempt = 0; submitAttempt < 10; submitAttempt++) {
      if (options.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const stopLocator = await this.findVisibleLocator(
        page,
        CHAT_SELECTORS.stopButton,
      );
      const editorText = (
        (await activeEditor.textContent().catch(() => "")) ?? ""
      ).trim();
      promptSubmitted = Boolean(stopLocator) || editorText.length === 0;

      if (promptSubmitted) {
        console.log(
          `[m365-worker] [send] Đã xác nhận prompt được gửi thành công ở lần thử ${submitAttempt + 1} (stopVisible=${Boolean(stopLocator)}, editorLength=${editorText.length})`,
        );
        break;
      }

      const sendLocator = await this.findVisibleLocator(
        page,
        CHAT_SELECTORS.sendButton,
      );
      const sendEnabled = sendLocator
        ? await sendLocator.isEnabled().catch(() => false)
        : false;

      if (sendLocator && sendEnabled) {
        console.log(
          `[m365-worker] [send] Click Send visible ở lần thử ${submitAttempt + 1} (editorLength=${editorText.length})`,
        );
        await sendLocator.click({ timeout: 1_000 }).catch(error => {
          console.warn(
            `[m365-worker] [send] Click Send thất bại ở lần thử ${submitAttempt + 1}:`,
            error,
          );
        });
      } else {
        console.log(
          `[m365-worker] [send] Send chưa visible/enabled ở lần thử ${submitAttempt + 1} (editorLength=${editorText.length}), chờ UI đồng bộ...`,
        );
      }

      await page.waitForTimeout(300);
    }

    if (!promptSubmitted) {
      const remainingText = (
        (await activeEditor.textContent().catch(() => "")) ?? ""
      ).trim();
      throw new Error(
        `[m365-worker] Không thể xác nhận prompt đã được gửi sau 10 lần thử (editorLength=${remainingText.length}).`,
      );
    }
  }
}
