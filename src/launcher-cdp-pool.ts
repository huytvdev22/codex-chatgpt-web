import { chromium, type Browser, type Page } from "playwright-core";

export interface LauncherCdpLease {
  browser: Browser;
  pageTargetCache: WeakMap<Page, string>;
  reusedConnection: boolean;
  release: () => Promise<void>;
  invalidate: () => Promise<void>;
}

export interface LauncherCdpAcquireOptions {
  endpoint: string;
  pid: number;
  timeoutMs: number;
  signal?: AbortSignal;
  connect?: (endpoint: string, options: { timeout: number }) => Promise<Browser>;
}

interface PoolEntry {
  key: string;
  browserPromise: Promise<Browser>;
  browser: Browser | null;
  pageTargetCache: WeakMap<Page, string>;
  refCount: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

const DEFAULT_IDLE_CLOSE_MS = 15_000;

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new DOMException("Launcher browser connection aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException("Launcher browser connection aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Pool chia sẻ một kết nối Playwright CDP duy nhất cho mỗi `(pid, endpoint)` của Electron Launcher.
 *
 * Giúp nhiều lượt chạy đồng thời (Codex CLI, Codex Assistant, Daily Podcast Studio) không phải
 * liên tục mở/đóng WebSocket CDP mới và giữ `WeakMap<Page, targetId>` để tra cứu tab tái sử dụng trong 0ms.
 */
export class LauncherCdpPool {
  private readonly entries = new Map<string, PoolEntry>();

  constructor(private readonly idleCloseMs = DEFAULT_IDLE_CLOSE_MS) {}

  private poolKey(pid: number, endpoint: string): string {
    return `${pid}::${endpoint}`;
  }

  private evictEntry(entry: PoolEntry, closeBrowser: boolean): Promise<void> {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key);
    }
    if (entry.closed) return Promise.resolve();
    entry.closed = true;
    if (!closeBrowser) return Promise.resolve();
    if (entry.browser) {
      return entry.browser.close().catch(() => {});
    }
    return entry.browserPromise
      .then(browser => browser.close().catch(() => {}))
      .catch(() => {});
  }

  private scheduleIdleClose(entry: PoolEntry): void {
    if (entry.closed || entry.refCount > 0 || entry.idleTimer) return;
    if (this.idleCloseMs <= 0) {
      void this.evictEntry(entry, true);
      return;
    }
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.refCount === 0 && !entry.closed) {
        void this.evictEntry(entry, true);
      }
    }, this.idleCloseMs);
    entry.idleTimer.unref?.();
  }

  public async acquire(options: LauncherCdpAcquireOptions): Promise<LauncherCdpLease> {
    if (options.signal?.aborted) {
      throw new DOMException("Launcher browser connection aborted", "AbortError");
    }

    const key = this.poolKey(options.pid, options.endpoint);
    let entry = this.entries.get(key);
    let reusedConnection = false;

    if (entry && !entry.closed) {
      if (entry.browser && typeof entry.browser.isConnected === "function" && !entry.browser.isConnected()) {
        await this.evictEntry(entry, false);
        entry = undefined;
      } else {
        reusedConnection = true;
      }
    }

    if (!entry || entry.closed) {
      const connect = options.connect ?? ((endpoint, opts) => chromium.connectOverCDP(endpoint, opts));
      const created: PoolEntry = {
        key,
        browserPromise: null as unknown as Promise<Browser>,
        browser: null,
        pageTargetCache: new WeakMap<Page, string>(),
        refCount: 0,
        idleTimer: null,
        closed: false,
      };
      created.browserPromise = connect(options.endpoint, { timeout: options.timeoutMs })
        .then(browser => {
          created.browser = browser;
          if (typeof browser.on === "function") {
            browser.on("disconnected", () => {
              void this.evictEntry(created, false);
            });
          }
          if (created.closed) {
            void browser.close().catch(() => {});
            throw new Error("Launcher CDP connection closed before initialization completed");
          }
          return browser;
        })
        .catch(error => {
          void this.evictEntry(created, false);
          throw error;
        });
      this.entries.set(key, created);
      entry = created;
    }

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    entry.refCount += 1;

    let browser: Browser;
    try {
      browser = await raceWithAbort(entry.browserPromise, options.signal);
    } catch (error) {
      entry.refCount = Math.max(0, entry.refCount - 1);
      if (entry.refCount === 0 && !entry.closed) {
        this.scheduleIdleClose(entry);
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      throw new Error(
        `Could not connect Playwright to the launcher browser: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let released = false;
    const activeEntry = entry;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      activeEntry.refCount = Math.max(0, activeEntry.refCount - 1);
      if (activeEntry.refCount === 0 && !activeEntry.closed) {
        this.scheduleIdleClose(activeEntry);
      }
    };
    const invalidate = async (): Promise<void> => {
      if (!released) {
        released = true;
        activeEntry.refCount = Math.max(0, activeEntry.refCount - 1);
      }
      await this.evictEntry(activeEntry, true);
    };

    return {
      browser,
      pageTargetCache: activeEntry.pageTargetCache,
      reusedConnection,
      release,
      invalidate,
    };
  }

  public activeConnections(): number {
    return this.entries.size;
  }

  public async closeAll(): Promise<void> {
    const all = [...this.entries.values()];
    await Promise.all(all.map(entry => this.evictEntry(entry, true)));
  }
}

export const launcherCdpPool = new LauncherCdpPool();
