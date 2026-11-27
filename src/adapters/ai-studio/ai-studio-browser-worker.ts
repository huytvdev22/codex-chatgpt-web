import type { Locator, Page, Request } from "playwright-core";
import {
  BaseWebBrowserWorker,
  BrowserHardTimeoutError,
  BrowserIdleTimeoutError,
  installInPageClipboardHook,
  releaseOsClipboardSuppression,
  type BaseBrowserRunOptions,
  type BaseBrowserTurnResult,
  type BrowserCompletionContext,
} from "../web/browser";
import type { ProviderReportedTokens } from "../../usage/types";
import type { NormalizedImageAttachment } from "../web/normalization/canonical-types";
import {
  normalizeCopiedAiStudioCodeSnippet,
  resolveClipboardMenuItemIndex,
} from "./ai-studio-clipboard-salvage";
import {
  AI_STUDIO_DOM_SELECTORS,
  AiStudioDomObserver,
  type AiStudioResponseBaseline,
  type AiStudioResponseObservation,
  type AiStudioResponseRuntimeState,
} from "./ai-studio-dom-observer";
import {
  clickResilient,
  dismissAiStudioWelcomeDialogs,
  humanPause,
  moveMouseToLocator,
  typeHumanPrompt,
  waitForBotGuardReady,
} from "./ai-studio-human-timing";
import {
  AI_STUDIO_CONVERSATION_ID_WAIT_TIMEOUT_MS,
  AI_STUDIO_DEFAULT_MODEL_SLUG,
  AI_STUDIO_ORIGIN,
  buildAiStudioConversationUrl,
  buildAiStudioNewChatUrl,
  parseAiStudioConversationId,
  waitForAiStudioConversationId,
} from "./conversation-url";
import { AiStudioCapabilityPicker } from "./capability-picker";

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
  providerReportedTokens?: ProviderReportedTokens;
}

const TOKEN_COUNT_SELECTORS = [
  "ms-token-count .v3-token-count-value",
  "ms-token-count",
] as const;

export function parseAiStudioTokenCountText(rawText: string): number | undefined {
  if (!rawText) return undefined;
  const primarySegment = rawText.split("/")[0] ?? rawText;
  const match = primarySegment.match(/(\d[\d,\s]*(?:\.\d+)?)\s*([kKmM])?/);
  if (!match) return undefined;
  const numeric = Number(match[1].replace(/[,\s]/g, ""));
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  return Math.round(numeric * multiplier);
}

const INSERT_BUTTON_SELECTOR =
  'button[aria-label="Insert images, videos, audio, or files"]';
const UPLOAD_MENU_ITEM_SELECTOR = "button.mat-mdc-menu-item.upload-file-menu-item";
const OPEN_OPTIONS_BUTTON_SELECTOR = 'button[aria-label="Open options"]';
const CODE_COPY_BUTTON_SELECTOR =
  'ms-code-block button[aria-label="Copy code to clipboard"]';
const URL_CONTEXT_NUDGE_DISMISS_SELECTOR =
  '.urlcontext-nudge button[mattooltip="Dismiss"], .urlcontext-nudge button:has-text("close")';
const ANSWER_TURN_SELECTOR = `${AI_STUDIO_DOM_SELECTORS.modelTurnContainer}:not(:has(${AI_STUDIO_DOM_SELECTORS.thoughtPanel}))`;

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

export function isAiStudioGenerationRequest(url: string, method: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  return /GenerateContent|StreamGenerate/i.test(url);
}

const MAX_TRANSIENT_WEB_RETRIES = 2;

export function isTransientAiStudioWebError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!message) return false;
  if (/quota exceeded/i.test(message) || /AbortError/i.test(message)) {
    return false;
  }
  return /permission denied|failed to generate content|service unavailable/i.test(
    message,
  );
}

interface NetworkTracker {
  inFlight: Set<Request>;
  seenGenerationRequest: boolean;
  cleanup: () => void;
}

