import type { Locator, Page, Request } from "playwright-core";
import {
  BaseWebBrowserWorker,
  BrowserHardTimeoutError,
  BrowserIdleTimeoutError,
  type BaseBrowserRunOptions,
  type BrowserCompletionContext,
} from "../web/browser";
import type { NormalizedImageAttachment } from "../web/normalization/canonical-types";
import { selectPreferredAiStudioResponse } from "../ai-studio/ai-studio-browser-worker";
import {
  normalizeCopiedAiStudioCodeSnippet,
  resolveClipboardMenuItemIndex,
} from "../ai-studio/ai-studio-clipboard-salvage";
import {
  AI_STUDIO_DOM_SELECTORS,
  type AiStudioResponseBaseline,
} from "../ai-studio/ai-studio-dom-observer";
import {
  AI_STUDIO_DEFAULT_MODEL_SLUG,
  AI_STUDIO_ORIGIN,
  buildAiStudioConversationUrl,
  buildAiStudioNewChatUrl,
  parseAiStudioConversationId,
} from "../ai-studio/conversation-url";
import { AiStudioPlaywrightModelProvider } from "./model-provider";
import {
  clickResilient,
  humanPause,
  waitForBotGuardReady,
} from "./ai-studio-pw-human-timing";
import {
  AiStudioPlaywrightDomObserver,
  type AiStudioPlaywrightObservation,
  type AiStudioPlaywrightRuntimeState,
} from "./ai-studio-pw-dom-observer";

export interface AiStudioPlaywrightRunOptions extends BaseBrowserRunOptions {
  conversationKey?: string;
  existingConversationId?: string;
  launcherReused?: boolean;
  modelSlug?: string;
  reasoning?: string;
  images?: NormalizedImageAttachment[];
}

export interface AiStudioPlaywrightTurnResult {
  rawResponse: string;
  conversationId?: string;
}

const THINKING_LEVEL_SELECT =
  'mat-select[role="combobox"][aria-label="Thinking Level"], #mat-select-0[aria-label="Thinking Level"]';
const SELECT_OPTION_SELECTOR =
  '.mat-mdc-select-panel [role="option"], [role="listbox"] [role="option"]';
const INSERT_BUTTON_SELECTOR =
  'button[aria-label="Insert images, videos, audio, or files"]';
const UPLOAD_MENU_ITEM_SELECTOR = "button.mat-mdc-menu-item.upload-file-menu-item";
const OPEN_OPTIONS_BUTTON_SELECTOR = 'button[aria-label="Open options"]';
const CODE_COPY_BUTTON_SELECTOR =
  'ms-code-block button[aria-label="Copy code to clipboard"]';
const ANSWER_TURN_SELECTOR = `${AI_STUDIO_DOM_SELECTORS.modelTurnContainer}:not(:has(${AI_STUDIO_DOM_SELECTORS.thoughtPanel}))`;

export function isAiStudioGenerationRequest(url: string, method: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  return /GenerateContent|StreamGenerate/i.test(url);
}

interface NetworkTracker {
  inFlight: Set<Request>;
  seenGenerationRequest: boolean;
  cleanup: () => void;
}

/**
 * Playwright CDP Worker cho Google AI Studio (`ai-studio-pw/...`):
 * - Gắn trực tiếp vào tab Launcher qua CDP (không mở Chrome ngoài).
 * - Theo dõi HTTP `GenerateContent` in-flight qua `page.on('request')` để miễn trừ
 *   idle timeout trong pha Thinking kéo dài nhiều phút.
 * - Giữ nhịp thao tác tự nhiên (BotGuard settle, delay trước khi fill và submit).
 */
export class AiStudioPlaywrightWorker extends BaseWebBrowserWorker<
  AiStudioPlaywrightRunOptions,
  AiStudioPlaywrightTurnResult,
  AiStudioResponseBaseline,
  AiStudioPlaywrightObservation,
  Page
