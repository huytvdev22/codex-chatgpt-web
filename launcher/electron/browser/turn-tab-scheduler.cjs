"use strict";

class TurnTabWaitTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "TurnTabWaitTimeoutError";
    this.code = "slot_wait_timeout";
  }
}

function buildConversationWaitKey(providerId, profileId, conversationKey) {
  return `${providerId || "m365"}::${profileId || "default"}::${conversationKey}`;
}

/**
 * Bộ điều phối hàng đợi phản ứng (Reactive Event-Driven Waiter Queue) cho `TurnTabManager`.
 *
 * Thay vì fail-fast khi chạm giới hạn slot hoặc mở trùng tab khi cùng `conversationKey` đang chạy,
 * các request đến sau sẽ đăng ký chờ theo FIFO và được đánh thức tức thì (0ms) khi tab cũ
 * hoàn tất (`endTurn`) hoặc được giải phóng (`removeTurnTab`), đồng thời tôn trọng `AbortSignal`.
 */
class TurnTabScheduler {
  constructor() {
    /** @type {Map<string, Array<{ resolve: () => void, reject: (err: Error) => void, cleanup: () => void }>>} */
    this.keyWaiters = new Map();
    /** @type {Array<{ providerId: string, resolve: () => void, reject: (err: Error) => void, cleanup: () => void }>} */
    this.slotWaiters = [];
  }

  pendingKeyCount(providerId, profileId, conversationKey) {
    if (!conversationKey) return 0;
    const key = buildConversationWaitKey(providerId, profileId, conversationKey);
    return this.keyWaiters.get(key)?.length ?? 0;
  }

  pendingSlotCount(providerId = null) {
    if (!providerId) return this.slotWaiters.length;
    return this.slotWaiters.filter((entry) => entry.providerId === providerId).length;
  }

  pendingCount() {
    let total = this.slotWaiters.length;
    for (const list of this.keyWaiters.values()) {
      total += list.length;
    }
    return total;
  }

  waitForKey({ providerId, profileId = "default", conversationKey, timeoutMs, signal }) {
    signal?.throwIfAborted?.();
    if (!conversationKey) return Promise.resolve();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new TurnTabWaitTimeoutError("Timed out waiting for active conversation tab"));
    }

    const key = buildConversationWaitKey(providerId, profileId, conversationKey);
    return new Promise((resolve, reject) => {
      let settled = false;
      const entry = {
        resolve: () => {
          if (settled) return;
          settled = true;
          entry.cleanup();
          resolve();
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          entry.cleanup();
          reject(error);
        },
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener?.("abort", onAbort);
          const list = this.keyWaiters.get(key);
          if (list) {
            const idx = list.indexOf(entry);
            if (idx >= 0) list.splice(idx, 1);
            if (list.length === 0) this.keyWaiters.delete(key);
          }
        },
      };

      const onAbort = () => {
        entry.reject(signal?.reason || new DOMException("Browser turn wait aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        entry.reject(new TurnTabWaitTimeoutError(`Timed out waiting ${timeoutMs}ms for active conversation tab`));
      }, timeoutMs);
      timer.unref?.();
      signal?.addEventListener?.("abort", onAbort, { once: true });

      let list = this.keyWaiters.get(key);
      if (!list) {
        list = [];
        this.keyWaiters.set(key, list);
      }
      list.push(entry);
    });
  }

  waitForSlot({ providerId, timeoutMs, signal }) {
    signal?.throwIfAborted?.();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new TurnTabWaitTimeoutError("Timed out waiting for an available browser tab slot"));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const entry = {
        providerId: providerId || "m365",
        resolve: () => {
          if (settled) return;
          settled = true;
          entry.cleanup();
          resolve();
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          entry.cleanup();
          reject(error);
        },
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener?.("abort", onAbort);
          const idx = this.slotWaiters.indexOf(entry);
          if (idx >= 0) this.slotWaiters.splice(idx, 1);
        },
      };

      const onAbort = () => {
        entry.reject(signal?.reason || new DOMException("Browser slot wait aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        entry.reject(new TurnTabWaitTimeoutError(`Timed out waiting ${timeoutMs}ms for an available browser tab slot`));
      }, timeoutMs);
      timer.unref?.();
      signal?.addEventListener?.("abort", onAbort, { once: true });

      this.slotWaiters.push(entry);
    });
  }

  /**
   * Đánh thức waiter đầu tiên đang chờ đúng `(providerId, profileId, conversationKey)` theo thứ tự FIFO.
   */
  notifyKeySettled(providerId, profileId = "default", conversationKey = null) {
    if (!conversationKey) return false;
    const key = buildConversationWaitKey(providerId, profileId, conversationKey);
    const list = this.keyWaiters.get(key);
    if (!list || list.length === 0) return false;
    const next = list[0];
    next.resolve();
    return true;
  }

  /**
   * Đánh thức waiter đầu tiên đang chờ slot (ưu tiên đúng `providerId` trước, sau đó mới tới global FIFO).
   */
  notifySlotFreed(providerId = null) {
    if (this.slotWaiters.length === 0) return false;
    const matched = providerId
      ? this.slotWaiters.find((entry) => entry.providerId === providerId)
      : null;
    const target = matched || this.slotWaiters[0];
    if (!target) return false;
    target.resolve();
    return true;
  }

  destroy(reason = new Error("TurnTabScheduler destroyed")) {
    const allKeyWaiters = [];
    for (const list of this.keyWaiters.values()) {
      allKeyWaiters.push(...list);
    }
    for (const entry of allKeyWaiters) {
      entry.reject(reason);
    }
    for (const entry of [...this.slotWaiters]) {
      entry.reject(reason);
    }
    this.keyWaiters.clear();
    this.slotWaiters.length = 0;
  }
}

module.exports = {
  TurnTabScheduler,
  TurnTabWaitTimeoutError,
  buildConversationWaitKey,
};
