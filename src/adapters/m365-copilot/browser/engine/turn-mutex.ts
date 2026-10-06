import { logFunctionInput } from "../../debug-logger";

/**
 * Mutex bảo đảm thứ tự tuần tự (FIFO) cho các turn trình duyệt.
 * Ngăn chặn tuyệt đối hiện tượng 2 cửa sổ VS Code gõ đè vào DOM cùng một thời điểm.
 */
export class TurnMutex {
  private queue: Promise<void> = Promise.resolve();
  private waitingCount = 0;

  get pendingCount(): number {
    return this.waitingCount;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    logFunctionInput("browser:engine:turn-mutex", "acquire", { waitingBefore: this.waitingCount });

    if (signal?.aborted) {
      throw new DOMException("Browser turn mutex acquisition aborted before start", "AbortError");
    }

    this.waitingCount++;
    let releaseLock: () => void = () => {};
    const nextTurn = new Promise<void>((resolve) => {
      releaseLock = () => {
        resolve();
      };
    });

    const previousTurn = this.queue;
    this.queue = this.queue.then(() => nextTurn).catch(() => nextTurn);

    try {
      if (signal) {
        let onAbort: () => void;
        const abortPromise = new Promise<never>((_, reject) => {
          onAbort = () => reject(new DOMException("Browser turn mutex acquisition aborted", "AbortError"));
          signal.addEventListener("abort", onAbort, { once: true });
        });
        await Promise.race([previousTurn, abortPromise]);
      } else {
        await previousTurn;
      }
    } catch (err) {
      // Khi bị abort, giải phóng vị trí trong hàng đợi để lượt tiếp theo không bị kẹt
      releaseLock();
      this.waitingCount = Math.max(0, this.waitingCount - 1);
      throw err;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.waitingCount = Math.max(0, this.waitingCount - 1);
      releaseLock();
    };
  }

  /**
   * Chạy một tác vụ bất đồng bộ độc quyền với bảo vệ của Mutex.
   */
  async runExclusive<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Mutex dùng chung toàn cục cho các lượt tương tác trên trình duyệt */
export const globalBrowserTurnMutex = new TurnMutex();