/**
 * Playwright CDP Worker cho Google AI Studio (`aistudio.google.com`):
 * - Gắn trực tiếp vào tab Launcher qua CDP (không mở Chrome ngoài).
 * - Theo dõi HTTP `GenerateContent` in-flight qua `page.on('request')` để miễn trừ
 *   idle timeout trong pha Thinking kéo dài nhiều phút.
 * - Giữ nhịp thao tác tự nhiên (BotGuard settle, delay trước khi fill và submit).
 */
export class AiStudioBrowserWorker extends BaseWebBrowserWorker<
  AiStudioBrowserRunOptions,
  AiStudioTurnResult,
  AiStudioResponseBaseline,
  AiStudioResponseObservation
> {
  protected readonly logPrefix = "ai-studio-worker";
  protected readonly defaultHardTimeoutMs = 20 * 60_000;
  protected readonly defaultIdleTimeoutMs = 180_000;
  protected readonly defaultPollingIntervalMs = 250;
  protected readonly defaultHeartbeatIntervalMs = 10_000;

  private readonly domObserver = new AiStudioDomObserver();
  private readonly capabilityPicker = new AiStudioCapabilityPicker();
  private readonly runtimeStates = new WeakMap<Page, AiStudioResponseRuntimeState>();
  private readonly retainedConversationIds = new WeakMap<Page, string>();
  private readonly botGuardSettledPages = new WeakSet<Page>();
  private readonly botGuardSettledAt = new WeakMap<Page, number>();
  private readonly networkTrackers = new WeakMap<Page, NetworkTracker>();
  private readonly domTokenSnapshots = new WeakMap<
    AiStudioBrowserRunOptions,
    { beforeContextTokens?: number; afterContextTokens?: number }
  >();

  public override async executeTurn(
    page: Page,
    options: AiStudioBrowserRunOptions,
  ): Promise<AiStudioTurnResult> {
    let currentOptions = options;
    for (let attemptIdx = 0; ; attemptIdx += 1) {
      try {
        return await super.executeTurn(page, currentOptions);
      } catch (error) {
        if (
          attemptIdx >= MAX_TRANSIENT_WEB_RETRIES ||
          options.signal?.aborted ||
          !isTransientAiStudioWebError(error)
        ) {
          throw error;
        }
        const errMsg = error instanceof Error ? error.message : String(error);
        console.warn(
          `[ai-studio-worker] Gặp lỗi tạm thời từ AI Studio (${errMsg}), tự phục hồi và thử lại (${attemptIdx + 1}/${MAX_TRANSIENT_WEB_RETRIES})...`,
        );
        await options.heartbeat?.().catch(() => { });
        await this.dismissErrorToasts(page);
        if (attemptIdx === 0) {
          await humanPause(page, 2_000, 3_000);
        } else {
          await humanPause(page, 3_500, 4_800);
        }
        if (options.signal?.aborted) throw error;

        const currentUrl = typeof page.url === "function" ? page.url() : "";
        const liveConversationId = parseAiStudioConversationId(currentUrl);
        this.botGuardSettledPages.delete(page);
        this.botGuardSettledAt.delete(page);
        this.capabilityPicker.clearCache(page);
        if (liveConversationId) {
          await page
            .reload({ waitUntil: "domcontentloaded", timeout: 25_000 })
            .catch(() => { });
          if (!currentOptions.existingConversationId) {
            currentOptions = {
              ...currentOptions,
              existingConversationId: liveConversationId,
              launcherReused: true,
            };
          }
        } else {
          const targetNewUrl = buildAiStudioNewChatUrl(
            this.extractTargetModelSlug(currentOptions.modelSlug),
          );
          await page
            .goto(targetNewUrl, { waitUntil: "domcontentloaded", timeout: 25_000 })
            .catch(async () => {
              await page
                .reload({ waitUntil: "domcontentloaded", timeout: 25_000 })
                .catch(() => { });
            });
        }
      }
    }
  }

  private getVisibleComposerLocator(page: Page): Locator {
    const base = page.locator(AI_STUDIO_DOM_SELECTORS.composer);
    const maybeSubLocator = (
      base as unknown as { locator?: (sel: string) => Locator }
    ).locator;
    if (typeof maybeSubLocator === "function") {
      return maybeSubLocator.call(base, "visible=true").first();
    }
    return base.first();
  }

  private async waitForVisibleComposer(
    page: Page,
    timeoutMs = 20_000,
  ): Promise<void> {
    if (typeof (page as { locator?: unknown }).locator !== "function") {
      await page.waitForSelector(AI_STUDIO_DOM_SELECTORS.composer, {
        state: "visible",
        timeout: timeoutMs,
      });
      return;
    }
    const composer = this.getVisibleComposerLocator(page);
    try {
      await composer.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 12_000) });
      return;
    } catch {
      await page
        .evaluate(() => {
          window.dispatchEvent(new Event("resize"));
        })
        .catch(() => { });
      await this.dismissObstructingNudges(page);
      try {
        await composer.waitFor({ state: "visible", timeout: 3_000 });
        return;
      } catch {
        console.warn(
          "[ai-studio-worker] Ô nhập liệu AI Studio đang bị ẩn (hidden), thử tải lại trang để phục hồi layout...",
        );
        this.botGuardSettledPages.delete(page);
        this.botGuardSettledAt.delete(page);
        await page
          .reload({ waitUntil: "domcontentloaded", timeout: 25_000 })
          .catch(() => { });
        await this.dismissObstructingNudges(page);
        await composer.waitFor({ state: "visible", timeout: timeoutMs });
      }
    }
  }

  private async dismissErrorToasts(page: Page): Promise<void> {
    try {
      await page
        .evaluate(() => {
          const btns = document.querySelectorAll<HTMLElement>(
            'mat-snack-bar-container button, simple-snack-bar button, [role="alert"] button',
          );
          for (const btn of btns) {
            btn.click();
          }
        })
        .catch(() => { });
    } catch {
      // Non-fatal
    }
  }

  protected override async initializeTurnState(
    page: Page,
    _options: AiStudioBrowserRunOptions,
  ): Promise<void> {
    this.runtimeStates.set(page, this.domObserver.createRuntimeState());
    this.attachNetworkTracker(page);
  }

  protected override async cleanupTurnState(
    page: Page,
    _options: AiStudioBrowserRunOptions,
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
      cleanup: () => { },
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
    options: AiStudioBrowserRunOptions,
  ): Promise<void> {
    const initialUrl = page.url();
    const currentConversationId = parseAiStudioConversationId(initialUrl);

    if (options.existingConversationId) {
      if (currentConversationId && currentConversationId !== options.existingConversationId) {
        if (options.launcherReused) {
          throw new Error(
            `AI Studio retained conversation mismatch: expected ${options.existingConversationId}, current URL is ${initialUrl}`,
          );
        }
      }

      if (currentConversationId !== options.existingConversationId) {
        this.botGuardSettledPages.delete(page);
        this.botGuardSettledAt.delete(page);
        this.capabilityPicker.clearCache(page);
        await page.goto(buildAiStudioConversationUrl(options.existingConversationId), {
          waitUntil: "domcontentloaded",
          timeout: 25_000,
        });
      }

      await this.waitForVisibleComposer(page, 20_000);
      await page
        .waitForSelector(".chat-session-content ms-chat-turn", { timeout: 15_000 })
        .catch(() => { });
      this.retainedConversationIds.set(page, options.existingConversationId);
      return;
    }

    if (options.launcherReused && (currentConversationId || options.isNewConversation === false)) {
      if (currentConversationId) {
        this.retainedConversationIds.set(page, currentConversationId);
      }
      const onAiStudioChatPage =
        Boolean(currentConversationId) ||
        initialUrl.startsWith(`${AI_STUDIO_ORIGIN}/prompts/new_chat`);
      if (onAiStudioChatPage) {
        await this.waitForVisibleComposer(page, 20_000);
        return;
      }
    }

    const modelName = this.extractTargetModelSlug(options.modelSlug);
    const targetNewChatUrl = buildAiStudioNewChatUrl(modelName);
    const isOnNewChatUrl = initialUrl.startsWith(`${AI_STUDIO_ORIGIN}/prompts/new_chat`);
    if (isOnNewChatUrl) {
      await this.waitForVisibleComposer(page, 12_000).catch(() => { });
    }

    const isCleanBlankNewChat = isOnNewChatUrl
      ? await page
        .evaluate(
          ({ expectedModel }) => {
            const turns = document.querySelectorAll(".chat-session-content ms-chat-turn");
            if (turns.length > 0) return false;
            const composers = Array.from(
              document.querySelectorAll<HTMLTextAreaElement>(
                'textarea[aria-label="Enter a prompt"]',
              ),
            );
            const visibleComposer = composers.find((el) => {
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return (
                rect.width > 0 &&
                rect.height > 0 &&
                style.display !== "none" &&
                style.visibility !== "hidden"
              );
            });
            if (!visibleComposer) return false;
            try {
              const current = new URL(location.href);
              const modelParam = current.searchParams.get("model");
              if (expectedModel && modelParam && modelParam !== expectedModel) {
                return false;
              }
            } catch { }
            return true;
          },
          { expectedModel: modelName },
        )
        .catch(() => false)
      : false;

    if (!isCleanBlankNewChat || currentConversationId) {
      this.botGuardSettledPages.delete(page);
      this.botGuardSettledAt.delete(page);
      this.capabilityPicker.clearCache(page);
      await page.goto(targetNewChatUrl, {
        waitUntil: "domcontentloaded",
        timeout: 25_000,
      });
    }

    await this.waitForVisibleComposer(page, 20_000);
  }

  protected override async prepareProvider(
    page: Page,
    options: AiStudioBrowserRunOptions,
  ): Promise<void> {
    await this.waitForVisibleComposer(page, 15_000);
    await this.dismissObstructingNudges(page);

    const target = this.capabilityPicker.resolveTarget(
      options.modelSlug || "ai-studio/gemini-4-hydrogen",
      options.reasoning,
    );
    const capabilityResult = await this.capabilityPicker.ensureCapabilityDetailed(
      page,
      target,
    );
    if (!capabilityResult.modelSelected) {
      throw new Error(
        `[AI Studio] Không thể chuyển sang model '${target.displayName}' (${target.remoteModelId}) trên cuộc trò chuyện hiện tại: ${capabilityResult.reason || "không tìm thấy hoặc model bị giới hạn trên tài khoản này."}`,
      );
    }
    if (!capabilityResult.thinkingSelected) {
      console.warn(
        `[ai-studio-worker] Không thể chọn Thinking Level '${target.thinkingLevel}' cho '${target.modelSlug}' (giữ best-effort).`,
      );
    }

    await this.waitForComposerIdle(page);

    const lastSettledAt = this.botGuardSettledAt.get(page);
    if (!this.botGuardSettledPages.has(page)) {
      this.botGuardSettledPages.add(page);
      await waitForBotGuardReady(page, 2_800, 5_000).catch(() => {});
      await humanPause(page, 1_100, 1_600);
    } else if (lastSettledAt !== undefined && Date.now() - lastSettledAt >= 15_000) {
      // Đánh thức vòng paint & BotGuard sau khi tab nằm nền bị backgroundThrottling
      if (typeof page.evaluate === "function") {
        await page
          .evaluate(
            () =>
              new Promise<void>((resolve) => {
                if (typeof requestAnimationFrame === "function") {
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                } else {
                  setTimeout(resolve, 32);
                }
              }),
          )
          .catch(() => {});
      }
      await humanPause(page, 650, 1_100);
    }
    this.botGuardSettledAt.set(page, Date.now());
    await dismissAiStudioWelcomeDialogs(page);
    await humanPause(page, 350, 580);
  }

  /**
   * Đóng các hộp thoại chào mừng/điều khoản (`#g1-welcome-dialog`) và card/nudge nổi phía trên
   * ô nhập liệu (như "Enable URL Context") để tránh backdrop chặn thao tác click/fill/submit.
   */
  private async dismissObstructingNudges(page: Page): Promise<void> {
    try {
      await dismissAiStudioWelcomeDialogs(page);
      const dismissButton = page.locator(URL_CONTEXT_NUDGE_DISMISS_SELECTOR).first();
      let dismissedAny = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (!(await dismissButton.isVisible().catch(() => false))) {
          break;
        }
        await clickResilient(dismissButton, 1_500).catch(async () => {
          await dismissButton.click({ force: true, timeout: 1_500 }).catch(() => { });
        });
        dismissedAny = true;
        await page.waitForTimeout(150);
      }
      if (dismissedAny) {
        await humanPause(page, 80, 160);
      }
    } catch {
      // Bỏ qua nếu nudge không tồn tại hoặc đã tự biến mất
    }
  }

  protected override async captureResponseBaseline(
    page: Page,
    options: AiStudioBrowserRunOptions,
  ): Promise<AiStudioResponseBaseline> {
    const beforeContextTokens = await this.readDomTokenCount(page);
    this.domTokenSnapshots.set(options, { beforeContextTokens });
    return await this.domObserver.captureBaseline(page);
  }

  protected override async insertPrompt(
    page: Page,
    promptText: string,
    options: AiStudioBrowserRunOptions,
  ): Promise<void> {
    await this.dismissObstructingNudges(page);

    if (options.images && options.images.length > 0) {
      await this.attachImages(page, options.images.slice(0, 3), options.signal).catch(
        (error) => {
          console.warn("[ai-studio-worker] Lỗi khi đính kèm ảnh:", error);
        },
      );
    }

    const composer = this.getVisibleComposerLocator(page);
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    await composer.scrollIntoViewIfNeeded({ timeout: 1_500 }).catch(() => { });
    await moveMouseToLocator(page, composer);
    await composer.hover({ timeout: 1_000 }).catch(() => { });
    await humanPause(page, 180, 340);
    await composer.click({ timeout: 2_500 }).catch(() => { });
    // Nhịp nghỉ tự nhiên sau khi focus trước khi điền prompt
    await humanPause(page, 260, 460);

    const typedNaturally = await typeHumanPrompt(page, composer, promptText).catch(
      () => false,
    );
    if (!typedNaturally) {
      const fillTimeoutMs = promptText.length > 8_000 ? 4_000 : 8_000;
      await composer.fill(promptText, { force: true, timeout: fillTimeoutMs }).catch(() => { });
    }
    const currentValue = await composer.inputValue().catch(() => "");
    const minAcceptableLen =
      promptText.length > 0 ? Math.max(1, Math.floor(promptText.length * 0.9)) : 0;
    if (
      promptText.length > 0 &&
      (!currentValue || currentValue.length < minAcceptableLen)
    ) {
      if (typedNaturally) {
        const fillTimeoutMs = promptText.length > 8_000 ? 4_000 : 8_000;
        await composer.fill(promptText, { force: true, timeout: fillTimeoutMs }).catch(() => { });
      }
      const afterFill = typedNaturally ? await composer.inputValue().catch(() => "") : currentValue;
      if (!afterFill || afterFill.length < minAcceptableLen) {
        await page.evaluate(
        ({ selector, value }) => {
          const candidates = Array.from(
            document.querySelectorAll<HTMLTextAreaElement>(selector),
          );
          const el =
            candidates.find((node) => {
              const rect = node.getBoundingClientRect();
              const style = window.getComputedStyle(node);
              return (
                rect.width > 0 &&
                rect.height > 0 &&
                style.display !== "none" &&
                style.visibility !== "hidden"
              );
            }) ?? candidates[0];
          if (!el) return;
          el.scrollIntoView({ block: "center" });
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

      const verifiedValue = await composer.inputValue().catch(() => "");
      if (promptText.trim().length > 0 && verifiedValue.trim().length === 0) {
        throw new Error("[ai-studio-worker] Không thể điền nội dung vào ô nhập liệu AI Studio.");
      }
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
    options: AiStudioBrowserRunOptions,
  ): Promise<void> {
    const runBtn = page.locator(AI_STUDIO_DOM_SELECTORS.runOrStopButton).first();
    const composer = this.getVisibleComposerLocator(page);

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
        throw new DOMException("AI Studio turn aborted during submit", "AbortError");
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
            const txt = (
              btn.getAttribute("aria-label") ||
              btn.getAttribute("mattooltip") ||
              btn.textContent ||
              ""
            )
              .trim()
              .toLowerCase();
            return txt.includes("stop") || txt.includes("cancel");
          });
          const primaryBtn = document.querySelector<HTMLButtonElement>(btnSelector);
          const isDisabled = Boolean(
            primaryBtn?.disabled || primaryBtn?.getAttribute("aria-disabled") === "true",
          );
          const liveText = Array.from(document.querySelectorAll<HTMLElement>(liveSelector))
            .map((el) => (el.textContent || el.getAttribute("aria-label") || "").trim())
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
            await composer.press("Meta+Enter").catch(() => { });
          });
        } else if (attempt === 1) {
          await this.dismissObstructingNudges(page);
          await humanPause(page, 220, 380);
          await composer.press("Meta+Enter").catch(async () => {
            await runBtn.click({ force: true, timeout: 1_500 }).catch(() => { });
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
        "[ai-studio-worker] Không thể xác nhận prompt đã được gửi trên AI Studio.",
      );
    }

    // Cuộn xuống đáy 1 lần sau khi bấm Run để AI Studio giữ auto-scroll cho turn mới
    await this.scrollChatToBottom(page);
  }

  protected override shouldDelayFirstObservation(): boolean {
    return true;
  }

  protected override shouldEmitObservationDelta(
    _observation: AiStudioResponseObservation,
    options: AiStudioBrowserRunOptions,
  ): boolean {
    return options.streamIncremental === true;
  }

  protected override resolveNextPollDelayMs(
    observation: AiStudioResponseObservation,
    defaultDelayMs: number,
    options: AiStudioBrowserRunOptions,
  ): number {
    if (options.pollingIntervalMs === undefined && observation.isGenerating) {
      return Math.max(defaultDelayMs, 450);
    }
    return defaultDelayMs;
  }

  protected override shouldEnforceIdleTimeout(
    observation: AiStudioResponseObservation,
  ): boolean {
    return !observation.isGenerating && !observation.networkInFlight;
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
    options: AiStudioBrowserRunOptions,
  ): Promise<void> {
    const state = this.getRuntimeState(page);
    state.attempts += 1;
    const now = Date.now();
    const captureFullWhileGenerating =
      options?.streamIncremental === true &&
      now - state.lastStreamSnapshotAt >= 650;
    const status = await this.domObserver.captureStatus(page, baseline, {
      captureFullWhileGenerating,
    });
    if (captureFullWhileGenerating && status.isGenerating && status.hasNewAnswerTurn) {
      state.lastStreamSnapshotAt = now;
    }
    state.pendingStatus = status;

    const needsVirtualScrollNudge =
      !status.hasNewAnswerTurn ||
      !status.hasContent ||
      (!status.isGenerating && !status.hasTurnFooter);
    if (needsVirtualScrollNudge && state.attempts % 6 === 0) {
      await this.scrollChatToBottom(page);
    }
  }

  private async scrollChatToBottom(page: Page): Promise<void> {
    try {
      await page
        .evaluate(() => {
          const chatRoot = document.querySelector<HTMLElement>(".chat-session-content");
          const candidates: Array<HTMLElement | null> = [];
          let cur: HTMLElement | null = chatRoot;
          while (cur) {
            candidates.push(cur);
            cur = cur.parentElement;
          }
          candidates.push(document.scrollingElement as HTMLElement | null);

          for (const el of candidates) {
            if (!el) continue;
            const style = window.getComputedStyle(el);
            const isScrollableY =
              el === document.scrollingElement ||
              /(auto|scroll|overlay)/i.test(style.overflowY);
            if (isScrollableY && el.scrollHeight - el.clientHeight > 8) {
              el.scrollTop = el.scrollHeight;
              return;
            }
          }

          const lastTurn = chatRoot?.querySelector<HTMLElement>("ms-chat-turn:last-of-type");
          lastTurn?.scrollIntoView({ block: "end" });
        })
        .catch(() => {});
    } catch {
      // Best-effort virtual-scroll nudge
    }
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
      AiStudioResponseObservation
    >,
    options: AiStudioBrowserRunOptions,
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
      `[ai-studio-worker] [extract] source=${source} len=${rawResponse.length} copiedLen=${copiedMarkdown?.length ?? 0} domLen=${domMarkdown.length} attempts=${state?.attempts ?? 0}`,
    );

    if (!rawResponse) {
      throw new Error(
        "[AI Studio] Không nhận được nội dung phản hồi từ Gemini 4 Hydrogen.",
      );
    }

    if (options.signal?.aborted) {
      throw new DOMException("AI Studio turn aborted", "AbortError");
    }

    const tokenSnapshot = this.domTokenSnapshots.get(options) ?? {};
    const beforeTokens = tokenSnapshot.beforeContextTokens;
    let afterTokens = await this.readDomTokenCount(page);
    for (let retry = 0; retry < 2; retry += 1) {
      if (
        afterTokens !== undefined &&
        afterTokens > 0 &&
        (beforeTokens === undefined || afterTokens > beforeTokens)
      ) {
        break;
      }
      await page.waitForTimeout(250);
      afterTokens = await this.readDomTokenCount(page);
    }
    this.domTokenSnapshots.set(options, {
      ...tokenSnapshot,
      afterContextTokens: afterTokens,
    });

    return rawResponse;
  }

  protected override createResult(
    result: BaseBrowserTurnResult,
    options?: AiStudioBrowserRunOptions,
  ): AiStudioTurnResult {
    const tokenSnapshot = options ? this.domTokenSnapshots.get(options) : undefined;
    const afterTokens = tokenSnapshot?.afterContextTokens;
    const beforeTokens = tokenSnapshot?.beforeContextTokens;
    if (afterTokens !== undefined && afterTokens > 0) {
      const turnDeltaTokens =
        beforeTokens !== undefined && afterTokens > beforeTokens
          ? afterTokens - beforeTokens
          : beforeTokens === undefined
            ? afterTokens
            : undefined;
      return {
        ...result,
        providerReportedTokens: {
          ...(beforeTokens !== undefined ? { beforeContextTokens: beforeTokens } : {}),
          contextTokens: afterTokens,
          ...(turnDeltaTokens !== undefined ? { turnDeltaTokens } : {}),
          source: "ai-studio-dom",
        },
      };
    }
    return result as AiStudioTurnResult;
  }

  private async readDomTokenCount(page: Page): Promise<number | undefined> {
    try {
      for (const selector of TOKEN_COUNT_SELECTORS) {
        const text = await page
          .locator(selector)
          .first()
          .innerText({ timeout: 500 })
          .catch(() => "");
        const parsed = parseAiStudioTokenCountText(text);
        if (parsed !== undefined) {
          return parsed;
        }
      }
    } catch {
      // Non-fatal: DOM token counter is best-effort
    }
    return undefined;
  }

  private async tryExtractMarkdownViaClipboard(
    page: Page,
    baselineAnswerCount: number,
  ): Promise<string | null> {
    try {
      await installInPageClipboardHook(page, {
        resultKey: "__aistudio_last_copied_markdown",
        suppressOsClipboardNow: true,
      });

      const answerTurns = page.locator(ANSWER_TURN_SELECTOR);
      const count = await answerTurns.count();
      if (count <= baselineAnswerCount) return null;

      const targetTurn = answerTurns.nth(count - 1);
      await targetTurn.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => { });
      await targetTurn.hover({ position: { x: 24, y: 24 }, timeout: 2_000 }).catch(() => { });

      const openOptionsBtn = targetTurn.locator(OPEN_OPTIONS_BUTTON_SELECTOR).first();
      if (await openOptionsBtn.isVisible().catch(() => false)) {
        await openOptionsBtn.click({ timeout: 2_000 }).catch(() => { });
        const menuItems = page.locator('[role="menuitem"], button.mat-mdc-menu-item');
        await menuItems.first().waitFor({ state: "visible", timeout: 2_000 }).catch(() => { });
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
          await menuItems.nth(idx).click({ timeout: 2_000 }).catch(() => { });
          const copied = await this.readCapturedClipboard(page);
          if (copied) return copied;
        } else {
          await page.keyboard.press("Escape").catch(() => { });
        }
      }

      const codeBlocksCount = await targetTurn.locator("ms-code-block").count();
      if (codeBlocksCount === 1) {
        const copyBtn = targetTurn.locator(CODE_COPY_BUTTON_SELECTOR).first();
        if (await copyBtn.isVisible().catch(() => false)) {
          await copyBtn.click({ timeout: 2_000 }).catch(() => { });
          const copied = await this.readCapturedClipboard(page);
          if (copied) return normalizeCopiedAiStudioCodeSnippet(copied);
        }
      }
      return null;
    } catch {
      return null;
    } finally {
      await releaseOsClipboardSuppression(page);
    }
  }

  private async readCapturedClipboard(page: Page): Promise<string | null> {
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      await page.waitForTimeout(100);
      const copied = await page
        .evaluate(() => {
          const win = window as unknown as Record<string, unknown>;
          if (
            typeof win.__aistudio_last_copied_markdown === "string" &&
            win.__aistudio_last_copied_markdown.trim().length > 0
          ) {
            return win.__aistudio_last_copied_markdown.trim();
          }
          return null;
        })
        .catch(() => null);
      if (copied) return copied;
    }
    return null;
  }

  protected override async resolveConversationId(
    page: Page,
    options: AiStudioBrowserRunOptions,
  ): Promise<string | undefined> {
    const currentUrl = page.url();
    const immediateId = parseAiStudioConversationId(currentUrl);
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
      (await waitForAiStudioConversationId(
        page,
        AI_STUDIO_CONVERSATION_ID_WAIT_TIMEOUT_MS,
        options.signal,
      ));

    if (resolved) {
      this.retainedConversationIds.set(page, resolved);
    } else {
      console.warn(
        "[ai-studio-worker] AI Studio did not expose /prompts/{id} URL yet; keeping launcher tab retained in-session.",
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
      if ((await btn.count().catch(() => 0)) === 0) continue;
      const label = (
        (await btn.getAttribute("aria-label", { timeout: 600 }).catch(() => "")) ||
        (await btn.textContent({ timeout: 600 }).catch(() => "")) ||
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
    return modelId.replace(/^ai-studio\//i, "").trim() || AI_STUDIO_DEFAULT_MODEL_SLUG;
  }

  private async waitForComposerIdle(page: Page): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const btnText = (
        (await page
          .locator(AI_STUDIO_DOM_SELECTORS.runOrStopButton)
          .first()
          .innerText({ timeout: 600 })
          .catch(() => "")) || ""
      )
        .trim()
        .toLowerCase();
      if (!btnText.includes("stop") && !btnText.includes("cancel")) return;
      await page.waitForTimeout(250);
    }
  }
}
