import type { Locator, Page, Request } from "playwright-core";
import {
  BaseWebBrowserWorker,
  BrowserHardTimeoutError,
  BrowserIdleTimeoutError,
  type BaseBrowserRunOptions,
  type BaseBrowserTurnResult,
  type BrowserCompletionContext,
} from "../web/browser";
import type { NormalizedImageAttachment } from "../web/normalization/canonical-types";
import { ChatGptAttachments } from "./attachments";
import { ChatGptCapabilityPicker } from "./capability-picker";
import {
  ChatGptClipboardSalvage,
  selectPreferredChatGptResponse,
} from "./chatgpt-clipboard-salvage";
import {
  ChatGptDomObserver,
  type ChatGptObserverRuntimeState,
  type ChatGptResponseBaseline,
  type ChatGptResponseObservation,
} from "./chatgpt-dom-observer";
import {
  buildChatGptConversationUrl,
  CHATGPT_CONVERSATION_ID_WAIT_TIMEOUT_MS,
  CHATGPT_HOME_URL,
  CHATGPT_ORIGIN,
  isChatGptAuthUrl,
  parseChatGptConversationId,
  waitForChatGptConversationId,
} from "./conversation-url";
import {
  CHATGPT_DEFAULT_MODEL_SLUG,
  ChatGptModelProvider,
} from "./model-provider";
import { CHATGPT_SELECTORS } from "./selectors";

export interface ChatGptBrowserRunOptions extends BaseBrowserRunOptions {
  conversationKey?: string;
  existingConversationId?: string;
  launcherReused?: boolean;
  modelSlug?: string;
  reasoning?: string;
  images?: NormalizedImageAttachment[];
}

export interface ChatGptTurnResult extends BaseBrowserTurnResult {
  rawResponse: string;
  conversationId?: string;
}

interface NetworkTracker {
  inFlight: Set<Request>;
  seenGenerationRequest: boolean;
  cleanup: () => void;
}

export function isChatGptGenerationRequest(
  url: string,
  method: string,
): boolean {
  if (method.toUpperCase() !== "POST") return false;
  return /\/backend-api\/(?:f\/)?conversation(?:\?|$)/i.test(url);
}

/**
 * Worker Playwright điều khiển giao diện ChatGPT Web (`chatgpt.com`)
 * kế thừa khung Template Method từ `BaseWebBrowserWorker`.
 */
export class ChatGptBrowserWorker extends BaseWebBrowserWorker<
  ChatGptBrowserRunOptions,
  ChatGptTurnResult,
  ChatGptResponseBaseline,
  ChatGptResponseObservation
