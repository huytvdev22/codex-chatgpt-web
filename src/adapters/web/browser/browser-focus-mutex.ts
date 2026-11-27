/**
 * Mutex phản ứng (FIFO + AbortSignal) tuần tự hóa các thao tác ngắn bắt buộc phải
 * chiếm focus cửa sổ/tab (ví dụ trusted click nút Copy trên ChatGPT/Gemini) để
 * nhiều tab song song không giật focus của nhau ngay giữa thao tác.
 */
export class BrowserFocusMutex {
  private locked = false;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
    cleanup: () => void;
  }> = [];

  public async acquire(options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<() => void> {
    const signal = options?.signal;
    const timeoutMs = options?.timeoutMs ?? 3_000;

    if (signal?.aborted) {
      throw new DOMException("Browser focus acquisition aborted", "AbortError");
    }

    if (!this.locked) {
      this.locked = true;
      return this.createRelease();
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const entry = {
        resolve: () => {
          if (settled) return;
          settled = true;
          entry.cleanup();
          resolve();
        },
        reject: (error: unknown) => {
          if (settled) return;
          settled = true;
          entry.cleanup();
          reject(error);
        },
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          const idx = this.waiters.indexOf(entry);
          if (idx >= 0) this.waiters.splice(idx, 1);
        },
      };

      const onAbort = () => {
        entry.reject(new DOMException("Browser focus acquisition aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        entry.reject(new Error(`Browser focus mutex timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });

      this.waiters.push(entry);
    });

    return this.createRelease();
  }

  public async runExclusive<T>(
    task: () => Promise<T>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T> {
    const release = await this.acquire(options);
    try {
      return await task();
    } finally {
      release();
    }
  }

  public pendingCount(): number {
    return this.waiters.length;
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next.resolve();
      } else {
        this.locked = false;
      }
    };
  }
}

export const browserFocusMutex = new BrowserFocusMutex();
