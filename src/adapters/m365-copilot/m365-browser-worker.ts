import type { Locator, Page } from "playwright-core";
import {
  BaseWebBrowserWorker,
  BrowserHardTimeoutError,
  BrowserIdleTimeoutError,
  type BaseBrowserRunOptions,
  type BrowserCompletionContext,
} from "../web/browser";
import {
  ensureM365CapabilityTarget,
} from "./capability-picker";
import { M365ModelProvider } from "./model-provider";
import { attachFilesViaPlusMenu, m365ImageFilePayloads } from "./attachments";
import type { NormalizedImageAttachment } from "../web/normalization/canonical-types";
import {
  buildM365ConversationUrl,
  isM365ChatHomeUrl,
  isM365LoginUrl,
  normalizeM365ConversationId,
  parseM365ConversationId,
  resolveM365Origin,
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
  streamIncremental?: boolean;
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
  conversationId?: string;
};

const M365_AUTH_EXPIRED_MESSAGE =
  "Phiên đăng nhập M365 Copilot đã hết hạn hoặc chưa đăng nhập. Vui lòng đăng nhập lại trong Launcher.";
const DEFAULT_M365_AUTH_SETTLE_TIMEOUT_MS = 15_000;
const INTERACTIVE_LOGIN_STABLE_MS = 2_500;

