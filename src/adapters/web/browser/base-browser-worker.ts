import type { Page } from "playwright-core";

export interface BaseBrowserRunOptions {
  prompt: string;
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
  heartbeat?: () => Promise<void>;
  conversationId?: string;
  isNewConversation?: boolean;
  retain?: boolean;
  hardTimeoutMs?: number;
  idleTimeoutMs?: number;
  pollingIntervalMs?: number;
  heartbeatIntervalMs?: number;
}

export interface BaseBrowserTurnResult {
  rawResponse: string;
  conversationId?: string;
}

export interface BrowserObservation {
  text: string;
  isGenerating: boolean;
  isCompleted: boolean;
  /**
   * Khóa semantic đại diện cho tiến triển của provider. Provider nên đưa vào
   * đây response identity, generation state, phase và text revision nếu có.
   */
  activityKey?: string;
}

export interface BrowserCompletionContext<
  TBaseline,
  TObservation extends BrowserObservation,
> {
  baseline: TBaseline;
  observation: TObservation;
}

export class BrowserHardTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Browser turn exceeded hard deadline (${timeoutMs}ms)`);
    this.name = "BrowserHardTimeoutError";
  }
}

export class BrowserIdleTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Browser turn had no observable activity for ${timeoutMs}ms`);
    this.name = "BrowserIdleTimeoutError";
  }
}

/**
 * Template Method cho lifecycle của browser worker.
 *
 * Base class chỉ sở hữu thứ tự thực thi, abort, heartbeat và deadline.
 * Mọi quyết định liên quan DOM, selector, capability, response identity,
 * clipboard và conversation ID vẫn thuộc provider worker.
 */
export abstract class BaseWebBrowserWorker<
  TOptions extends BaseBrowserRunOptions,
  TResult extends BaseBrowserTurnResult,
  TBaseline,
  TObservation extends BrowserObservation = BrowserObservation,
  TSurface = Page,
