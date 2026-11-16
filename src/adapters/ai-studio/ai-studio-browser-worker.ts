import type { Page } from "playwright-core";
import {
  BaseWebBrowserWorker,
  BrowserHardTimeoutError,
  BrowserIdleTimeoutError,
  type BaseBrowserRunOptions,
  type BrowserCompletionContext,
} from "../web/browser";
import type { NormalizedImageAttachment } from "../web/normalization/canonical-types";
import { aiStudioImageFilePayloads, attachAiStudioFiles } from "./attachments";
import { ensureAiStudioThinkingLevel, resolveAiStudioThinkingLevel } from "./capability-picker";
import {
  AI_STUDIO_DEFAULT_MODEL_SLUG,
  AI_STUDIO_ORIGIN,
  buildAiStudioConversationUrl,
  buildAiStudioNewChatUrl,
  parseAiStudioConversationId,
  waitForAiStudioConversationId,
} from "./conversation-url";
import { AiStudioClipboardSalvage } from "./ai-studio-clipboard-salvage";
import {
  AI_STUDIO_DOM_SELECTORS,
  AiStudioDomObserver,
  type AiStudioResponseBaseline,
  type AiStudioResponseObservation,
  type AiStudioResponseRuntimeState,
} from "./ai-studio-dom-observer";

export interface AiStudioBrowserRunOptions extends BaseBrowserRunOptions {
  conversationKey?: string;
  existingConversationId?: string;
  launcherReused?: boolean;
  modelSlug?: string;
  reasoning?: string;
  images?: NormalizedImageAttachment[];
}

export interface AiStudioTurnResult {
  rawResponse: string;
  conversationId?: string;
}

export function selectPreferredAiStudioResponse(
  copiedMarkdown: string | null,
  domMarkdown: string,
): { rawResponse: string; source: "clipboard" | "dom" } {
  const cleanCopied = copiedMarkdown?.trim() || "";
  const cleanDom = domMarkdown.trim();
  if (!cleanCopied) {
    return { rawResponse: cleanDom, source: "dom" };
  }

  const domHasCompleteEnvelope =
    cleanDom.includes("<webResponse>") && cleanDom.includes("</webResponse>");
  const copiedHasCompleteEnvelope =
    cleanCopied.includes("<webResponse>") && cleanCopied.includes("</webResponse>");

  if (domHasCompleteEnvelope && !copiedHasCompleteEnvelope) {
    return { rawResponse: cleanDom, source: "dom" };
  }

  return { rawResponse: cleanCopied, source: "clipboard" };
}

/**
 * Thực thi lượt hội thoại với Google AI Studio (`aistudio.google.com`) thông qua
 * Template Method trên `BaseWebBrowserWorker`.
 */
export class AiStudioBrowserWorker extends BaseWebBrowserWorker<
  AiStudioBrowserRunOptions,
  AiStudioTurnResult,
  AiStudioResponseBaseline,
  AiStudioResponseObservation
