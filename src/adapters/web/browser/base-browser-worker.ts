import type { Page } from "playwright-core";

export interface BaseBrowserRunOptions {
  prompt: string;
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
  heartbeat?: () => Promise<void>;
  conversationId?: string;
  isNewConversation?: boolean;
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
> {
  protected readonly defaultHardTimeoutMs = 15 * 60_000;
  protected readonly defaultIdleTimeoutMs = 2 * 60_000;
  protected readonly defaultPollingIntervalMs = 250;
  protected readonly defaultHeartbeatIntervalMs = 10_000;

  protected abstract readonly logPrefix: string;

  public async executeTurn(
    page: Page,
    options: TOptions,
  ): Promise<TResult> {
    this.throwIfAborted(options.signal, "before start");

    await this.navigate(page, options);
    await this.prepareProvider(page, options);

    const baseline = await this.captureResponseBaseline(page, options);

    await this.insertPrompt(page, options.prompt, options);
    await this.submitPrompt(page, options);

    const observation = await this.waitForCompletion(
      page,
      baseline,
      options,
    );
    const rawResponse = await this.extractCompletedResponse(page, {
      baseline,
      observation,
    }, options);
    const conversationId = await this.resolveConversationId(page, options);

    return this.createResult({
      rawResponse: rawResponse || observation.text,
      ...(conversationId ? { conversationId } : {}),
    });
  }

  protected abstract navigate(
    page: Page,
    options: TOptions,
  ): Promise<void>;

  protected async prepareProvider(
    _page: Page,
    _options: TOptions,
  ): Promise<void> {}

  protected abstract captureResponseBaseline(
    page: Page,
    options: TOptions,
  ): Promise<TBaseline>;

  protected abstract insertPrompt(
    page: Page,
    prompt: string,
    options: TOptions,
  ): Promise<void>;

  protected abstract submitPrompt(
    page: Page,
    options: TOptions,
  ): Promise<void>;

  protected abstract observeResponse(
    page: Page,
    baseline: TBaseline,
    options: TOptions,
  ): Promise<TObservation>;

  protected abstract extractCompletedResponse(
    page: Page,
    context: BrowserCompletionContext<TBaseline, TObservation>,
    options: TOptions,
  ): Promise<string>;

  protected abstract resolveConversationId(
    page: Page,
    options: TOptions,
  ): Promise<string | undefined>;

  protected abstract stopGeneration(page: Page): Promise<boolean>;

  protected createResult(result: BaseBrowserTurnResult): TResult {
    return result as TResult;
  }

  /**
   * Shared polling lifecycle cho provider worker.
   *
   * `protected` cho phép các provider phức tạp như M365 chuyển đổi theo từng
   * slice: provider vẫn có thể giữ orchestration đặc thù trong thời gian tạm
   * thời nhưng dùng chung heartbeat, abort, hard deadline và idle deadline.
   */
  protected async waitForCompletion(
    page: Page,
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
    let lastHeartbeatAt = startedAt - heartbeatIntervalMs;
    let lastActivityKey: string | undefined;
    let lastRenderedText = "";

    while (true) {
      if (options.signal?.aborted) {
        await this.stopGeneration(page).catch(() => false);
        this.throwIfAborted(options.signal, "during execution");
      }

      const now = Date.now();
      if (
        options.heartbeat &&
        now - lastHeartbeatAt >= heartbeatIntervalMs
      ) {
        lastHeartbeatAt = now;
        await options.heartbeat().catch(error => {
          console.warn(
            `[${this.logPrefix}] Không thể gửi heartbeat:`,
            error,
          );
        });
      }

      if (now - startedAt >= hardTimeoutMs) {
        await this.stopGeneration(page).catch(() => false);
        throw new BrowserHardTimeoutError(hardTimeoutMs);
      }

      const observation = await this.observeResponse(
        page,
        baseline,
        options,
      );
      const activityKey =
        observation.activityKey ??
        `${observation.isGenerating}:${observation.text}`;

      if (activityKey !== lastActivityKey) {
        lastActivityKey = activityKey;
        lastActivityAt = now;
      }

      if (observation.text !== lastRenderedText) {
        const delta = observation.text.startsWith(lastRenderedText)
          ? observation.text.slice(lastRenderedText.length)
          : "";
        lastRenderedText = observation.text;
        if (delta) options.onChunk?.(delta);
      }

      if (observation.isCompleted) return observation;

      if (now - lastActivityAt >= idleTimeoutMs) {
        await this.stopGeneration(page).catch(() => false);
        throw new BrowserIdleTimeoutError(idleTimeoutMs);
      }

      await page.waitForTimeout(pollingIntervalMs);
    }
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
