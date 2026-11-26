import type { Locator, Page } from "playwright-core";
import {
  BaseWebBrowserWorker,
  BrowserHardTimeoutError,
  BrowserIdleTimeoutError,
  type BaseBrowserRunOptions,
  type BaseBrowserTurnResult,
  type BrowserCompletionContext,
} from "../web/browser";
import type { NormalizedImageAttachment } from "../web/normalization/canonical-types";
import { GeminiAttachments } from "./attachments";
import { GeminiCapabilityPicker } from "./capability-picker";
import { focusGeminiComposer } from "./composer-input";
import {
  GeminiClipboardSalvage,
  selectPreferredGeminiResponse,
} from "./gemini-clipboard-salvage";
import {
  GeminiDomObserver,
  type GeminiObserverRuntimeState,
  type GeminiResponseBaseline,
  type GeminiResponseObservation,
} from "./gemini-dom-observer";
import {
  buildGeminiConversationUrl,
  GEMINI_CONVERSATION_ID_WAIT_TIMEOUT_MS,
  GEMINI_HOME_URL,
  GEMINI_ORIGIN,
  isGeminiAuthUrl,
  parseGeminiConversationId,
  waitForGeminiConversationId,
} from "./conversation-url";
import {
  GEMINI_DEFAULT_MODEL_SLUG,
  GeminiModelProvider,
} from "./model-provider";
import { GEMINI_SELECTORS } from "./selectors";

export interface GeminiBrowserRunOptions extends BaseBrowserRunOptions {
  conversationKey?: string;
  existingConversationId?: string;
  launcherReused?: boolean;
  modelSlug?: string;
  reasoning?: string;
  images?: NormalizedImageAttachment[];
}

export interface GeminiTurnResult extends BaseBrowserTurnResult {
  rawResponse: string;
  conversationId?: string;
}

/**
 * Worker Playwright điều khiển giao diện Gemini Web (`gemini.google.com`)
 * kế thừa khung Template Method từ `BaseWebBrowserWorker`.
 */
export class GeminiBrowserWorker extends BaseWebBrowserWorker<
  GeminiBrowserRunOptions,
  GeminiTurnResult,
  GeminiResponseBaseline,
  GeminiResponseObservation
