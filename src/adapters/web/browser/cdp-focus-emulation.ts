import type { CDPSession, Page } from "playwright-core";

interface FocusEmulationEntry {
  sessionPromise: Promise<CDPSession | null>;
  refCount: number;
}

const activeSessions = new WeakMap<Page, FocusEmulationEntry>();

/**
 * Bật CDP `Emulation.setFocusEmulationEnabled(true)` cho một `Page` chạy nền và giữ
 * phiên CDP sống suốt thời gian thực thi lượt để `document.hasFocus()` luôn trả `true`
 * độc lập giữa các tab song song mà không cần gọi `page.bringToFront()`.
 *
 * Trả về hàm `release()` an toàn để giảm refCount và đóng CDP session sau khi xong lượt.
 */
export async function acquirePageFocusEmulation(
  page: Page,
): Promise<() => Promise<void>> {
  const context =
    typeof page?.context === "function" ? page.context() : undefined;
  if (!context || typeof context.newCDPSession !== "function") {
    return async () => {};
  }

  let entry = activeSessions.get(page);
  if (!entry) {
    const sessionPromise = (async (): Promise<CDPSession | null> => {
      try {
        const session = await context.newCDPSession(page);
        await session.send("Emulation.setFocusEmulationEnabled", {
          enabled: true,
        });
        return session;
      } catch {
        return null;
      }
    })();
    entry = { sessionPromise, refCount: 0 };
    activeSessions.set(page, entry);
  }

  entry.refCount += 1;
  const activeEntry = entry;
  await activeEntry.sessionPromise;

  let released = false;
  return async (): Promise<void> => {
    if (released) return;
    released = true;
    activeEntry.refCount = Math.max(0, activeEntry.refCount - 1);
    if (activeEntry.refCount > 0) return;

    if (activeSessions.get(page) === activeEntry) {
      activeSessions.delete(page);
    }
    const session = await activeEntry.sessionPromise.catch(() => null);
    if (!session) return;
    await session
      .send("Emulation.setFocusEmulationEnabled", { enabled: false })
      .catch(() => {});
    await session.detach().catch(() => {});
  };
}

export async function withPageFocusEmulation<T>(
  page: Page,
  task: () => Promise<T>,
): Promise<T> {
  const release = await acquirePageFocusEmulation(page);
  try {
    return await task();
  } finally {
    await release();
  }
}