> {
  protected readonly defaultHardTimeoutMs = 15 * 60_000;
  protected readonly defaultIdleTimeoutMs = 2 * 60_000;
  protected readonly defaultPollingIntervalMs = 250;
  protected readonly defaultHeartbeatIntervalMs = 10_000;
  private readonly heartbeatStates = new WeakMap<
    BaseBrowserRunOptions,
    { lastSentAt: number; inFlight: boolean }
  >();

  protected abstract readonly logPrefix: string;

  public async executeTurn(
    page: TSurface,
    options: TOptions,
  ): Promise<TResult> {
    this.throwIfAborted(options.signal, "before start");

    await this.initializeTurnState(page, options);
    const stopHeartbeatLoop = this.startHeartbeatLoop(options);
    try {
      await this.navigate(page, options);
      await this.prepareProvider(page, options);
      await this.sendTrackedHeartbeat(options);

      const baseline = await this.captureResponseBaseline(page, options);

      await this.insertPrompt(page, options.prompt, options);
      await this.submitPrompt(page, options);

      const observation = await this.waitForCompletion(
        page,
        baseline,
        options,
      );
      const rawResponse = await this.extractCompletedResponse(
        page,
        {
          baseline,
          observation,
        },
        options,
      );
      const conversationId = await this.resolveConversationId(page, options);

      return this.createResult(
        {
          rawResponse: rawResponse || observation.text,
          ...(conversationId ? { conversationId } : {}),
        },
        options,
      );
    } catch (error) {
      await this.handleExecutionError(error, page, options);
      throw error;
    } finally {
      stopHeartbeatLoop();
      await this.cleanupTurnState(page, options);
    }
  }

  protected async initializeTurnState(
    _page: TSurface,
    _options: TOptions,
  ): Promise<void> {}

  protected async cleanupTurnState(
    _page: TSurface,
    _options: TOptions,
  ): Promise<void> {}

  protected async handleExecutionError(
    _error: unknown,
    _page: TSurface,
    _options: TOptions,
  ): Promise<void> {}

  protected shouldStopPolling(
    _observation: TObservation,
    _options: TOptions,
  ): boolean {
    return false;
  }

  protected shouldEmitObservationDelta(
    _observation: TObservation,
    _options: TOptions,
  ): boolean {
    return true;
  }

  protected shouldDelayFirstObservation(
    _options: TOptions,
  ): boolean {
    return false;
  }

  /**
   * Cho phép provider điều chỉnh nhịp polling giữa các chu kỳ (vd: giãn nhịp
   * khi model vẫn đang generating để giảm chi phí CDP/DOM).
   */
  protected resolveNextPollDelayMs(
    _observation: TObservation,
    defaultDelayMs: number,
    _options: TOptions,
  ): number {
    return defaultDelayMs;
  }

  protected async beforeObserveResponse(
    _page: TSurface,
    _baseline: TBaseline,
    _options: TOptions,
  ): Promise<void> {}

  /**
   * Quyết định có áp dụng idle timeout ở observation hiện tại hay không.
   * Provider có thể tạm hoãn idle timeout trong lúc model đang suy nghĩ/sinh nội dung.
   */
  protected shouldEnforceIdleTimeout(
    _observation: TObservation,
    _options: TOptions,
  ): boolean {
    return true;
  }

  /**
   * Cho phép provider xử lý hoặc cứu hộ observation cuối cùng khi hết thời gian chờ.
   * Trả về undefined để ném lỗi timeout chuẩn mặc định.
   */
  protected onWaitTimeout(
    _error: BrowserHardTimeoutError | BrowserIdleTimeoutError,
    _lastObservation: TObservation | undefined,
    _options: TOptions,
  ): TObservation | undefined {
    return undefined;
  }

  protected abstract navigate(
    page: TSurface,
    options: TOptions,
  ): Promise<void>;

  protected async prepareProvider(
    _page: TSurface,
    _options: TOptions,
  ): Promise<void> {}

  protected abstract captureResponseBaseline(
    page: TSurface,
    options: TOptions,
  ): Promise<TBaseline>;

  protected abstract insertPrompt(
    page: TSurface,
    prompt: string,
    options: TOptions,
  ): Promise<void>;

  protected abstract submitPrompt(
    page: TSurface,
    options: TOptions,
  ): Promise<void>;

  protected abstract observeResponse(
    page: TSurface,
    baseline: TBaseline,
    options: TOptions,
  ): Promise<TObservation>;

  protected abstract extractCompletedResponse(
    page: TSurface,
    context: BrowserCompletionContext<TBaseline, TObservation>,
    options: TOptions,
  ): Promise<string>;

  protected abstract resolveConversationId(
    page: TSurface,
    options: TOptions,
  ): Promise<string | undefined>;

  protected abstract stopGeneration(page: TSurface): Promise<boolean>;

  protected createResult(
    result: BaseBrowserTurnResult,
    _options?: TOptions,
  ): TResult {
    return result as TResult;
  }

  protected async sleepSurface(
    surface: TSurface,
    ms: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const candidate = surface as unknown as {
      waitForTimeout?: (timeoutMs: number) => Promise<void>;
      sleep?: (timeoutMs: number, abortSignal?: AbortSignal) => Promise<void>;
    };
    if (typeof candidate?.waitForTimeout === "function") {
      await candidate.waitForTimeout(ms);
      return;
    }
    if (typeof candidate?.sleep === "function") {
      await candidate.sleep(ms, signal);
      return;
    }
    await new Promise<void>(resolve => setTimeout(resolve, ms));
  }

  /**
   * Shared polling lifecycle cho provider worker.
   *
   * `protected` cho phép các provider phức tạp như M365 chuyển đổi theo từng
   * slice: provider vẫn có thể giữ orchestration đặc thù trong thời gian tạm
   * thời nhưng dùng chung heartbeat, abort, hard deadline và idle deadline.
   */
  protected async waitForCompletion(
    page: TSurface,
    baseline: TBaseline,
    options: TOptions,
  ): Promise<TObservation> {
    const hardTimeoutMs =
      options.hardTimeoutMs ?? this.defaultHardTimeoutMs;
    const idleTimeoutMs =
      options.idleTimeoutMs ?? this.defaultIdleTimeoutMs;
    const pollingIntervalMs =
      options.pollingIntervalMs ?? this.defaultPollingIntervalMs;
    const heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? this.defaultHeartbeatIntervalMs;

    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    let lastActivityKey: string | undefined;
    let lastRenderedText = "";
    let lastObservation: TObservation | undefined;
    let isFirstObservation = true;
    const heartbeatState = this.getOrCreateHeartbeatState(
      options,
      startedAt - heartbeatIntervalMs,
    );

    while (true) {
      if (options.signal?.aborted) {
        await this.stopGeneration(page).catch(() => false);
        this.throwIfAborted(options.signal, "during execution");
      }

      const now = Date.now();
      if (
        options.heartbeat &&
        !heartbeatState.inFlight &&
        now - heartbeatState.lastSentAt >= heartbeatIntervalMs
      ) {
        await this.sendTrackedHeartbeat(options);
      }

      if (now - startedAt >= hardTimeoutMs) {
        await this.stopGeneration(page).catch(() => false);
        const hardTimeoutError = new BrowserHardTimeoutError(hardTimeoutMs);
        const fallback = this.onWaitTimeout(
          hardTimeoutError,
          lastObservation,
          options,
        );
        if (fallback) return fallback;
        throw hardTimeoutError;
      }

      if (
        isFirstObservation &&
        this.shouldDelayFirstObservation(options)
      ) {
        await this.sleepSurface(page, pollingIntervalMs, options.signal);
      }
      isFirstObservation = false;

      await this.beforeObserveResponse(page, baseline, options);
      const observation = await this.observeResponse(
        page,
        baseline,
        options,
      );
      lastObservation = observation;
      const activityKey =
        observation.activityKey ??
        `${observation.isGenerating}:${observation.text}`;

      if (activityKey !== lastActivityKey || !this.shouldEnforceIdleTimeout(observation, options)) {
        lastActivityKey = activityKey;
        lastActivityAt = now;
      }

      if (observation.text !== lastRenderedText) {
        const delta = observation.text.startsWith(lastRenderedText)
          ? observation.text.slice(lastRenderedText.length)
          : "";
        lastRenderedText = observation.text;
        if (
          delta &&
          this.shouldEmitObservationDelta(observation, options)
        ) {
          options.onChunk?.(delta);
        }
      }

      if (observation.isCompleted) return observation;
      if (this.shouldStopPolling(observation, options)) {
        return observation;
      }

      if (
        this.shouldEnforceIdleTimeout(observation, options) &&
        now - lastActivityAt >= idleTimeoutMs
      ) {
        await this.stopGeneration(page).catch(() => false);
        const idleTimeoutError = new BrowserIdleTimeoutError(idleTimeoutMs);
        const fallback = this.onWaitTimeout(
          idleTimeoutError,
          lastObservation,
          options,
        );
        if (fallback) return fallback;
        throw idleTimeoutError;
      }

      const nextPollDelayMs = this.resolveNextPollDelayMs(
        observation,
        pollingIntervalMs,
        options,
      );
      await this.sleepSurface(page, nextPollDelayMs, options.signal);
    }
  }

  private getOrCreateHeartbeatState(
    options: TOptions,
    initialLastSentAt = 0,
  ): { lastSentAt: number; inFlight: boolean } {
    let state = this.heartbeatStates.get(options);
    if (!state) {
      state = { lastSentAt: initialLastSentAt, inFlight: false };
      this.heartbeatStates.set(options, state);
    }
    return state;
  }

  private startHeartbeatLoop(options: TOptions): () => void {
    if (!options.heartbeat) return () => {};
    const heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? this.defaultHeartbeatIntervalMs;
    if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
      return () => {};
    }

    const state = this.getOrCreateHeartbeatState(options, Date.now());
    const tickMs = Math.max(10, Math.min(Math.floor(heartbeatIntervalMs / 2), 2_500));
    const timer = setInterval(() => {
      if (options.signal?.aborted || state.inFlight) return;
      if (Date.now() - state.lastSentAt < heartbeatIntervalMs) return;
      void this.sendTrackedHeartbeat(options);
    }, tickMs);
    timer.unref?.();

    const stop = () => {
      clearInterval(timer);
      options.signal?.removeEventListener("abort", stop);
    };
    options.signal?.addEventListener("abort", stop, { once: true });
    return stop;
  }

  private async sendTrackedHeartbeat(options: TOptions): Promise<void> {
    if (!options.heartbeat) return;
    const state = this.getOrCreateHeartbeatState(options, 0);
    if (state.inFlight) return;
    state.inFlight = true;
    state.lastSentAt = Date.now();
    try {
      await this.sendHeartbeat(options);
    } finally {
      state.lastSentAt = Date.now();
      state.inFlight = false;
    }
  }

  /**
   * Gửi heartbeat best-effort tới Launcher để giữ lease tab sống trong các pha chờ.
   */
  protected async sendHeartbeat(options: TOptions): Promise<void> {
    if (!options.heartbeat) return;
    await options.heartbeat().catch(error => {
      console.warn(
        `[${this.logPrefix}] Không thể gửi heartbeat:`,
        error,
      );
    });
  }

  private throwIfAborted(
    signal: AbortSignal | undefined,
    phase: string,
  ): void {
    if (!signal?.aborted) return;
    throw new DOMException(
      `${this.logPrefix} turn aborted ${phase}`,
      "AbortError",
    );
  }
}