> {
  protected readonly logPrefix = "ai-studio-worker";
  protected readonly defaultHardTimeoutMs = 20 * 60_000;
  protected readonly defaultIdleTimeoutMs = 45_000;
  protected readonly defaultPollingIntervalMs = 250;
  protected readonly defaultHeartbeatIntervalMs = 10_000;

  private readonly domObserver = new AiStudioDomObserver();
  private readonly clipboardSalvage = new AiStudioClipboardSalvage();
  private readonly runtimeStates = new WeakMap<Page, AiStudioResponseRuntimeState>();
  private readonly retainedConversationIds = new WeakMap<Page, string>();

  protected override async initializeTurnState(
    page: Page,
    _options: AiStudioBrowserRunOptions,
  ): Promise<void> {
    this.runtimeStates.set(page, this.domObserver.createRuntimeState());
  }

  protected override async cleanupTurnState(
    page: Page,
    _options: AiStudioBrowserRunOptions,
  ): Promise<void> {
    this.runtimeStates.delete(page);
  }

  protected override async navigate(
    page: Page,
    options: AiStudioBrowserRunOptions,
  ): Promise<void> {
    const currentConversationId = parseAiStudioConversationId(page.url());

    if (options.existingConversationId) {
      if (currentConversationId && currentConversationId !== options.existingConversationId) {
        if (options.launcherReused) {
          throw new Error(
            `AI Studio retained conversation mismatch: expected ${options.existingConversationId}, current URL is ${page.url()}`,
          );
        }
      }

      if (currentConversationId !== options.existingConversationId) {
        await page.goto(buildAiStudioConversationUrl(options.existingConversationId), {
          waitUntil: "domcontentloaded",
          timeout: 25_000,
        });
      }

      await page.waitForSelector(AI_STUDIO_DOM_SELECTORS.composer, { timeout: 20_000 });
      await page.waitForSelector(".chat-session-content ms-chat-turn", { timeout: 15_000 }).catch(() => {});
      this.retainedConversationIds.set(page, options.existingConversationId);
      return;
    }

    if (options.launcherReused && currentConversationId) {
      throw new Error(
        "Launcher reused an unbound AI Studio surface that already contains a conversation",
      );
    }

    const modelName = this.extractTargetModelSlug(options.modelSlug);
    const targetNewChatUrl = buildAiStudioNewChatUrl(modelName);
    const currentUrl = page.url();
    const isOnNewChatUrl = currentUrl.startsWith(`${AI_STUDIO_ORIGIN}/prompts/new_chat`);
    const isCleanBlankNewChat = isOnNewChatUrl
      ? await page.evaluate((targetModel) => {
          const turns = document.querySelectorAll(".chat-session-content ms-chat-turn, .chat-session-content .chat-turn-container");
          if (turns.length > 0) return false;
          const panelText = (document.querySelector(".run-settings-panel, ms-run-settings")?.textContent || "").toLowerCase();
          return panelText.includes(targetModel.toLowerCase());
        }, modelName).catch(() => false)
      : false;

    if (!isCleanBlankNewChat || currentConversationId) {
      await page.goto(targetNewChatUrl, {
        waitUntil: "domcontentloaded",
        timeout: 25_000,
      });
    }

    await page.waitForSelector(AI_STUDIO_DOM_SELECTORS.composer, { timeout: 20_000 });
  }

  protected override async prepareProvider(
    page: Page,
    options: AiStudioBrowserRunOptions,
  ): Promise<void> {
    await page.waitForSelector(AI_STUDIO_DOM_SELECTORS.composer, { timeout: 15_000 });

    const targetLevel = resolveAiStudioThinkingLevel(
      options.modelSlug || "ai-studio/gemini-4-hydrogen",
      options.reasoning,
    );
    await ensureAiStudioThinkingLevel(page, targetLevel).catch(error => {
      console.warn(
        `[ai-studio-worker] Không thể chọn Thinking Level '${targetLevel}':`,
        error,
      );
    });

    await this.waitForComposerIdle(page);
  }

  protected override async captureResponseBaseline(
    page: Page,
  ): Promise<AiStudioResponseBaseline> {
    return await this.domObserver.captureBaseline(page);
  }

  protected override async insertPrompt(
    page: Page,
    promptText: string,
    options: AiStudioBrowserRunOptions,
  ): Promise<void> {
    if (options.images && options.images.length > 0) {
      const payloads = aiStudioImageFilePayloads(options.images);
      await attachAiStudioFiles(page, payloads, { signal: options.signal }).catch(error => {
        console.warn("[ai-studio-worker] Lỗi khi đính kèm ảnh vào AI Studio:", error);
      });
    }

    const composer = page.locator(AI_STUDIO_DOM_SELECTORS.composer).first();
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    await composer.click({ timeout: 2_000 }).catch(() => {});
    await composer.fill(promptText);

    const currentValue = await composer.inputValue().catch(() => "");
    if (!currentValue || currentValue.length === 0) {
      await page.evaluate(({ selector, value }) => {
        const el = document.querySelector<HTMLTextAreaElement>(selector);
        if (!el) return;
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, { selector: AI_STUDIO_DOM_SELECTORS.composer, value: promptText });
    }
    await page.waitForTimeout(150);
  }

  protected override async submitPrompt(
    page: Page,
    options: AiStudioBrowserRunOptions,
  ): Promise<void> {
    const runBtn = page.locator(AI_STUDIO_DOM_SELECTORS.runOrStopButton).first();
    const composer = page.locator(AI_STUDIO_DOM_SELECTORS.composer).first();

    let submitted = false;
    let emptyEditorWaitCycles = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (options.signal?.aborted) {
        throw new DOMException("AI Studio turn aborted during submit", "AbortError");
      }

      const status = await page.evaluate(({ btnSelector, liveSelector, composerSelector }) => {
        const btn = document.querySelector<HTMLButtonElement>(btnSelector);
        const btnText = (btn?.innerText || btn?.getAttribute("aria-label") || "").trim().toLowerCase();
        const isDisabled = Boolean(btn?.disabled || btn?.getAttribute("aria-disabled") === "true");
        const liveText = Array.from(document.querySelectorAll<HTMLElement>(liveSelector))
          .map(el => (el.innerText || "").trim())
          .join(" ");
        const editor = document.querySelector<HTMLTextAreaElement>(composerSelector);
        return {
          isStop: btnText.includes("stop") || btnText.includes("cancel"),
          isRunningLive: /running/i.test(liveText),
          isDisabled,
          editorLength: (editor?.value || "").trim().length,
        };
      }, {
        btnSelector: AI_STUDIO_DOM_SELECTORS.runOrStopButton,
        liveSelector: AI_STUDIO_DOM_SELECTORS.liveStatus,
        composerSelector: AI_STUDIO_DOM_SELECTORS.composer,
      });

      if (status.isStop || status.isRunningLive) {
        submitted = true;
        break;
      }

      if (status.editorLength === 0) {
        emptyEditorWaitCycles += 1;
        if (emptyEditorWaitCycles >= 3) {
          submitted = true;
          break;
        }
        await page.waitForTimeout(250);
        continue;
      }

      if (!status.isDisabled) {
        await runBtn.click({ timeout: 2_000 }).catch(async () => {
          await composer.press("Meta+Enter").catch(() => {});
        });
      }

      await page.waitForTimeout(250);
    }

    if (!submitted) {
      throw new Error("[ai-studio-worker] Không thể xác nhận prompt đã được gửi trên AI Studio.");
    }
  }

  protected override shouldDelayFirstObservation(): boolean {
    return true;
  }

  protected override shouldEmitObservationDelta(): boolean {
    return false;
  }

  protected override shouldEnforceIdleTimeout(observation: AiStudioResponseObservation): boolean {
    return !observation.isGenerating;
  }

  protected override onWaitTimeout(
    _error: BrowserHardTimeoutError | BrowserIdleTimeoutError,
    lastObservation: AiStudioResponseObservation | undefined,
  ): AiStudioResponseObservation | undefined {
    if (lastObservation?.status.hasContent && lastObservation.text.trim()) {
      return { ...lastObservation, timedOut: true };
    }
    return undefined;
  }

  protected override async beforeObserveResponse(
    page: Page,
    baseline: AiStudioResponseBaseline,
  ): Promise<void> {
    const state = this.getRuntimeState(page);
    state.attempts += 1;
    state.pendingStatus = await this.domObserver.captureStatus(page, baseline);
  }

  protected override async observeResponse(
    page: Page,
  ): Promise<AiStudioResponseObservation> {
    const state = this.getRuntimeState(page);
    const pending = state.pendingStatus;
    if (!pending) {
      throw new Error("AI Studio observeResponse missing captured status");
    }
    state.pendingStatus = null;
    return this.domObserver.applyStatus(state, pending);
  }

  protected override async extractCompletedResponse(
    page: Page,
    context: BrowserCompletionContext<AiStudioResponseBaseline, AiStudioResponseObservation>,
    options: AiStudioBrowserRunOptions,
  ): Promise<string> {
    const copiedMarkdown = await this.clipboardSalvage.tryExtractMarkdown(
      page,
      context.baseline.answerCount,
    );
    const domMarkdown = context.observation.text.trim();
    const { rawResponse, source } = selectPreferredAiStudioResponse(copiedMarkdown, domMarkdown);

    const state = this.runtimeStates.get(page);
    const hasOpen = rawResponse.includes("<webResponse>");
    const hasClose = rawResponse.includes("</webResponse>");
    const hasFence = /^`{4}markdown\b/i.test(rawResponse);
    console.log(
      `[ai-studio-worker] [extract] source=${source} len=${rawResponse.length} copiedLen=${copiedMarkdown?.length ?? 0} domLen=${domMarkdown.length} open=${hasOpen} close=${hasClose} fence=${hasFence} footer=${context.observation.status.hasTurnFooter} readyLive=${context.observation.status.responseReadyLive} attempts=${state?.attempts ?? 0}`,
    );

    if (!rawResponse) {
      throw new Error("[AI Studio] Không nhận được nội dung phản hồi từ Gemini 4 Hydrogen.");
    }

    if (options.signal?.aborted) {
      throw new DOMException("AI Studio turn aborted", "AbortError");
    }

    return rawResponse;
  }

  protected override async resolveConversationId(
    page: Page,
    options: AiStudioBrowserRunOptions,
  ): Promise<string | undefined> {
    if (options.retain === false) {
      return (
        parseAiStudioConversationId(page.url()) ||
        this.retainedConversationIds.get(page) ||
        options.existingConversationId
      );
    }

    const conversationId =
      parseAiStudioConversationId(page.url()) ||
      (await waitForAiStudioConversationId(page, 12_000)) ||
      this.retainedConversationIds.get(page) ||
      options.existingConversationId;

    if (!conversationId) {
      throw new Error(
        "AI Studio did not expose a persistent /prompts/{id} URL after completing the turn",
      );
    }

    return conversationId;
  }

  protected override async stopGeneration(page: Page): Promise<boolean> {
    const btn = page.locator(AI_STUDIO_DOM_SELECTORS.runOrStopButton).first();
    const label = ((await btn.innerText().catch(() => "")) || (await btn.getAttribute("aria-label").catch(() => "")) || "").toLowerCase();
    if (!label.includes("stop") && !label.includes("cancel")) return false;
    return await btn.click({ timeout: 1_500 }).then(() => true).catch(() => false);
  }

  private getRuntimeState(page: Page): AiStudioResponseRuntimeState {
    let state = this.runtimeStates.get(page);
    if (!state) {
      state = this.domObserver.createRuntimeState();
      this.runtimeStates.set(page, state);
    }
    return state;
  }

  private extractTargetModelSlug(modelId?: string): string {
    if (!modelId) return AI_STUDIO_DEFAULT_MODEL_SLUG;
    const prefix = "ai-studio/";
    return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
  }

  private async waitForComposerIdle(page: Page): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const btnText = ((await page.locator(AI_STUDIO_DOM_SELECTORS.runOrStopButton).first().innerText().catch(() => "")) || "").trim().toLowerCase();
      if (!btnText.includes("stop") && !btnText.includes("cancel")) return;
      await page.waitForTimeout(250);
    }
  }
}