> {
  protected readonly logPrefix = "gemini-worker";
  protected readonly defaultHardTimeoutMs = 20 * 60_000;
  protected readonly defaultIdleTimeoutMs = 180_000;
  protected readonly defaultPollingIntervalMs = 250;
  protected readonly defaultHeartbeatIntervalMs = 10_000;

  private readonly domObserver = new GeminiDomObserver();
  private readonly clipboardSalvage = new GeminiClipboardSalvage();
  private readonly capabilityPicker = new GeminiCapabilityPicker();
  private readonly attachments = new GeminiAttachments();
  private readonly runtimeStates = new WeakMap<
    Page,
    GeminiObserverRuntimeState
  >();
  private readonly retainedConversationIds = new WeakMap<Page, string>();

  protected override async initializeTurnState(
    page: Page,
    _options: GeminiBrowserRunOptions,
  ): Promise<void> {
    this.runtimeStates.set(page, this.domObserver.createRuntimeState());
  }

  protected override async cleanupTurnState(
    page: Page,
    _options: GeminiBrowserRunOptions,
  ): Promise<void> {
    this.runtimeStates.delete(page);
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
    if (isGeminiAuthUrl(url)) {
      throw new Error(
        "[Gemini] Phiên đăng nhập đã hết hạn hoặc bị chuyển sang trang đăng nhập Google. Vui lòng Sign in with Chrome lại trên Launcher.",
      );
    }
  }

  protected override async navigate(
    page: Page,
    options: GeminiBrowserRunOptions,
  ): Promise<void> {
    const initialUrl = page.url();
    this.assertNotAuthRedirect(initialUrl);
    const currentConversationId = parseGeminiConversationId(initialUrl);

    if (options.existingConversationId) {
      if (
        currentConversationId &&
        currentConversationId !== options.existingConversationId &&
        options.launcherReused
      ) {
        throw new Error(
          `Gemini retained conversation mismatch: expected ${options.existingConversationId}, current URL is ${initialUrl}`,
        );
      }

      if (currentConversationId !== options.existingConversationId) {
        this.capabilityPicker.clearCache(page);
        await page.goto(
          buildGeminiConversationUrl(options.existingConversationId),
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
      if (initialUrl.startsWith(GEMINI_ORIGIN)) {
        return;
      }
    }

    if (options.isNewConversation) {
      if (!initialUrl.startsWith(GEMINI_ORIGIN) || currentConversationId) {
        this.capabilityPicker.clearCache(page);
        await page.goto(GEMINI_HOME_URL, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
      }
      this.assertNotAuthRedirect(page.url());
      return;
    }

    if (!initialUrl.startsWith(GEMINI_ORIGIN)) {
      this.capabilityPicker.clearCache(page);
      await page.goto(GEMINI_HOME_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      this.assertNotAuthRedirect(page.url());
    }
  }

  protected override async prepareProvider(
    page: Page,
    options: GeminiBrowserRunOptions,
  ): Promise<void> {
    this.assertNotAuthRedirect(page.url());
    await this.waitForVisibleComposer(page, 20_000, options.signal);

    await this.clipboardSalvage.setupHook(page);
    await this.waitForComposerIdle(page);

    if (options.retain === false && options.isNewConversation) {
      await this.capabilityPicker
        .ensureTemporaryChat(page)
        .catch(() => false);
    }

    const target = GeminiModelProvider.getInstance().resolveCapabilityTarget(
      options.modelSlug || GEMINI_DEFAULT_MODEL_SLUG,
      options.reasoning,
    );
    const capabilityResult = await this.capabilityPicker.ensureCapabilityDetailed(
      page,
      target,
    );
    if (!capabilityResult.modelSelected) {
      throw new Error(
        `[Gemini] Không thể chuyển sang model '${target.modelLabel || target.modelSlug}' trên cuộc trò chuyện hiện tại: ${capabilityResult.reason || "không tìm thấy hoặc model bị giới hạn trên tài khoản này."}`,
      );
    }
    if (!capabilityResult.thinkingSelected) {
      console.warn(
        `[gemini-worker] Không thể đồng bộ Thinking level '${target.thinkingEffort}' cho model '${target.modelSlug}' (giữ best-effort).`,
      );
    }
  }

  protected override async captureResponseBaseline(
    page: Page,
  ): Promise<GeminiResponseBaseline> {
    return await this.domObserver.captureBaseline(page);
  }

  protected override async insertPrompt(
    page: Page,
    promptText: string,
    options: GeminiBrowserRunOptions,
  ): Promise<void> {
    if (options.images && options.images.length > 0) {
      await this.attachments.attachImages(
        page,
        options.images.slice(0, 3),
        options.signal,
      );
    }

    await this.waitForVisibleComposer(page, 15_000, options.signal);
    await page.bringToFront().catch(() => {});

    const composerLocator = await this.findVisibleLocator(
      page,
      GEMINI_SELECTORS.composer,
    );
    if (!composerLocator) {
      throw new Error(
        "[gemini-worker] Không tìm thấy ô nhập liệu đang hiển thị để chèn prompt.",
      );
    }

    await focusGeminiComposer(page, composerLocator, options.signal);

    const selectAllKey = process.platform === "darwin" ? "Meta+a" : "Control+a";
    await page.keyboard.press(selectAllKey);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(80);

    let fillSuccess = false;
    try {
      await composerLocator.fill(promptText, { timeout: 10_000 });
      fillSuccess = true;
    } catch {
      fillSuccess = false;
    }

    const expectedCompactLen = promptText.replace(/\r?\n/g, "").trim().length;
    const actualLength = fillSuccess
      ? ((await composerLocator.textContent({ timeout: 2_000 }).catch(() => "")) ?? "").trim().length
      : 0;
    if (!fillSuccess || actualLength < expectedCompactLen * 0.9) {
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
          editor.replaceChildren();
          for (const line of text.split(/\r?\n/)) {
            const p = document.createElement("p");
            if (line.length > 0) {
              p.textContent = line;
            } else {
              p.appendChild(document.createElement("br"));
            }
            editor.appendChild(p);
          }
          editor.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              inputType: "insertText",
            }),
          );
          editor.dispatchEvent(new Event("input", { bubbles: true }));
          editor.dispatchEvent(new Event("change", { bubbles: true }));
        },
        { selector: GEMINI_SELECTORS.composer, text: promptText },
      );
      await page.waitForTimeout(250);
    }

    const sendLocator = await this.findVisibleLocator(
      page,
      GEMINI_SELECTORS.sendButton,
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
    options: GeminiBrowserRunOptions,
  ): Promise<void> {
    const composerLocator = await this.findVisibleLocator(
      page,
      GEMINI_SELECTORS.composer,
    );
    if (!composerLocator) {
      throw new Error(
        "[gemini-worker] Không tìm thấy composer đang hiển thị để gửi prompt.",
      );
    }

    const submitDeadline = Date.now() + 15_000;
    let attempt = 0;
    let clickedAtLeastOnce = false;

    while (Date.now() < submitDeadline) {
      if (options.signal?.aborted) {
        throw new DOMException(
          "Gemini turn aborted during submit",
          "AbortError",
        );
      }
      attempt += 1;

      const stopVisible = await this.findVisibleLocator(
        page,
        GEMINI_SELECTORS.stopButton,
      );
      const composerText = (
        (await composerLocator.textContent({ timeout: 1_500 }).catch(() => "")) ?? ""
      ).trim();

      if (
        Boolean(stopVisible) ||
        (clickedAtLeastOnce && composerText.length === 0)
      ) {
        return;
      }

      if (!clickedAtLeastOnce && composerText.length === 0) {
        throw new Error(
          "[gemini-worker] Composer trống trước khi bấm nút Send.",
        );
      }

      const sendLocator = await this.findVisibleLocator(
        page,
        GEMINI_SELECTORS.sendButton,
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
      "[gemini-worker] Không thể xác nhận prompt đã được gửi trong 15 giây.",
    );
  }

  protected override shouldDelayFirstObservation(): boolean {
    return true;
  }

  protected override shouldEmitObservationDelta(): boolean {
    return false;
  }

  protected override resolveNextPollDelayMs(
    observation: GeminiResponseObservation,
    defaultDelayMs: number,
    options: GeminiBrowserRunOptions,
  ): number {
    if (options.pollingIntervalMs === undefined && observation.isGenerating) {
      return Math.max(defaultDelayMs, 450);
    }
    return defaultDelayMs;
  }

  protected override shouldEnforceIdleTimeout(
    observation: GeminiResponseObservation,
  ): boolean {
    return !observation.isGenerating;
  }

  protected override onWaitTimeout(
    _error: BrowserHardTimeoutError | BrowserIdleTimeoutError,
    lastObservation: GeminiResponseObservation | undefined,
  ): GeminiResponseObservation | undefined {
    if (lastObservation?.text.trim()) {
      return { ...lastObservation, timedOut: true };
    }
    return undefined;
  }

  protected override async beforeObserveResponse(
    page: Page,
    baseline: GeminiResponseBaseline,
  ): Promise<void> {
    const state = this.getRuntimeState(page);
    state.attempts += 1;
    state.pendingStatus = await this.domObserver.captureStatus(page, baseline);
  }

  protected override async observeResponse(
    page: Page,
    baseline: GeminiResponseBaseline,
  ): Promise<GeminiResponseObservation> {
    const state = this.getRuntimeState(page);
    const pending = state.pendingStatus;
    if (!pending) {
      throw new Error("Gemini observeResponse missing captured status");
    }
    state.pendingStatus = null;
    return this.domObserver.applyStatus(state, baseline, pending);
  }

  protected override async extractCompletedResponse(
    page: Page,
    context: BrowserCompletionContext<
      GeminiResponseBaseline,
      GeminiResponseObservation
    >,
    options: GeminiBrowserRunOptions,
  ): Promise<string> {
    const copied = await this.clipboardSalvage
      .extractCopiedResponse(page, context.baseline)
      .catch(() => null);
    const domMarkdown = context.observation.text.trim();
    const { rawResponse, source } = selectPreferredGeminiResponse(
      copied,
      domMarkdown,
    );

    const state = this.runtimeStates.get(page);
    console.log(
      `[gemini-worker] [extract] source=${source} len=${rawResponse.length} copiedLen=${copied?.length ?? 0} domLen=${domMarkdown.length} attempts=${state?.attempts ?? 0}`,
    );

    if (!rawResponse) {
      throw new Error(
        "[Gemini] Không nhận được nội dung phản hồi từ Gemini Web.",
      );
    }

    if (options.signal?.aborted) {
      throw new DOMException("Gemini turn aborted", "AbortError");
    }

    return rawResponse;
  }

  protected override async resolveConversationId(
    page: Page,
    options: GeminiBrowserRunOptions,
  ): Promise<string | undefined> {
    const immediateId = parseGeminiConversationId(page.url());
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
      (await waitForGeminiConversationId(
        page,
        GEMINI_CONVERSATION_ID_WAIT_TIMEOUT_MS,
        options.signal,
      ));

    if (resolved) {
      this.retainedConversationIds.set(page, resolved);
    } else {
      console.warn(
        "[gemini-worker] Gemini did not expose /app/{id} URL yet; keeping launcher tab retained in-session.",
      );
    }
    return resolved;
  }

  protected override async stopGeneration(page: Page): Promise<boolean> {
    const stopBtn = await this.findVisibleLocator(
      page,
      GEMINI_SELECTORS.stopButton,
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

  private getRuntimeState(page: Page): GeminiObserverRuntimeState {
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
        throw new DOMException("Gemini turn aborted", "AbortError");
      }
      const visible = await this.findVisibleLocator(
        page,
        GEMINI_SELECTORS.composer,
      );
      if (visible) return;
      await page.waitForTimeout(100);
    }
    throw new Error(
      `[gemini-worker] Không tìm thấy ô nhập liệu Gemini hiển thị sau ${timeoutMs}ms.`,
    );
  }

  private async waitForComposerIdle(page: Page): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const stopBtn = await this.findVisibleLocator(
        page,
        GEMINI_SELECTORS.stopButton,
      );
      if (!stopBtn) return;
      await page.waitForTimeout(250);
    }
  }
}
