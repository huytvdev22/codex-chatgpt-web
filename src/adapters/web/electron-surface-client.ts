export interface ElectronSurfaceClientConfig {
  controlEndpoint: string;
  controlToken: string;
  traceId: string;
  helperPid?: number;
  defaultTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface SurfaceSelectorQuery {
  nth?: number;
  visibleOnly?: boolean;
  textIncludes?: string;
  containerSelector?: string;
  containerNth?: number;
  scrollBlock?: "start" | "center" | "end" | "nearest";
  trusted?: boolean;
}

export interface SurfaceClickResult {
  clicked: boolean;
  found?: boolean;
  disabled?: boolean;
  text?: string;
}

/**
 * Client HTTP gọi endpoint nội bộ `POST /v1/surface/action` của Electron Launcher
 * để điều khiển tab Google AI Studio mà không cần gắn Playwright CDP.
 */
export class ElectronSurfaceClient {
  private readonly controlEndpoint: string;
  private readonly controlToken: string;
  private readonly traceId: string;
  private readonly helperPid: number;
  private readonly defaultTimeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: ElectronSurfaceClientConfig) {
    this.controlEndpoint = config.controlEndpoint.replace(/\/+$/, "");
    this.controlToken = config.controlToken;
    this.traceId = config.traceId;
    this.helperPid = config.helperPid ?? process.pid;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 45_000;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  public async call<TResult = unknown>(
    action: string,
    args: Record<string, unknown> = {},
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<TResult> {
    if (options?.signal?.aborted) {
      throw new DOMException(`Surface action '${action}' aborted`, "AbortError");
    }

    const timeoutSignal = AbortSignal.timeout(
      options?.timeoutMs ?? this.defaultTimeoutMs,
    );
    const requestSignal = options?.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    const response = await this.fetchFn(
      `${this.controlEndpoint}/v1/surface/action`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.controlToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          traceId: this.traceId,
          helperPid: this.helperPid,
          action,
          args,
        }),
        signal: requestSignal,
      },
    );

    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: TResult;
      error?: string;
    } | null;

    if (!response.ok || !payload?.ok) {
      throw new Error(
        payload?.error ||
          `Electron surface action '${action}' failed with status ${response.status}`,
      );
    }

    return payload.result as TResult;
  }

  public async getUrl(signal?: AbortSignal): Promise<string> {
    const res = await this.call<{ url: string }>("getUrl", {}, { signal });
    return res.url;
  }

  public async navigate(
    url: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<string> {
    const timeoutMs = options?.timeoutMs ?? 25_000;
    const res = await this.call<{ url: string }>(
      "navigate",
      { url, timeoutMs },
      { signal: options?.signal, timeoutMs: timeoutMs + 5_000 },
    );
    return res.url;
  }

  public async waitForSelector(
    selector: string,
    options?: { visible?: boolean; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? 15_000;
    await this.call(
      "waitForSelector",
      {
        selector,
        visible: options?.visible ?? true,
        timeoutMs,
      },
      { signal: options?.signal, timeoutMs: timeoutMs + 5_000 },
    );
  }

  public async clickSelector(
    selector: string,
    options?: SurfaceSelectorQuery & { signal?: AbortSignal },
  ): Promise<SurfaceClickResult> {
    const { signal, ...rest } = options ?? {};
    return await this.call<SurfaceClickResult>(
      "clickSelector",
      { selector, ...rest },
      { signal },
    );
  }

  public async hoverSelector(
    selector: string,
    options?: SurfaceSelectorQuery & { signal?: AbortSignal },
  ): Promise<void> {
    const { signal, ...rest } = options ?? {};
    await this.call("hoverSelector", { selector, ...rest }, { signal });
  }

  public async fillTextarea(
    selector: string,
    value: string,
    options?: {
      nth?: number;
      blur?: boolean;
      pressEnter?: boolean;
      optional?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    const { signal, ...rest } = options ?? {};
    await this.call(
      "fillTextarea",
      { selector, value, ...rest },
      { signal },
    );
  }

  public async pressKey(key: string, signal?: AbortSignal): Promise<void> {
    await this.call("pressKey", { key }, { signal });
  }

  public async pasteImages(
    files: Array<{ name: string; mimeType: string; dataBase64: string }>,
    targetSelector?: string,
    signal?: AbortSignal,
  ): Promise<{ attachedCount: number }> {
    return await this.call<{ attachedCount: number }>(
      "pasteImages",
      {
        files,
        ...(targetSelector ? { targetSelector } : {}),
      },
      { signal, timeoutMs: 60_000 },
    );
  }

  public async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return;
    if (signal?.aborted) {
      throw new DOMException("Surface sleep aborted", "AbortError");
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Surface sleep aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
