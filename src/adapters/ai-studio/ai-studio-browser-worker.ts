import {
  BaseWebBrowserWorker,
  BrowserHardTimeoutError,
  BrowserIdleTimeoutError,
  type BaseBrowserRunOptions,
  type BrowserCompletionContext,
} from "../web/browser";
import type { ElectronSurfaceClient } from "../web/electron-surface-client";
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
  AiStudioResponseObservation,
  ElectronSurfaceClient
> {
  protected readonly logPrefix = "ai-studio-worker";
  protected readonly defaultHardTimeoutMs = 20 * 60_000;
  protected readonly defaultIdleTimeoutMs = 45_000;
  protected readonly defaultPollingIntervalMs = 250;
  protected readonly defaultHeartbeatIntervalMs = 10_000;

  private readonly domObserver = new AiStudioDomObserver();
  private readonly clipboardSalvage = new AiStudioClipboardSalvage();
  private readonly runtimeStates = new WeakMap<ElectronSurfaceClient, AiStudioResponseRuntimeState>();
  private readonly retainedConversationIds = new WeakMap<ElectronSurfaceClient, string>();
  private readonly botGuardSettledClients = new WeakSet<ElectronSurfaceClient>();

  protected override async initializeTurnState(
    client: ElectronSurfaceClient,
    _options: AiStudioBrowserRunOptions,
  ): Promise<void> {
    this.runtimeStates.set(client, this.domObserver.createRuntimeState());
  }

  protected override async cleanupTurnState(
    client: ElectronSurfaceClient,
    _options: AiStudioBrowserRunOptions,
  ): Promise<void> {
    this.runtimeStates.delete(client);
  }

  protected override async navigate(
    client: ElectronSurfaceClient,
    options: AiStudioBrowserRunOptions,
  ): Promise<void> {
    const initialUrl = await client.getUrl(options.signal);
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
        await client.navigate(buildAiStudioConversationUrl(options.existingConversationId), {
          timeoutMs: 25_000,
          signal: options.signal,
        });
      }

      await client.waitForSelector(AI_STUDIO_DOM_SELECTORS.composer, {
        timeoutMs: 20_000,
        signal: options.signal,
      });
      await client
        .waitForSelector(".chat-session-content ms-chat-turn", {
          timeoutMs: 15_000,
          signal: options.signal,
        })
        .catch(() => {});
      this.retainedConversationIds.set(client, options.existingConversationId);
      return;
    }

    if (options.launcherReused && currentConversationId) {
      throw new Error(
        "Launcher reused an unbound AI Studio surface that already contains a conversation",
      );
    }

    const modelName = this.extractTargetModelSlug(options.modelSlug);
    const targetNewChatUrl = buildAiStudioNewChatUrl(modelName);
    const isOnNewChatUrl = initialUrl.startsWith(`${AI_STUDIO_ORIGIN}/prompts/new_chat`);
    if (isOnNewChatUrl) {
      // Đợi composer hiện trước khi kiểm tra trạng thái trang mới để tránh reload thừa.
      await client
        .waitForSelector(AI_STUDIO_DOM_SELECTORS.composer, {
          timeoutMs: 20_000,
          signal: options.signal,
        })
        .catch(() => {});
    }
    const isCleanBlankNewChat = isOnNewChatUrl
      ? await client
          .call<{ clean: boolean }>(
            "aiStudioCheckCleanNewChat",
            { targetModel: modelName },
            { signal: options.signal },
          )
          .then(res => res.clean)
          .catch(() => false)
      : false;

    if (!isCleanBlankNewChat || currentConversationId) {
      await client.navigate(targetNewChatUrl, {
        timeoutMs: 25_000,
        signal: options.signal,
      });
    }

    await client.waitForSelector(AI_STUDIO_DOM_SELECTORS.composer, {
      timeoutMs: 20_000,
      signal: options.signal,
    });
  }

  protected override async prepareProvider(
    client: ElectronSurfaceClient,
    options: AiStudioBrowserRunOptions,
  ): Promise<void> {
    await client.waitForSelector(AI_STUDIO_DOM_SELECTORS.composer, {
      timeoutMs: 15_000,
      signal: options.signal,
    });

    const targetLevel = resolveAiStudioThinkingLevel(
      options.modelSlug || "ai-studio/gemini-4-hydrogen",
      options.reasoning,
    );
    await ensureAiStudioThinkingLevel(client, targetLevel).catch(error => {
      console.warn(
        `[ai-studio-worker] Không thể chọn Thinking Level '${targetLevel}':`,
        error,
      );
    });

    await this.waitForComposerIdle(client, options.signal);

    if (!options.launcherReused && !this.botGuardSettledClients.has(client)) {
      this.botGuardSettledClients.add(client);
      await client
        .call(
          "aiStudioWaitForBotGuardReady",
          { minPageAgeMs: 1_200, maxWaitMs: 1_500 },
          { signal: options.signal },
        )
        .catch(() => {});
    }
  }

  protected override async captureResponseBaseline(
    client: ElectronSurfaceClient,
  ): Promise<AiStudioResponseBaseline> {
    return await this.domObserver.captureBaseline(client);
  }

  protected override async insertPrompt(
    client: ElectronSurfaceClient,
    promptText: string,
    options: AiStudioBrowserRunOptions,
  ): Promise<void> {
    if (options.images && options.images.length > 0) {
      const payloads = aiStudioImageFilePayloads(options.images);
      await attachAiStudioFiles(client, payloads, { signal: options.signal }).catch(error => {
        console.warn("[ai-studio-worker] Lỗi khi đính kèm ảnh vào AI Studio:", error);
      });
    }

    await client.waitForSelector(AI_STUDIO_DOM_SELECTORS.composer, {
      timeoutMs: 10_000,
      signal: options.signal,
    });
    await client.fillTextarea(AI_STUDIO_DOM_SELECTORS.composer, promptText, {
      signal: options.signal,
    });
    await client.sleep(250, options.signal);
  }

  protected override async submitPrompt(
    client: ElectronSurfaceClient,
    options: AiStudioBrowserRunOptions,
  ): Promise<void> {
    let submitted = false;
    let emptyEditorWaitCycles = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (options.signal?.aborted) {
        throw new DOMException("AI Studio turn aborted during submit", "AbortError");
      }

      const status = await client.call<{
        isStop: boolean;
        isRunningLive: boolean;
        isDisabled: boolean;
        editorLength: number;
      }>(
        "aiStudioCheckSubmitStatus",
        {
          btnSelector: AI_STUDIO_DOM_SELECTORS.runOrStopButton,
          liveSelector: AI_STUDIO_DOM_SELECTORS.liveStatus,
          composerSelector: AI_STUDIO_DOM_SELECTORS.composer,
        },
        { signal: options.signal },
      );

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
        await client.sleep(250, options.signal);
        continue;
      }

      if (!status.isDisabled) {
        await client
          .clickSelector(AI_STUDIO_DOM_SELECTORS.runOrStopButton, {
            trusted: attempt < 2,
            signal: options.signal,
          })
          .catch(async () => {
            await client.pressKey("Meta+Enter", options.signal).catch(() => {});
          });
      }

      await client.sleep(250, options.signal);
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
    client: ElectronSurfaceClient,
    baseline: AiStudioResponseBaseline,
  ): Promise<void> {
    const state = this.getRuntimeState(client);
    state.attempts += 1;
    state.pendingStatus = await this.domObserver.captureStatus(client, baseline);
  }

  protected override async observeResponse(
    client: ElectronSurfaceClient,
  ): Promise<AiStudioResponseObservation> {
    const state = this.getRuntimeState(client);
    const pending = state.pendingStatus;
    if (!pending) {
      throw new Error("AI Studio observeResponse missing captured status");
    }
    state.pendingStatus = null;
    return this.domObserver.applyStatus(state, pending);
  }

  protected override async extractCompletedResponse(
    client: ElectronSurfaceClient,
    context: BrowserCompletionContext<AiStudioResponseBaseline, AiStudioResponseObservation>,
    options: AiStudioBrowserRunOptions,
  ): Promise<string> {
    const copiedMarkdown = await this.clipboardSalvage.tryExtractMarkdown(
      client,
      context.baseline.answerCount,
    );
    const domMarkdown = context.observation.text.trim();
    const { rawResponse, source } = selectPreferredAiStudioResponse(copiedMarkdown, domMarkdown);

    const state = this.runtimeStates.get(client);
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
    client: ElectronSurfaceClient,
    options: AiStudioBrowserRunOptions,
  ): Promise<string | undefined> {
    const currentUrl = await client.getUrl(options.signal).catch(() => "");
    if (options.retain === false) {
      return (
        parseAiStudioConversationId(currentUrl) ||
        this.retainedConversationIds.get(client) ||
        options.existingConversationId
      );
    }

    const conversationId =
      parseAiStudioConversationId(currentUrl) ||
      (await waitForAiStudioConversationId(client, 6_000)) ||
      this.retainedConversationIds.get(client) ||
      options.existingConversationId;

    if (!conversationId) {
      // Khi GenerateTitle/CreatePrompt không trả về URL /prompts/{id}, giữ kết quả đã generate thay vì vứt bỏ turn.
      console.warn(
        "[ai-studio-worker] AI Studio did not expose a persistent /prompts/{id} URL after completing the turn; keeping generated output without retaining conversation.",
      );
      return undefined;
    }

    return conversationId;
  }

  protected override async stopGeneration(client: ElectronSurfaceClient): Promise<boolean> {
    return await client
      .call<{ stopped: boolean }>("aiStudioStopGeneration", {
        selector: AI_STUDIO_DOM_SELECTORS.runOrStopButton,
      })
      .then(res => res.stopped)
      .catch(() => false);
  }

  private getRuntimeState(client: ElectronSurfaceClient): AiStudioResponseRuntimeState {
    let state = this.runtimeStates.get(client);
    if (!state) {
      state = this.domObserver.createRuntimeState();
      this.runtimeStates.set(client, state);
    }
    return state;
  }

  private extractTargetModelSlug(modelId?: string): string {
    if (!modelId) return AI_STUDIO_DEFAULT_MODEL_SLUG;
    const prefix = "ai-studio/";
    return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
  }

  private async waitForComposerIdle(
    client: ElectronSurfaceClient,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const res = await client
        .call<{ idle: boolean }>(
          "aiStudioCheckComposerIdle",
          { selector: AI_STUDIO_DOM_SELECTORS.runOrStopButton },
          { signal },
        )
        .catch(() => ({ idle: true }));
      if (res.idle) return;
      await client.sleep(250, signal);
    }
  }
}