export interface M365BrowserWorkerOptions {
  authSettleTimeoutMs?: number;
}

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
  private readonly authSettleTimeoutMs: number;
  private readonly domObserver = new M365DomObserver();
  private readonly clipboardSalvage = new M365ClipboardSalvage();
  private readonly activeEditors = new WeakMap<Page, Locator>();
  private readonly retainedConversationIds = new WeakMap<Page, string>();
  private readonly responseStates = new WeakMap<
    Page,
    M365ResponseRuntimeState
  >();

  constructor(options: M365BrowserWorkerOptions = {}) {
    super();
    this.authSettleTimeoutMs =
      typeof options.authSettleTimeoutMs === "number" &&
      Number.isFinite(options.authSettleTimeoutMs) &&
      options.authSettleTimeoutMs >= 0
        ? options.authSettleTimeoutMs
        : DEFAULT_M365_AUTH_SETTLE_TIMEOUT_MS;
  }

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

  protected createResult(
    result: {
      rawResponse: string;
      conversationId?: string;
    },
    options?: M365BrowserRunOptions,
  ): M365TurnResult {
    if (!result.conversationId && options?.retain !== false) {
      throw new Error(
        "M365 completed turn did not resolve a conversation ID",
      );
    }

    return {
      rawResponse: result.rawResponse,
      ...(result.conversationId ? { conversationId: result.conversationId } : {}),
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
    // SemanticMarkdownBuffer và FastPathStreamBuffer đã phát semantic delta trong
    // applyResponseStatus. Không để shared lifecycle phát lại observation.text.
    return false;
  }

  protected override shouldDelayFirstObservation(
    _options: M365BrowserRunOptions,
  ): boolean {
    // Compatibility polling cũ luôn chờ 250ms sau submit trước lần đọc DOM đầu tiên.
    return true;
  }

  protected override resolveNextPollDelayMs(
    observation: M365ResponseObservation,
    defaultDelayMs: number,
    options: M365BrowserRunOptions,
  ): number {
    if (options.pollingIntervalMs === undefined && observation.isGenerating) {
      return Math.max(defaultDelayMs, 450);
    }
    return defaultDelayMs;
  }

  protected override async beforeObserveResponse(
    page: Page,
    baseline: M365ResponseBaseline,
    options: M365BrowserRunOptions,
  ): Promise<void> {
    const responseState = this.getResponseRuntimeState(page);
    responseState.attempts++;
    responseState.pendingStatus = await this.domObserver.captureStatus(
      page,
      baseline,
      { lightweightWhileGenerating: options.streamIncremental === false },
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
    if (
      context.observation.timedOut &&
      !responseState.fastPathActive &&
      responseState.lastBlocks.length === 0
    ) {
      const fullStatus = await this.domObserver
        .captureStatus(page, context.baseline, {
          lightweightWhileGenerating: false,
        })
        .catch(() => null);
      if (fullStatus) {
        await this.domObserver
          .applyStatus(page, responseState, fullStatus, options)
          .catch(() => {});
      }
    }

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
    const alreadyNeedsSalvage =
      needsEnvelopeFix || hasUnclosedMarkers || responseState.fastPathActive;
    const hasCodeBlockOnPage = alreadyNeedsSalvage
      ? false
      : typeof responseState.lastStatus?.hasCodeBlocks === "boolean"
        ? responseState.lastStatus.hasCodeBlocks
        : (await page
            .locator(
              ".fai-CopilotMessage:not([data-codex-turn-baseline]) button#copy-button, .fai-CopilotMessage:not([data-codex-turn-baseline]) button#preview-toggle-button, .fai-CopilotMessage:not([data-codex-turn-baseline]) button[aria-label='Copy code'], .fai-CopilotMessage:not([data-codex-turn-baseline]) button[aria-label='Code']",
            )
            .count()
            .catch(() => 0)) > 0;

    console.log(
      `[m365-worker] [salvage-eval] Đánh giá điều kiện cứu hộ: needsEnvelopeFix=${needsEnvelopeFix}, hasUnclosedMarkers=${hasUnclosedMarkers}, fastPathActive=${responseState.fastPathActive}, hasCodeBlockOnPage=${hasCodeBlockOnPage}, textLen=${fullMarkdown.length}`,
    );

    if (alreadyNeedsSalvage || hasCodeBlockOnPage) {
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
    let firstVisible: Locator | undefined;
    for (let index = 0; index < count; index += 1) {
      const candidate = locators.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        if (!firstVisible) firstVisible = candidate;
        const box = await candidate.boundingBox({ timeout: 1_000 }).catch(() => null);
        if (box && box.width > 0 && box.height > 0 && box.x >= 0 && box.y >= 0) {
          return candidate;
        }
      }
    }
    return firstVisible;
  }

  private async detectInteractiveLoginPrompt(page: Page): Promise<boolean> {
    if (typeof page.evaluate !== "function") return false;
    return await page
      .evaluate(() => {
        if (document.readyState !== "complete") return false;
        return Boolean(
          document.querySelector(
            [
              'input[name="loginfmt"]:not([type="hidden"])',
              'input[name="passwd"]:not([type="hidden"])',
              'input[name="otc"]:not([type="hidden"])',
              'input[type="password"]:not([type="hidden"])',
              "#tilesHolder [data-test-id]",
              '[data-testid="signin-prompt"]',
            ].join(", "),
          ),
        );
      })
      .catch(() => false);
  }

  /**
   * Chờ luồng Silent SSO của Microsoft Entra ID tự redirect hoàn tất trước khi
   * kết luận phiên đăng nhập hết hạn. Chỉ kết thúc sớm nếu phát hiện form
   * đăng nhập tương tác đứng ổn định trên trang login.
   */
  private async waitForM365AuthSettle(
    page: Page,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!isM365LoginUrl(page.url())) return;
    if (this.authSettleTimeoutMs <= 0) {
      throw new Error(M365_AUTH_EXPIRED_MESSAGE);
    }

    const deadline = Date.now() + this.authSettleTimeoutMs;
    const pollMs = Math.min(
      250,
      Math.max(10, Math.floor(this.authSettleTimeoutMs / 3)),
    );
    const stableLimitMs = Math.min(
      INTERACTIVE_LOGIN_STABLE_MS,
      this.authSettleTimeoutMs,
    );
    let lastUrl = page.url();
    let interactiveSince: number | null = null;

    while (true) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("M365 Copilot turn aborted while waiting for authentication");
      }
      const currentUrl = page.url();
      if (!isM365LoginUrl(currentUrl)) {
        await page
          .waitForLoadState?.("domcontentloaded", { timeout: 5_000 })
          .catch(() => {});
        if (!isM365LoginUrl(page.url())) return;
      }

      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        interactiveSince = null;
      }

      const interactive = await this.detectInteractiveLoginPrompt(page);
      if (interactive) {
        interactiveSince ??= Date.now();
        if (Date.now() - interactiveSince >= stableLimitMs) {
          break;
        }
      } else {
        interactiveSince = null;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, remaining)));
    }

    if (isM365LoginUrl(page.url())) {
      throw new Error(M365_AUTH_EXPIRED_MESSAGE);
    }
  }

  private async runPageGotoAllowingRedirectAbort(
    page: Page,
    targetUrl: string,
    isTargetReady: (currentUrl: string) => boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (signal?.aborted || !message.includes("ERR_ABORTED")) {
        throw error;
      }

      // Microsoft có thể redirect giữa m365.cloud.microsoft <-> copilot.cloud.microsoft
      // hoặc qua login.microsoftonline.com ngay khi goto vừa khởi tạo.
      await page
        .waitForLoadState?.("domcontentloaded", { timeout: 10_000 })
        .catch(() => {});
      if (isTargetReady(page.url())) return;
    }
  }

  private async gotoM365Url(
    page: Page,
    targetUrl: string,
    isTargetReady: (currentUrl: string) => boolean,
    signal?: AbortSignal,
    resolveRetryTargetUrl?: (settledUrl: string) => string,
  ): Promise<void> {
    await this.runPageGotoAllowingRedirectAbort(
      page,
      targetUrl,
      isTargetReady,
      signal,
    );
    if (isTargetReady(page.url())) return;

    if (isM365LoginUrl(page.url())) {
      await this.waitForM365AuthSettle(page, signal);
      if (isTargetReady(page.url())) return;
    }

    const retryUrl = resolveRetryTargetUrl
      ? resolveRetryTargetUrl(page.url())
      : targetUrl;
    await this.runPageGotoAllowingRedirectAbort(
      page,
      retryUrl,
      isTargetReady,
      signal,
    );
    if (isTargetReady(page.url())) return;

    if (isM365LoginUrl(page.url())) {
      await this.waitForM365AuthSettle(page, signal);
      if (isTargetReady(page.url())) return;
      const postAuthUrl = resolveRetryTargetUrl
        ? resolveRetryTargetUrl(page.url())
        : retryUrl;
      await this.runPageGotoAllowingRedirectAbort(
        page,
        postAuthUrl,
        isTargetReady,
        signal,
      );
      if (isM365LoginUrl(page.url())) {
        throw new Error(M365_AUTH_EXPIRED_MESSAGE);
      }
    }
  }

  /**
   * Xác thực surface và điều hướng theo retained-conversation contract.
   * Mismatch luôn fail-closed để không làm Codex tiếp tục nhầm conversation.
   */
  protected async navigate(
    page: Page,
    options: M365BrowserRunOptions,
  ): Promise<void> {
    if (isM365LoginUrl(page.url())) {
      await this.waitForM365AuthSettle(page, options.signal);
    }

    const currentUrl = page.url();
    const currentConversationId = parseM365ConversationId(currentUrl);

    if (options.existingConversationId) {
      if (
        currentConversationId !==
        options.existingConversationId.toLowerCase()
      ) {
        if (options.launcherReused) {
          throw new Error(
            `M365 retained conversation mismatch: expected ${options.existingConversationId}, current URL is ${currentUrl}`,
          );
        }
        const targetId =
          normalizeM365ConversationId(options.existingConversationId) ??
          options.existingConversationId.toLowerCase();
        const existingId = options.existingConversationId;
        const targetUrl = buildM365ConversationUrl(
          existingId,
          resolveM365Origin(currentUrl),
        );
        await this.gotoM365Url(
          page,
          targetUrl,
          url => parseM365ConversationId(url) === targetId,
          options.signal,
          settledUrl =>
            buildM365ConversationUrl(existingId, resolveM365Origin(settledUrl)),
        );
      }
      const targetId =
        normalizeM365ConversationId(options.existingConversationId) ??
        options.existingConversationId.toLowerCase();
      this.retainedConversationIds.set(page, targetId);
      return;
    }

    if (options.launcherReused && currentConversationId) {
      throw new Error(
        "Launcher reused an unbound M365 surface that already contains a conversation",
      );
    }

    if (!isM365ChatHomeUrl(currentUrl)) {
      const targetHomeUrl = `${resolveM365Origin(currentUrl)}/chat`;
      await this.gotoM365Url(
        page,
        targetHomeUrl,
        isM365ChatHomeUrl,
        options.signal,
        settledUrl => `${resolveM365Origin(settledUrl)}/chat`,
      );
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
      const target = M365ModelProvider.getInstance().resolveCapabilityTarget(
        options.modelSlug,
        options.reasoning,
      );
      const ok = await ensureM365CapabilityTarget(page, target).catch(error => {
        console.warn(
          `[m365-worker] Warning: Failed to ensure capability mode '${target.mode}':`,
          error,
        );
        return false;
      });
      if (!ok && target.mode !== "auto") {
        throw new Error(
          `[M365 Copilot] Không thể chuyển sang model/chế độ '${target.spec?.label ?? target.mode}' cho '${options.modelSlug}' trên cuộc trò chuyện hiện tại.`,
        );
      }
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
  ): Promise<string | undefined> {
    if (options.retain === false) {
      return (
        parseM365ConversationId(page.url()) ||
        this.retainedConversationIds.get(page) ||
        options.existingConversationId?.toLowerCase()
      );
    }

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
      delete (window as any).__m365_code_lines_cache_by_element;
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

  private async isPromptSubmitted(
    page: Page,
    activeEditor: Locator,
  ): Promise<{ submitted: boolean; stopVisible: boolean; editorLength: number }> {
    const stopLocator = await this.findVisibleLocator(
      page,
      CHAT_SELECTORS.stopButton,
    );
    const editorText = (
      (await activeEditor.textContent({ timeout: 1_000 }).catch(() => "")) ?? ""
    ).trim();
    return {
      submitted: Boolean(stopLocator) || editorText.length === 0,
      stopVisible: Boolean(stopLocator),
      editorLength: editorText.length,
    };
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
          ? await sendLocator.isEnabled({ timeout: 1_000 }).catch(() => false)
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

      await this.sendHeartbeat(options);

      const submitState = await this.isPromptSubmitted(page, activeEditor);
      promptSubmitted = submitState.submitted;

      if (promptSubmitted) {
        console.log(
          `[m365-worker] [send] Đã xác nhận prompt được gửi thành công ở lần thử ${submitAttempt + 1} (stopVisible=${submitState.stopVisible}, editorLength=${submitState.editorLength})`,
        );
        break;
      }

      const sendLocator = await this.findVisibleLocator(
        page,
        CHAT_SELECTORS.sendButton,
      );
      const sendEnabled = sendLocator
        ? await sendLocator.isEnabled({ timeout: 1_000 }).catch(() => false)
        : false;

      if (sendLocator && sendEnabled) {
        console.log(
          `[m365-worker] [send] Click Send visible ở lần thử ${submitAttempt + 1} (editorLength=${submitState.editorLength})`,
        );
        try {
          await sendLocator.click({ timeout: 1_000 });
        } catch (error) {
          console.warn(
            `[m365-worker] [send] Click Send thất bại ở lần thử ${submitAttempt + 1}:`,
            error,
          );
          if (options.signal?.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }

          // Nếu click đã kích hoạt M365 thay nút Send bằng Stop hoặc xóa editor trước khi
          // Playwright nhận ack timeout, xác nhận gửi thành công ngay để tránh fallback chờ 30s.
          const postClickState = await this.isPromptSubmitted(page, activeEditor);
          if (postClickState.submitted) {
            console.log(
              `[m365-worker] [send] Đã xác nhận prompt được gửi sau click timeout ở lần thử ${submitAttempt + 1} (stopVisible=${postClickState.stopVisible}, editorLength=${postClickState.editorLength})`,
            );
            promptSubmitted = true;
            break;
          }

          await sendLocator
            .evaluate(
              (el) => {
                (el as HTMLElement).scrollIntoView({
                  block: "center",
                  inline: "center",
                  behavior: "instant",
                });
              },
              undefined,
              { timeout: 1_000 },
            )
            .catch(() => {});
          const box = await sendLocator
            .boundingBox({ timeout: 1_000 })
            .catch(() => null);
          if (box && box.width > 0 && box.height > 0) {
            await page.mouse
              .click(box.x + box.width / 2, box.y + box.height / 2)
              .catch(mouseError => {
                console.warn(
                  `[m365-worker] [send] Fallback mouse.click thất bại ở lần thử ${submitAttempt + 1}:`,
                  mouseError,
                );
              });
          }
        }
      } else {
        console.log(
          `[m365-worker] [send] Send chưa visible/enabled ở lần thử ${submitAttempt + 1} (editorLength=${submitState.editorLength}), chờ UI đồng bộ...`,
        );
      }

      await page.waitForTimeout(300);
    }

    if (!promptSubmitted) {
      const remainingText = (
        (await activeEditor.textContent({ timeout: 1_000 }).catch(() => "")) ?? ""
      ).trim();
      throw new Error(
        `[m365-worker] Không thể xác nhận prompt đã được gửi sau 10 lần thử (editorLength=${remainingText.length}).`,
      );
    }
  }
}