> {
  protected readonly logPrefix = "chatgpt-worker";
  protected readonly defaultHardTimeoutMs = 20 * 60_000;
  protected readonly defaultIdleTimeoutMs = 180_000;
  protected readonly defaultPollingIntervalMs = 250;
  protected readonly defaultHeartbeatIntervalMs = 10_000;

  private readonly domObserver = new ChatGptDomObserver();
  private readonly clipboardSalvage = new ChatGptClipboardSalvage();
  private readonly capabilityPicker = new ChatGptCapabilityPicker();
  private readonly attachments = new ChatGptAttachments();
  private readonly runtimeStates = new WeakMap<
    Page,
    ChatGptObserverRuntimeState
  >();
  private readonly retainedConversationIds = new WeakMap<Page, string>();
  private readonly networkTrackers = new WeakMap<Page, NetworkTracker>();

  protected override async initializeTurnState(
    page: Page,
    _options: ChatGptBrowserRunOptions,
  ): Promise<void> {
    this.runtimeStates.set(page, this.domObserver.createRuntimeState());
    this.attachNetworkTracker(page);
  }

  protected override async cleanupTurnState(
    page: Page,
    _options: ChatGptBrowserRunOptions,
  ): Promise<void> {
    this.networkTrackers.get(page)?.cleanup();
    this.networkTrackers.delete(page);
    this.runtimeStates.delete(page);
  }

  private attachNetworkTracker(page: Page): void {
    this.networkTrackers.get(page)?.cleanup();
    const inFlight = new Set<Request>();
    const tracker: NetworkTracker = {
      inFlight,
      seenGenerationRequest: false,
      cleanup: () => {},
    };

    const onRequest = (req: Request) => {
      if (!isChatGptGenerationRequest(req.url(), req.method())) return;
      inFlight.add(req);
      tracker.seenGenerationRequest = true;
    };
    const onDone = (req: Request) => {
      inFlight.delete(req);
    };

    page.on("request", onRequest);
    page.on("requestfinished", onDone);
    page.on("requestfailed", onDone);
    tracker.cleanup = () => {
      page.off("request", onRequest);
      page.off("requestfinished", onDone);
      page.off("requestfailed", onDone);
      inFlight.clear();
    };
    this.networkTrackers.set(page, tracker);
  }

  private hasInFlightGeneration(page: Page): boolean {
    const tracker = this.networkTrackers.get(page);
    return Boolean(tracker && tracker.inFlight.size > 0);
  }

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

  private assertNotAuthRedirect(url: string): void {
    if (isChatGptAuthUrl(url)) {
      throw new Error(
        "[ChatGPT] Phiên đăng nhập đã hết hạn hoặc bị chuyển sang trang xác thực. Vui lòng Sign in with Chrome lại trên Launcher.",
      );
    }
  }

  protected override async navigate(
    page: Page,
    options: ChatGptBrowserRunOptions,
  ): Promise<void> {
    const initialUrl = page.url();
    this.assertNotAuthRedirect(initialUrl);
    const currentConversationId = parseChatGptConversationId(initialUrl);

    if (options.existingConversationId) {
      if (
        currentConversationId &&
        currentConversationId !== options.existingConversationId &&
        options.launcherReused
      ) {
        throw new Error(
          `ChatGPT retained conversation mismatch: expected ${options.existingConversationId}, current URL is ${initialUrl}`,
        );
      }

      if (currentConversationId !== options.existingConversationId) {
        this.capabilityPicker.clearCache(page);
        await page.goto(
          buildChatGptConversationUrl(options.existingConversationId),
          {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          },
        );
      }
      this.assertNotAuthRedirect(page.url());
      this.retainedConversationIds.set(page, options.existingConversationId);
      return;
    }

    if (
      options.launcherReused &&
      (currentConversationId || options.isNewConversation === false)
    ) {
      if (currentConversationId) {
        this.retainedConversationIds.set(page, currentConversationId);
      }
      if (initialUrl.startsWith(CHATGPT_ORIGIN)) {
        return;
      }
    }

    if (options.isNewConversation) {
      if (!initialUrl.startsWith(CHATGPT_ORIGIN) || currentConversationId) {
        this.capabilityPicker.clearCache(page);
        await page.goto(CHATGPT_HOME_URL, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
      }
      this.assertNotAuthRedirect(page.url());
      return;
    }

    if (!initialUrl.startsWith(CHATGPT_ORIGIN)) {
      this.capabilityPicker.clearCache(page);
      await page.goto(CHATGPT_HOME_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      this.assertNotAuthRedirect(page.url());
    }
  }

  protected override async prepareProvider(
    page: Page,
    options: ChatGptBrowserRunOptions,
  ): Promise<void> {
    this.assertNotAuthRedirect(page.url());
    await this.waitForVisibleComposer(page, 20_000, options.signal);

    await this.clipboardSalvage.setupHook(page);
    await this.waitForComposerIdle(page);

    const target = ChatGptModelProvider.getInstance().resolveCapabilityTarget(
      options.modelSlug || CHATGPT_DEFAULT_MODEL_SLUG,
      options.reasoning,
    );
    const capabilityResult = await this.capabilityPicker.ensureCapabilityDetailed(
      page,
      target,
    );
    if (!capabilityResult.modelSelected) {
      throw new Error(
        `[ChatGPT] Không thể chuyển sang model '${target.modelLabel}' trên cuộc trò chuyện hiện tại: ${capabilityResult.reason || "không tìm thấy hoặc model bị giới hạn trên tài khoản này."}`,
      );
    }
    if (!capabilityResult.effortAdjusted) {
      console.warn(
        `[chatgpt-worker] Không thể đồng bộ Thinking effort '${target.thinkingEffort}' cho model '${target.modelLabel}' (giữ best-effort).`,
      );
    }
  }

  protected override async captureResponseBaseline(
    page: Page,
  ): Promise<ChatGptResponseBaseline> {
    return await this.domObserver.captureBaseline(page);
  }

  protected override async insertPrompt(
    page: Page,
    promptText: string,
    options: ChatGptBrowserRunOptions,
  ): Promise<void> {
    if (options.images && options.images.length > 0) {
      await this.attachments
        .attachImages(page, options.images.slice(0, 3), options.signal)
        .catch((error) => {
          console.warn("[chatgpt-worker] Lỗi khi đính kèm ảnh:", error);
        });
    }

    await this.waitForVisibleComposer(page, 15_000, options.signal);
    await page.bringToFront().catch(() => {});

    const composerLocator = await this.findVisibleLocator(
      page,
      CHATGPT_SELECTORS.composer,
    );
    if (!composerLocator) {
      throw new Error(
        "[chatgpt-worker] Không tìm thấy ô nhập liệu đang hiển thị để chèn prompt.",
      );
    }

    await composerLocator.click({ timeout: 3_000 });
    await composerLocator.focus({ timeout: 2_000 }).catch(() => {});

    const selectAllKey = process.platform === "darwin" ? "Meta+a" : "Control+a";
    await page.keyboard.press(selectAllKey);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(80);

    // Dùng execCommand("insertText") cho prompt dài để tránh Playwright .fill() chờ stability gây chậm/timeout
    // trên ProseMirror, và tuyệt đối không dùng paste event tránh ChatGPT tạo file "Pasted text.txt".
    let fillSuccess = false;
    if (promptText.length <= 1_500) {
      try {
        await composerLocator.fill(promptText, { timeout: 3_000 });
        fillSuccess = true;
      } catch {
        fillSuccess = false;
      }
    }

    const actualLength = fillSuccess
      ? ((await composerLocator.textContent({ timeout: 2_000 }).catch(() => "")) ?? "").trim().length
      : 0;
    if (!fillSuccess || actualLength < promptText.trim().length * 0.8) {
      await page.evaluate(
        ({ selector, text }) => {
          const candidates = Array.from(
            document.querySelectorAll<HTMLElement>(selector),
          );
          const editor =
            candidates.find((el) => {
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            }) ?? candidates[0];
          if (!editor) return;
          editor.focus();
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(editor);
          selection?.removeAllRanges();
          selection?.addRange(range);
          document.execCommand("delete", false, undefined);
          document.execCommand("insertText", false, text);
          editor.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              inputType: "insertText",
              data: text,
            }),
          );
          editor.dispatchEvent(new Event("input", { bubbles: true }));
          editor.dispatchEvent(new Event("change", { bubbles: true }));
        },
        { selector: CHATGPT_SELECTORS.composer, text: promptText },
      );
      await page.waitForTimeout(250);
    }

    const sendLocator = await this.findVisibleLocator(
      page,
      CHATGPT_SELECTORS.sendButton,
    );
    const isSendEnabled = sendLocator
      ? await sendLocator.isEnabled({ timeout: 500 }).catch(() => false)
      : false;
    if (!isSendEnabled) {
      await composerLocator.focus({ timeout: 1_500 }).catch(() => {});
      await page.keyboard.press("Space").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
      await page.waitForTimeout(180);
    }
  }

  protected override async submitPrompt(
    page: Page,
    options: ChatGptBrowserRunOptions,
  ): Promise<void> {
    const composerLocator = await this.findVisibleLocator(
      page,
      CHATGPT_SELECTORS.composer,
    );
    if (!composerLocator) {
      throw new Error(
        "[chatgpt-worker] Không tìm thấy composer đang hiển thị để gửi prompt.",
      );
    }

    const tracker = this.networkTrackers.get(page);
    if (tracker) {
      tracker.seenGenerationRequest = false;
    }

    const submitDeadline = Date.now() + 15_000;
    let attempt = 0;
    let clickedAtLeastOnce = false;

    while (Date.now() < submitDeadline) {
      if (options.signal?.aborted) {
        throw new DOMException(
          "ChatGPT turn aborted during submit",
          "AbortError",
        );
      }
      attempt += 1;

      const stopVisible = await this.findVisibleLocator(
        page,
        CHATGPT_SELECTORS.stopButton,
      );
      const composerText = (
        (await composerLocator.textContent({ timeout: 1_500 }).catch(() => "")) ?? ""
      ).trim();

      if (
        Boolean(stopVisible) ||
        (clickedAtLeastOnce &&
          (this.hasInFlightGeneration(page) ||
            Boolean(tracker?.seenGenerationRequest) ||
            composerText.length === 0))
      ) {
        return;
      }

      if (!clickedAtLeastOnce && composerText.length === 0) {
        throw new Error(
          "[chatgpt-worker] Composer trống trước khi bấm nút Send.",
        );
      }

      const sendLocator = await this.findVisibleLocator(
        page,
        CHATGPT_SELECTORS.sendButton,
      );
      const canClickSend = sendLocator
        ? await sendLocator.isEnabled({ timeout: 300 }).catch(() => false)
        : false;

      if (sendLocator && canClickSend) {
        const clickOk = await sendLocator
          .click({ timeout: 1_500 })
          .then(() => true)
          .catch(() => false);
        if (clickOk) {
          clickedAtLeastOnce = true;
        }
      } else if (attempt >= 2 && attempt % 2 === 0) {
        await composerLocator.focus().catch(() => {});
        await page.keyboard.press("Space").catch(() => {});
        await page.keyboard.press("Backspace").catch(() => {});
      }

      await page.waitForTimeout(350);
    }

    throw new Error(
      "[chatgpt-worker] Không thể xác nhận prompt đã được gửi trong 15 giây.",
    );
  }

  protected override shouldDelayFirstObservation(): boolean {
    return true;
  }

  protected override shouldEmitObservationDelta(
    _observation: ChatGptResponseObservation,
    options: ChatGptBrowserRunOptions,
  ): boolean {
    return options.streamIncremental === true;
  }

  protected override resolveNextPollDelayMs(
    observation: ChatGptResponseObservation,
    defaultDelayMs: number,
    options: ChatGptBrowserRunOptions,
  ): number {
    if (options.pollingIntervalMs === undefined && observation.isGenerating) {
      return Math.max(defaultDelayMs, 450);
    }
    return defaultDelayMs;
  }

  protected override shouldEnforceIdleTimeout(
    observation: ChatGptResponseObservation,
  ): boolean {
    return !observation.isGenerating && !observation.networkInFlight;
  }

  protected override onWaitTimeout(
    _error: BrowserHardTimeoutError | BrowserIdleTimeoutError,
    lastObservation: ChatGptResponseObservation | undefined,
  ): ChatGptResponseObservation | undefined {
    if (lastObservation?.text.trim()) {
      return { ...lastObservation, timedOut: true };
    }
    return undefined;
  }

  protected override async beforeObserveResponse(
    page: Page,
    baseline: ChatGptResponseBaseline,
    options: ChatGptBrowserRunOptions,
  ): Promise<void> {
    const state = this.getRuntimeState(page);
    state.attempts += 1;
    const now = Date.now();
    const captureFullWhileGenerating =
      options.streamIncremental === true &&
      now - state.lastStreamSnapshotAt >= 650;
    const status = await this.domObserver.captureStatus(page, baseline, {
      captureFullWhileGenerating,
    });
    if (captureFullWhileGenerating && status.isGenerating && status.hasNewResponse) {
      state.lastStreamSnapshotAt = now;
    }
    state.pendingStatus = status;
  }

  protected override async observeResponse(
    page: Page,
    baseline: ChatGptResponseBaseline,
  ): Promise<ChatGptResponseObservation> {
    const state = this.getRuntimeState(page);
    const pending = state.pendingStatus;
    if (!pending) {
      throw new Error("ChatGPT observeResponse missing captured status");
    }
    state.pendingStatus = null;
    return this.domObserver.applyStatus(
      state,
      baseline,
      pending,
      this.hasInFlightGeneration(page),
    );
  }

  protected override async extractCompletedResponse(
    page: Page,
    context: BrowserCompletionContext<
      ChatGptResponseBaseline,
      ChatGptResponseObservation
    >,
    options: ChatGptBrowserRunOptions,
  ): Promise<string> {
    const copied = await this.clipboardSalvage
      .extractCopiedResponse(page, context.baseline)
      .catch(() => null);
    const domMarkdown = context.observation.text.trim();
    const { rawResponse, source } = selectPreferredChatGptResponse(
      copied,
      domMarkdown,
    );

    const state = this.runtimeStates.get(page);
    console.log(
      `[chatgpt-worker] [extract] source=${source} len=${rawResponse.length} copiedLen=${copied?.length ?? 0} domLen=${domMarkdown.length} attempts=${state?.attempts ?? 0}`,
    );

    if (!rawResponse) {
      throw new Error(
        "[ChatGPT] Không nhận được nội dung phản hồi từ ChatGPT Web.",
      );
    }

    if (options.signal?.aborted) {
      throw new DOMException("ChatGPT turn aborted", "AbortError");
    }

    return rawResponse;
  }

  protected override async resolveConversationId(
    page: Page,
    options: ChatGptBrowserRunOptions,
  ): Promise<string | undefined> {
    const immediateId = parseChatGptConversationId(page.url());
    if (options.retain === false) {
      return (
        immediateId ||
        this.retainedConversationIds.get(page) ||
        options.existingConversationId
      );
    }

    const knownId =
      immediateId ||
      this.retainedConversationIds.get(page) ||
      options.existingConversationId;
    const resolved =
      knownId ||
      (await waitForChatGptConversationId(
        page,
        CHATGPT_CONVERSATION_ID_WAIT_TIMEOUT_MS,
        options.signal,
      ));

    if (resolved) {
      this.retainedConversationIds.set(page, resolved);
    } else {
      console.warn(
        "[chatgpt-worker] ChatGPT did not expose /c/{id} URL yet; keeping launcher tab retained in-session.",
      );
    }
    return resolved;
  }

  protected override async stopGeneration(page: Page): Promise<boolean> {
    const stopBtn = await this.findVisibleLocator(
      page,
      CHATGPT_SELECTORS.stopButton,
    );
    if (!stopBtn) return false;
    return await stopBtn
      .click({ timeout: 1_500 })
      .then(() => true)
      .catch(async () => {
        return await stopBtn
          .click({ force: true, timeout: 1_000 })
          .then(() => true)
          .catch(() => false);
      });
  }

  private getRuntimeState(page: Page): ChatGptObserverRuntimeState {
    let state = this.runtimeStates.get(page);
    if (!state) {
      state = this.domObserver.createRuntimeState();
      this.runtimeStates.set(page, state);
    }
    return state;
  }

  private async waitForVisibleComposer(
    page: Page,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new DOMException("ChatGPT turn aborted", "AbortError");
      }
      const visible = await this.findVisibleLocator(
        page,
        CHATGPT_SELECTORS.composer,
      );
      if (visible) return;
      await page.waitForTimeout(100);
    }
    throw new Error(
      `[chatgpt-worker] Không tìm thấy ô nhập liệu ChatGPT hiển thị sau ${timeoutMs}ms.`,
    );
  }

  private async waitForComposerIdle(page: Page): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const stopBtn = await this.findVisibleLocator(
        page,
        CHATGPT_SELECTORS.stopButton,
      );
      if (!stopBtn) return;
      await page.waitForTimeout(250);
    }
  }
}
