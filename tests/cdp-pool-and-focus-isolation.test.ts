import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import {
  LAUNCHER_BROWSER_HOST_KIND,
  LAUNCHER_BROWSER_IDLE_URL,
  selectLauncherPage,
  type LauncherBrowserHostDescriptor,
} from "../src/launcher-browser-host";
import { LauncherCdpPool } from "../src/launcher-cdp-pool";
import { BrowserFocusMutex } from "../src/adapters/web/browser/browser-focus-mutex";
import {
  acquirePageFocusEmulation,
  withPageFocusEmulation,
} from "../src/adapters/web/browser/cdp-focus-emulation";
import { applyInPageClipboardInterceptor } from "../src/adapters/web/browser/in-page-clipboard-hook";

function makeDescriptor(surfaceTargets: Record<string, string>): LauncherBrowserHostDescriptor {
  return {
    version: 3,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:39111",
    control: {
      endpoint: "http://127.0.0.1:39112",
      token: "t".repeat(48),
    },
    helper: {
      executable: process.execPath,
      script: import.meta.path,
    },
    partition: "persist:codex-web-gemini",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "s".repeat(32),
    surfaceTargets,
    createdAt: new Date().toISOString(),
  };
}

describe("CDP Pool, target isolation và Focus/Clipboard safety", () => {
  test("selectLauncherPage không bị kéo chậm bởi một tab đang treo newCDPSession", async () => {
    const stalledPage = { id: "stalled" } as unknown as Page;
    const ownedPage = { id: "owned" } as unknown as Page;
    let cdpCallsOnOwned = 0;

    const context = {
      pages: () => [stalledPage, ownedPage],
      newCDPSession: async (page: Page) => {
        if (page === stalledPage) {
          // Giả lập renderer bị dừng/treo hoàn toàn không phản hồi
          return await new Promise<never>(() => {});
        }
        cdpCallsOnOwned += 1;
        return {
          send: async () => ({ targetInfo: { targetId: "target-owned-fast" } }),
          detach: async () => {},
        };
      },
    } as unknown as BrowserContext;

    const browser = { contexts: () => [context] } as unknown as Browser;
    const descriptor = makeDescriptor({ ["s".repeat(32)]: "target-owned-fast" });
    const cache = new WeakMap<Page, string>();

    const startedAt = Date.now();
    const first = await selectLauncherPage(
      browser,
      descriptor,
      2_000,
      "s".repeat(32),
      undefined,
      { pageTargetCache: cache, duplicateCheckGraceMs: 15 },
    );
    const firstElapsed = Date.now() - startedAt;

    expect(first.page).toBe(ownedPage);
    expect(firstElapsed).toBeLessThan(300);
    expect(cdpCallsOnOwned).toBe(1);

    // Lần 2 hit WeakMap cache trong 0ms và không mở thêm CDP session nào
    const second = await selectLauncherPage(
      browser,
      descriptor,
      2_000,
      "s".repeat(32),
      undefined,
      { explicitTargetId: "target-owned-fast", pageTargetCache: cache },
    );
    expect(second.page).toBe(ownedPage);
    expect(cdpCallsOnOwned).toBe(1);
  });

  test("LauncherCdpPool tái sử dụng cùng 1 kết nối cho nhiều turn song song và chỉ đóng khi release hết", async () => {
    const pool = new LauncherCdpPool(30);
    let connectCalls = 0;
    let closeCalls = 0;

    const connect = async () => {
      connectCalls += 1;
      return {
        isConnected: () => closeCalls === 0,
        on: () => {},
        close: async () => {
          closeCalls += 1;
        },
      } as unknown as Browser;
    };

    const lease1 = await pool.acquire({
      endpoint: "http://127.0.0.1:40001",
      pid: 12345,
      timeoutMs: 1_000,
      connect,
    });
    const lease2 = await pool.acquire({
      endpoint: "http://127.0.0.1:40001",
      pid: 12345,
      timeoutMs: 1_000,
      connect,
    });

    expect(connectCalls).toBe(1);
    expect(lease1.reusedConnection).toBe(false);
    expect(lease2.reusedConnection).toBe(true);
    expect(lease1.browser).toBe(lease2.browser);

    await lease1.release();
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(closeCalls).toBe(0);

    await lease2.release();
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(closeCalls).toBe(1);
    expect(pool.activeConnections()).toBe(0);
  });

  test("BrowserFocusMutex tuần tự hóa theo FIFO và tôn trọng AbortSignal", async () => {
    const mutex = new BrowserFocusMutex();
    const order: string[] = [];

    let releaseFirst!: () => void;
    const firstDone = mutex.runExclusive(async () => {
      order.push("start-1");
      await new Promise<void>(resolve => {
        releaseFirst = resolve;
      });
      order.push("end-1");
    });

    const abortedController = new AbortController();
    const abortedTask = mutex.runExclusive(
      async () => {
        order.push("should-not-run");
      },
      { signal: abortedController.signal },
    );

    const secondDone = mutex.runExclusive(async () => {
      order.push("start-2");
      order.push("end-2");
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(mutex.pendingCount()).toBe(2);

    abortedController.abort();
    await expect(abortedTask).rejects.toMatchObject({ name: "AbortError" });
    expect(mutex.pendingCount()).toBe(1);

    releaseFirst();
    await Promise.all([firstDone, secondDone]);
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  test("4 adapter dùng shared clipboard hook và chặn triệt để write/execCommand/copy ghi OS Clipboard", () => {
    const clipboardFiles = [
      "src/adapters/chatgpt/chatgpt-clipboard-salvage.ts",
      "src/adapters/gemini/gemini-clipboard-salvage.ts",
      "src/adapters/ai-studio/ai-studio-browser-worker.ts",
      "src/adapters/m365-copilot/m365-clipboard-salvage.ts",
    ];
    for (const relPath of clipboardFiles) {
      const source = readFileSync(resolve(import.meta.dir, "..", relPath), "utf8");
      const codeOnly = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(codeOnly).not.toContain("clipboard.readText");
      expect(codeOnly).not.toContain("clipboard?.readText");
      expect(codeOnly).toContain("installInPageClipboardHook");
    }

    const hookSource = readFileSync(
      resolve(import.meta.dir, "..", "src/adapters/web/browser/in-page-clipboard-hook.ts"),
      "utf8",
    );
    expect(hookSource).toContain("navigator.clipboard.write =");
    expect(hookSource).toContain("execCommand");
    expect(hookSource).toContain("event.preventDefault()");
    expect(hookSource).toContain("__codex_suppress_os_clipboard_write");

    // Kiểm chứng hành vi runtime chặn execCommand("copy") & copy event không chạm OS clipboard
    let origExecCalled = 0;
    let origWriteCalled = 0;
    let copyPrevented = false;
    let copyStopped = false;
    const listeners: Record<string, Array<(e: unknown) => void>> = {};
    const fakeDoc = {
      activeElement: { value: "AI_STUDIO_CDK_EXEC_COPY_TEXT" },
      execCommand: (_cmd: string) => {
        origExecCalled += 1;
        return true;
      },
      addEventListener: (name: string, fn: (e: unknown) => void) => {
        (listeners[name] ||= []).push(fn);
      },
    } as unknown as Document;
    const fakeWin: Record<string, unknown> = {
      getSelection: () => ({ toString: () => "" }),
      navigator: {
        clipboard: {
          writeText: async () => {
            origWriteCalled += 1;
          },
          write: async () => {
            origWriteCalled += 1;
          },
        },
      },
    };

    applyInPageClipboardInterceptor(fakeWin, fakeDoc, {
      resultKey: "__test_copied",
      suppressOsClipboardNow: true,
    });

    const execResult = fakeDoc.execCommand("copy");
    expect(execResult).toBe(true);
    expect(origExecCalled).toBe(0);
    expect(fakeWin.__test_copied).toBe("AI_STUDIO_CDK_EXEC_COPY_TEXT");

    fakeWin.__test_copied = null;
    for (const cb of listeners.copy || []) {
      cb({
        clipboardData: { getData: () => "COPY_EVENT_TEXT" },
        preventDefault: () => {
          copyPrevented = true;
        },
        stopImmediatePropagation: () => {
          copyStopped = true;
        },
      });
    }
    expect(fakeWin.__test_copied).toBe("COPY_EVENT_TEXT");
    expect(copyPrevented).toBe(true);
    expect(copyStopped).toBe(true);
    expect(origWriteCalled).toBe(0);

    const adaptersRoot = resolve(import.meta.dir, "..", "src/adapters");
    const adapterFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith(".ts")) adapterFiles.push(full);
      }
    };
    walk(adaptersRoot);
    expect(adapterFiles.length).toBeGreaterThan(10);
    for (const filePath of adapterFiles) {
      const source = readFileSync(filePath, "utf8");
      const codeOnly = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(codeOnly).not.toContain(".bringToFront(");
    }
  });

  test("acquirePageFocusEmulation bật CDP Emulation.setFocusEmulationEnabled theo refCount và dọn sạch khi release", async () => {
    const cdpCalls: Array<{ method: string; params?: unknown }> = [];
    let newSessionCount = 0;
    let detachCount = 0;

    const fakePage = {
      context: () => ({
        newCDPSession: async () => {
          newSessionCount += 1;
          return {
            send: async (method: string, params?: unknown) => {
              cdpCalls.push({ method, params });
            },
            detach: async () => {
              detachCount += 1;
            },
          };
        },
      }),
    } as unknown as Page;

    const release1 = await acquirePageFocusEmulation(fakePage);
    const result = await withPageFocusEmulation(fakePage, async () => {
      expect(newSessionCount).toBe(1);
      return "ok";
    });
    expect(result).toBe("ok");
    // Chưa detach vì release1 vẫn đang giữ refCount
    expect(detachCount).toBe(0);

    await release1();
    expect(detachCount).toBe(1);
    expect(cdpCalls).toEqual([
      { method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } },
      { method: "Emulation.setFocusEmulationEnabled", params: { enabled: false } },
    ]);

    // Mock Page không có context() phải no-op an toàn
    const noopRelease = await acquirePageFocusEmulation({} as Page);
    await noopRelease();
  });
});