> {
  protected readonly logPrefix = "ai-studio-pw-worker";
  protected readonly defaultHardTimeoutMs = 20 * 60_000;
  protected readonly defaultIdleTimeoutMs = 180_000;
  protected readonly defaultPollingIntervalMs = 250;
  protected readonly defaultHeartbeatIntervalMs = 10_000;

  private readonly domObserver = new AiStudioPlaywrightDomObserver();
  private readonly runtimeStates = new WeakMap<Page, AiStudioPlaywrightRuntimeState>();
  private readonly retainedConversationIds = new WeakMap<Page, string>();
  private readonly botGuardSettledPages = new WeakSet<Page>();
  private readonly networkTrackers = new WeakMap<Page, NetworkTracker>();

  protected override async initializeTurnState(
    page: Page,
    _options: AiStudioPlaywrightRunOptions,
  ): Promise<void> {
    this.runtimeStates.set(page, this.domObserver.createRuntimeState());
    this.attachNetworkTracker(page);
  }

  protected override async cleanupTurnState(
    page: Page,
    _options: AiStudioPlaywrightRunOptions,
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
      if (!isAiStudioGenerationRequest(req.url(), req.method())) return;
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

  protected override async navigate(
    page: Page,
    options: AiStudioPlaywrightRunOptions,
  ): Promise<void> {
    const initialUrl = page.url();
    const currentConversationId = parseAiStudioConversationId(initialUrl);

    if (options.existingConversationId) {
      if (currentConversationId && currentConversationId !== options.existingConversationId) {
        if (options.launcherReused) {
          throw new Error(
            `AI Studio PW retained conversation mismatch: expected ${options.existingConversationId}, current URL is ${initialUrl}`,
          );
        }
      }

      if (currentConversationId !== options.existingConversationId) {
        this.botGuardSettledPages.delete(page);
        await page.goto(buildAiStudioConversationUrl(options.existingConversationId), {
          waitUntil: "domcontentloaded",
          timeout: 25_000,
        });
      }

      await page.waitForSelector(AI_STUDIO_DOM_SELECTORS.composer, { timeout: 20_000 });
      await page
        .waitForSelector(".chat-session-content ms-chat-turn", { timeout: 15_000 })
        .catch(() => {});
      this.retainedConversationIds.set(page, options.existingConversationId);
      return;
    }

    if (options.launcherReused && currentConversationId) {
      throw new Error(
        "Launcher reused an unbound AI Studio PW surface that already contains a conversation",
      );
    }

    const modelName = this.extractTargetModelSlug(options.modelSlug);
    const targetNewChatUrl = buildAiStudioNewChatUrl(modelName);
    const isOnNewChatUrl = initialUrl.startsWith(`${AI_STUDIO_ORIGIN}/prompts/new_chat`);
    if (isOnNewChatUrl) {
      await page
        .waitForSelector(AI_STUDIO_DOM_SELECTORS.composer, { timeout: 20_000 })
        .catch(() => {});
    }

    const isCleanBlankNewChat = isOnNewChatUrl
      ? await page
          .evaluate(
            ({ expectedModel }) => {
              const turns = document.querySelectorAll(".chat-session-content ms-chat-turn");
              if (turns.length > 0) return false;
              const composer = document.querySelector(
                'textarea[aria-label="Enter a prompt"]',
              ) as HTMLTextAreaElement | null;
              if (!composer) return false;
              try {
                const current = new URL(location.href);
                const modelParam = current.searchParams.get("model");
                if (expectedModel && modelParam && modelParam !== expectedModel) {
                  return false;
                }
              } catch {}
              return true;
            },
            { expectedModel: modelName },
          )
          .catch(() => false)
      : false;

    if (!isCleanBlankNewChat || currentConversationId) {
      this.botGuardSettledPages.delete(page);
      await page.goto(targetNewChatUrl, {
        waitUntil: "domcontentloaded",
        timeout: 25_000,
      });
    }

    await page.waitForSelector(AI_STUDIO_DOM_SELECTORS.composer, { timeout: 20_000 });
  }

  protected override async prepareProvider(
    page: Page,
    options: AiStudioPlaywrightRunOptions,
  ): Promise<void> {
    await page.waitForSelector(AI_STUDIO_DOM_SELECTORS.composer, { timeout: 15_000 });

    const targetLevel = AiStudioPlaywrightModelProvider.getInstance().resolveThinkingLevel(
      options.modelSlug || "ai-studio-pw/gemini-4-hydrogen",
      options.reasoning,
    );
    await this.ensureThinkingLevel(page, targetLevel).catch((error) => {
      console.warn(
        `[ai-studio-pw-worker] Không thể chọn Thinking Level '${targetLevel}':`,
        error,
      );
    });

    await this.waitForComposerIdle(page);

    if (!this.botGuardSettledPages.has(page)) {
      this.botGuardSettledPages.add(page);
      await waitForBotGuardReady(page, 2_000, 2_800).catch(() => {});
    }
    await humanPause(page, 280, 480);
  }

  private async ensureThinkingLevel(page: Page, targetLevel: string): Promise<void> {
    const select = page.locator(THINKING_LEVEL_SELECT).first();
    if (!(await select.isVisible().catch(() => false))) return;

    const currentText = ((await select.innerText().catch(() => "")) || "").trim().toLowerCase();
    const firstLine = currentText.split(/\r?\n/)[0]?.trim() || "";
    if (currentText === targetLevel.toLowerCase() || firstLine === targetLevel.toLowerCase()) {
      return;
    }

    await clickResilient(select, 3_000);
    await humanPause(page, 220, 380);
    const options = page.locator(SELECT_OPTION_SELECTOR);
    await options.first().waitFor({ state: "visible", timeout: 3_000 });
    const count = await options.count();
    for (let i = 0; i < count; i += 1) {
      const opt = options.nth(i);
      const label = ((await opt.innerText().catch(() => "")) || "").trim();
      if (label.toLowerCase() === targetLevel.toLowerCase()) {
        await clickResilient(opt, 2_000);
        await humanPause(page, 260, 440);
        return;
      }
    }
    await page.keyboard.press("Escape").catch(() => {});
  }

  protected override async captureResponseBaseline(
    page: Page,
  ): Promise<AiStudioResponseBaseline> {
    return await this.domObserver.captureBaseline(page);
  }

  protected override async insertPrompt(
    page: Page,
    promptText: string,
    options: AiStudioPlaywrightRunOptions,
  ): Promise<void> {
    if (options.images && options.images.length > 0) {
      await this.attachImages(page, options.images.slice(0, 3), options.signal).catch(
        (error) => {
          console.warn("[ai-studio-pw-worker] Lỗi khi đính kèm ảnh:", error);
        },
      );
    }

    const composer = page.locator(AI_STUDIO_DOM_SELECTORS.composer).first();
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    await composer.scrollIntoViewIfNeeded({ timeout: 1_500 }).catch(() => {});
    await composer.hover({ timeout: 1_000 }).catch(() => {});
    await humanPause(page, 180, 340);
    await composer.click({ timeout: 2_500 }).catch(() => {});
    // Nhịp nghỉ tự nhiên sau khi focus trước khi điền prompt
    await humanPause(page, 280, 480);

    await composer.fill(promptText);
    const currentValue = await composer.inputValue().catch(() => "");
    if (!currentValue) {
      await page.evaluate(
        ({ selector, value }) => {
          const el = document.querySelector<HTMLTextAreaElement>(selector);
          if (!el) return;
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
          )?.set;
          if (setter) setter.call(el, value);
          else el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        },
        { selector: AI_STUDIO_DOM_SELECTORS.composer, value: promptText },
      );
    }

    // Chờ Angular + BotGuard xử lý input event tự nhiên trước khi bấm Run
    await humanPause(page, 550, 950);
  }

  private async attachImages(
    page: Page,
    images: NormalizedImageAttachment[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return;
    const insertBtn = page.locator(INSERT_BUTTON_SELECTOR).first();
    await insertBtn.waitFor({ state: "visible", timeout: 8_000 });
    await clickResilient(insertBtn, 3_000);
    await humanPause(page, 180, 320);

    const uploadItem = page.locator(UPLOAD_MENU_ITEM_SELECTOR).first();
    await uploadItem.waitFor({ state: "visible", timeout: 4_000 });

    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 8_000 }),
      clickResilient(uploadItem, 3_000),
    ]);

    await fileChooser.setFiles(
      images.map((img) => ({
        name: img.name,
        mimeType: img.mimeType,
        buffer: img.buffer,
      })),
    );
    await humanPause(page, 420, 720);
  }

  protected override async submitPrompt(
    page: Page,
    options: AiStudioPlaywrightRunOptions,
  ): Promise<void> {
    const runBtn = page.locator(AI_STUDIO_DOM_SELECTORS.runOrStopButton).first();
    const composer = page.locator(AI_STUDIO_DOM_SELECTORS.composer).first();

    const tracker = this.networkTrackers.get(page);
    if (tracker) {
      // Xóa mọi tín hiệu RPC trước khi bấm nút Run để tránh bỏ qua bước submit
      tracker.seenGenerationRequest = false;
    }

    let submitted = false;
    let clickedAtLeastOnce = false;
    let emptyEditorWaitCycles = 0;

    for (let attempt = 0; attempt < 16; attempt += 1) {
      if (options.signal?.aborted) {
        throw new DOMException("AI Studio PW turn aborted during submit", "AbortError");
      }

      const status = await page.evaluate(
        ({ btnSelector, liveSelector, composerSelector }) => {
          const btns = [
            ...Array.from(document.querySelectorAll<HTMLButtonElement>(btnSelector)),
            ...Array.from(
              document.querySelectorAll<HTMLButtonElement>(
                'button[aria-label*="Stop" i], button[aria-label*="Cancel generation" i]',
              ),
            ),
          ];
          const isStop = btns.some((btn) => {
            const rect = btn.getBoundingClientRect();
            if (rect.width <= 0 && rect.height <= 0) return false;
            const txt = (btn.innerText || btn.getAttribute("aria-label") || "")
              .trim()
              .toLowerCase();
            return txt.includes("stop") || txt.includes("cancel");
          });
          const primaryBtn = document.querySelector<HTMLButtonElement>(btnSelector);
          const isDisabled = Boolean(
            primaryBtn?.disabled || primaryBtn?.getAttribute("aria-disabled") === "true",
          );
          const liveText = Array.from(document.querySelectorAll<HTMLElement>(liveSelector))
            .map((el) => (el.innerText || "").trim())
            .join(" ");
          const editor = document.querySelector<HTMLTextAreaElement>(composerSelector);
          return {
            isStop,
            isRunningLive: /running/i.test(liveText),
            isDisabled,
            hasPrimaryBtn: Boolean(primaryBtn),
            editorLength: (editor?.value || "").trim().length,
          };
        },
        {
          btnSelector: AI_STUDIO_DOM_SELECTORS.runOrStopButton,
          liveSelector: AI_STUDIO_DOM_SELECTORS.liveStatus,
          composerSelector: AI_STUDIO_DOM_SELECTORS.composer,
        },
      );

      if (
        status.isStop ||
        status.isRunningLive ||
        (clickedAtLeastOnce &&
          (this.hasInFlightGeneration(page) || Boolean(tracker?.seenGenerationRequest)))
      ) {
        submitted = true;
        break;
      }

      if (clickedAtLeastOnce && status.editorLength === 0) {
        emptyEditorWaitCycles += 1;
        if (emptyEditorWaitCycles >= 4) {
          submitted = true;
          break;
        }
        await page.waitForTimeout(250);
        continue;
      }

      if (status.hasPrimaryBtn && !status.isDisabled) {
        if (attempt === 0) {
          await humanPause(page, 320, 580);
          await clickResilient(runBtn, 2_500).catch(async () => {
            await composer.press("Meta+Enter").catch(() => {});
          });
        } else if (attempt === 1) {
          await humanPause(page, 220, 380);
          await composer.press("Meta+Enter").catch(async () => {
            await runBtn.click({ force: true, timeout: 1_500 }).catch(() => {});
          });
        } else {
          await runBtn.click({ force: true, timeout: 1_500 }).catch(async () => {
            await page.evaluate((sel) => {
              const btn = document.querySelector<HTMLElement>(sel);
              btn?.click();
            }, AI_STUDIO_DOM_SELECTORS.runOrStopButton);
          });
        }
        clickedAtLeastOnce = true;
      }

      await humanPause(page, 260, 420);
    }

    if (!submitted) {
      throw new Error(
        "[ai-studio-pw-worker] Không thể xác nhận prompt đã được gửi trên AI Studio.",
      );
    }
  }

  protected override shouldDelayFirstObservation(): boolean {
    return true;
  }

  protected override shouldEmitObservationDelta(): boolean {
    return false;
  }

  protected override shouldEnforceIdleTimeout(
    observation: AiStudioPlaywrightObservation,
  ): boolean {
    return !observation.isGenerating && !observation.networkInFlight;
  }

  protected override onWaitTimeout(
    _error: BrowserHardTimeoutError | BrowserIdleTimeoutError,
    lastObservation: AiStudioPlaywrightObservation | undefined,
  ): AiStudioPlaywrightObservation | undefined {
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
  ): Promise<AiStudioPlaywrightObservation> {
    const state = this.getRuntimeState(page);
    const pending = state.pendingStatus;
    if (!pending) {
      throw new Error("AI Studio PW observeResponse missing captured status");
    }
    state.pendingStatus = null;
    return this.domObserver.applyStatus(
      state,
      pending,
      this.hasInFlightGeneration(page),
    );
  }

  protected override async extractCompletedResponse(
    page: Page,
    context: BrowserCompletionContext<
      AiStudioResponseBaseline,
      AiStudioPlaywrightObservation
    >,
    options: AiStudioPlaywrightRunOptions,
  ): Promise<string> {
    const copiedMarkdown = await this.tryExtractMarkdownViaClipboard(
      page,
      context.baseline.answerCount,
    );
    const domMarkdown = context.observation.text.trim();
    const { rawResponse, source } = selectPreferredAiStudioResponse(
      copiedMarkdown,
      domMarkdown,
    );

    const state = this.runtimeStates.get(page);
    console.log(
      `[ai-studio-pw-worker] [extract] source=${source} len=${rawResponse.length} copiedLen=${copiedMarkdown?.length ?? 0} domLen=${domMarkdown.length} attempts=${state?.attempts ?? 0}`,
    );

    if (!rawResponse) {
      throw new Error(
        "[AI Studio PW] Không nhận được nội dung phản hồi từ Gemini 4 Hydrogen.",
      );
    }

    if (options.signal?.aborted) {
      throw new DOMException("AI Studio PW turn aborted", "AbortError");
    }

    return rawResponse;
  }

  private async tryExtractMarkdownViaClipboard(
    page: Page,
    baselineAnswerCount: number,
  ): Promise<string | null> {
    try {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
      await page.evaluate(() => {
        const win = window as unknown as Record<string, unknown>;
        win.__aistudio_last_copied_markdown = null;
        if (!win.__aistudio_clipboard_hooked) {
          win.__aistudio_clipboard_hooked = true;
          if (navigator.clipboard) {
            const origWriteText = navigator.clipboard.writeText?.bind(navigator.clipboard);
            navigator.clipboard.writeText = async (text: string) => {
              win.__aistudio_last_copied_markdown = text;
              if (origWriteText) {
                await origWriteText(text).catch(() => {});
              }
            };
          }
          document.addEventListener(
            "copy",
            (event: ClipboardEvent) => {
              const clipText = event.clipboardData?.getData("text/plain");
              if (clipText) win.__aistudio_last_copied_markdown = clipText;
            },
            { capture: true },
          );
        }
      });

      const answerTurns = page.locator(ANSWER_TURN_SELECTOR);
      const count = await answerTurns.count();
      if (count <= baselineAnswerCount) return null;

      const targetTurn = answerTurns.nth(count - 1);
      await targetTurn.scrollIntoViewIfNeeded().catch(() => {});
      await targetTurn.hover({ position: { x: 24, y: 24 }, timeout: 2_000 }).catch(() => {});

      const openOptionsBtn = targetTurn.locator(OPEN_OPTIONS_BUTTON_SELECTOR).first();
      if (await openOptionsBtn.isVisible().catch(() => false)) {
        await openOptionsBtn.click({ timeout: 2_000 }).catch(() => {});
        const menuItems = page.locator('[role="menuitem"], button.mat-mdc-menu-item');
        await menuItems.first().waitFor({ state: "visible", timeout: 2_000 }).catch(() => {});
        const labels: string[] = await menuItems
          .evaluateAll((els) =>
            els.map((el) => {
              const clone = el.cloneNode(true) as HTMLElement;
              for (const icon of clone.querySelectorAll("mat-icon, .mat-icon")) {
                icon.remove();
              }
              return (clone.innerText || clone.textContent || "").trim();
            }),
          )
          .catch(() => []);
        const idx = resolveClipboardMenuItemIndex(labels);
        if (idx >= 0) {
          await menuItems.nth(idx).click({ timeout: 2_000 }).catch(() => {});
          const copied = await this.readCapturedClipboard(page);
          if (copied) return copied;
        } else {
          await page.keyboard.press("Escape").catch(() => {});
        }
      }

      const codeBlocksCount = await targetTurn.locator("ms-code-block").count();
      if (codeBlocksCount === 1) {
        const copyBtn = targetTurn.locator(CODE_COPY_BUTTON_SELECTOR).first();
        if (await copyBtn.isVisible().catch(() => false)) {
          await copyBtn.click({ timeout: 2_000 }).catch(() => {});
          const copied = await this.readCapturedClipboard(page);
          if (copied) return normalizeCopiedAiStudioCodeSnippet(copied);
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private async readCapturedClipboard(page: Page): Promise<string | null> {
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      await page.waitForTimeout(100);
      const copied = await page
        .evaluate(async () => {
          const win = window as unknown as Record<string, unknown>;
          if (
            typeof win.__aistudio_last_copied_markdown === "string" &&
            win.__aistudio_last_copied_markdown.trim().length > 0
          ) {
            return win.__aistudio_last_copied_markdown.trim();
          }
          try {
            if (navigator.clipboard?.readText) {
              const sys = await navigator.clipboard.readText();
              if (sys && sys.trim().length > 0) return sys.trim();
            }
          } catch {}
          return null;
        })
        .catch(() => null);
      if (copied) return copied;
    }
    return null;
  }

  protected override async resolveConversationId(
    page: Page,
    options: AiStudioPlaywrightRunOptions,
  ): Promise<string | undefined> {
    const currentUrl = page.url();
    if (options.retain === false) {
      return (
        parseAiStudioConversationId(currentUrl) ||
        this.retainedConversationIds.get(page) ||
        options.existingConversationId
      );
    }

    const deadline = Date.now() + 6_000;
    let conversationId = parseAiStudioConversationId(currentUrl);
    while (!conversationId && Date.now() < deadline) {
      await page.waitForTimeout(150);
      conversationId = parseAiStudioConversationId(page.url());
    }

    const resolved =
      conversationId ||
      this.retainedConversationIds.get(page) ||
      options.existingConversationId;
    if (!resolved) {
      console.warn(
        "[ai-studio-pw-worker] AI Studio did not expose /prompts/{id} URL; keeping generated output.",
      );
    }
    return resolved;
  }

  protected override async stopGeneration(page: Page): Promise<boolean> {
    const candidates: Locator[] = [
      page.locator(AI_STUDIO_DOM_SELECTORS.runOrStopButton).first(),
      page
        .locator('button[aria-label*="Stop" i], button[aria-label*="Cancel generation" i]')
        .first(),
    ];
    for (const btn of candidates) {
      const label = (
        (await btn.innerText().catch(() => "")) ||
        (await btn.getAttribute("aria-label").catch(() => "")) ||
        ""
      ).toLowerCase();
      if (!label.includes("stop") && !label.includes("cancel")) continue;
      const stopped = await btn
        .click({ timeout: 1_500 })
        .then(() => true)
        .catch(async () => {
          return await btn
            .click({ force: true, timeout: 1_000 })
            .then(() => true)
            .catch(async () => {
              return await btn
                .evaluate((el) => {
                  (el as HTMLElement).click();
                  return true;
                })
                .catch(() => false);
            });
        });
      if (stopped) return true;
    }
    return false;
  }

  private getRuntimeState(page: Page): AiStudioPlaywrightRuntimeState {
    let state = this.runtimeStates.get(page);
    if (!state) {
      state = this.domObserver.createRuntimeState();
      this.runtimeStates.set(page, state);
    }
    return state;
  }

  private extractTargetModelSlug(modelId?: string): string {
    if (!modelId) return AI_STUDIO_DEFAULT_MODEL_SLUG;
    return modelId.replace(/^ai-studio(?:-pw)?\//i, "").trim() || AI_STUDIO_DEFAULT_MODEL_SLUG;
  }

  private async waitForComposerIdle(page: Page): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const btnText = (
        (await page
          .locator(AI_STUDIO_DOM_SELECTORS.runOrStopButton)
          .first()
          .innerText()
          .catch(() => "")) || ""
      )
        .trim()
        .toLowerCase();
      if (!btnText.includes("stop") && !btnText.includes("cancel")) return;
      await page.waitForTimeout(250);
    }
  }
}
