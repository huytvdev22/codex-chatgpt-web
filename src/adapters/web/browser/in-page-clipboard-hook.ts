import type { Page } from "playwright-core";

export interface InPageClipboardHookOptions {
  /** Tên thuộc tính trên `window` lưu chuỗi văn bản vừa bị trang copy (vd `__aistudio_last_copied_markdown`). */
  resultKey: string;
  /** Có bật cờ `__codex_suppress_os_clipboard_write = true` ngay khi cài hook không. */
  suppressOsClipboardNow?: boolean;
  /** Có gọi `grantPermissions(["clipboard-read", "clipboard-write"])` trước khi cài hook không. */
  grantPermissions?: boolean;
  /** Có gọi `window.focus()` và `document.body?.focus()` trong lúc cài hook không (dùng cho M365). */
  focusBody?: boolean;
}

/**
 * Cài interceptor clipboard thuần DOM/JS bên trong một window (tách riêng để dễ unit test).
 * Chặn triệt để việc ghi ra OS Clipboard trên cả `navigator.clipboard.writeText`,
 * `navigator.clipboard.write`, `document.execCommand("copy")` (Angular CDK / legacy) và sự kiện `"copy"`.
 */
export function applyInPageClipboardInterceptor(
  win: Record<string, unknown>,
  doc: Document | undefined,
  options: {
    resultKey: string;
    suppressOsClipboardNow?: boolean;
    focusBody?: boolean;
  },
): void {
  if (options.focusBody) {
    try {
      (win as unknown as Window).focus?.();
      doc?.body?.focus?.();
    } catch {}
  }

  win[options.resultKey] = null;
  if (options.suppressOsClipboardNow) {
    win.__codex_suppress_os_clipboard_write = true;
  }

  const hookedFlagKey = `__codex_clipboard_hooked_${options.resultKey}`;
  if (win[hookedFlagKey]) return;
  win[hookedFlagKey] = true;

  const readSelectionOrActiveInput = (): string => {
    try {
      const selected = (win as unknown as Window).getSelection?.()?.toString();
      if (selected && selected.trim()) return selected;
    } catch {}
    try {
      const active = doc?.activeElement as
        | HTMLTextAreaElement
        | HTMLInputElement
        | null
        | undefined;
      if (active && typeof active.value === "string" && active.value.trim()) {
        return active.value;
      }
    } catch {}
    return "";
  };

  const nav = (win as unknown as { navigator?: Navigator }).navigator;
  const clip = nav?.clipboard;
  if (clip) {
    const origWriteText =
      typeof clip.writeText === "function" ? clip.writeText.bind(clip) : null;
    if (origWriteText) {
      clip.writeText = async (text: string) => {
        if (text && text.trim()) {
          win[options.resultKey] = text;
        }
        if (win.__codex_suppress_os_clipboard_write) return undefined;
        try {
          return await origWriteText(text);
        } catch {
          return undefined;
        }
      };
    }

    const origWrite =
      typeof clip.write === "function" ? clip.write.bind(clip) : null;
    if (origWrite) {
      clip.write = async (items: ClipboardItems) => {
        try {
          for (const item of items) {
            if (item.types?.includes("text/plain")) {
              const blob = await item.getType("text/plain");
              const text = await blob.text();
              if (text && text.trim()) {
                win[options.resultKey] = text;
                break;
              }
            }
          }
        } catch {}
        if (win.__codex_suppress_os_clipboard_write) return undefined;
        try {
          return await origWrite(items);
        } catch {
          return undefined;
        }
      };
    }
  }

  if (doc && typeof doc.execCommand === "function") {
    const origExecCommand = doc.execCommand.bind(doc);
    doc.execCommand = ((
      commandId: string,
      showUI?: boolean,
      value?: string,
    ): boolean => {
      if (
        String(commandId).toLowerCase() === "copy" &&
        win.__codex_suppress_os_clipboard_write
      ) {
        const captured = readSelectionOrActiveInput();
        if (captured) {
          win[options.resultKey] = captured;
        }
        return true;
      }
      return origExecCommand(commandId, showUI, value);
    }) as Document["execCommand"];
  }

  if (doc && typeof doc.addEventListener === "function") {
    doc.addEventListener(
      "copy",
      (event: ClipboardEvent) => {
        const text =
          event.clipboardData?.getData("text/plain") ||
          readSelectionOrActiveInput();
        if (text && text.trim()) {
          win[options.resultKey] = text;
        }
        if (win.__codex_suppress_os_clipboard_write) {
          event.preventDefault();
          event.stopImmediatePropagation?.();
        }
      },
      { capture: true },
    );
  }
}

/**
 * Cài hook clipboard nội bộ trang qua Playwright `page.evaluate`.
 */
export async function installInPageClipboardHook(
  page: Page,
  options: InPageClipboardHookOptions,
): Promise<void> {
  if (options.grantPermissions !== false) {
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"])
      .catch(() => {});
  }

  await page.evaluate(
    ({ resultKey, suppressOsClipboardNow, focusBody }) => {
      const win = window as unknown as Record<string, unknown>;
      if (focusBody) {
        try {
          window.focus();
          document.body?.focus();
        } catch {}
      }

      win[resultKey] = null;
      if (suppressOsClipboardNow) {
        win.__codex_suppress_os_clipboard_write = true;
      }

      const hookedFlagKey = `__codex_clipboard_hooked_${resultKey}`;
      if (win[hookedFlagKey]) return;
      win[hookedFlagKey] = true;

      const readSelectionOrActiveInput = (): string => {
        try {
          const selected = window.getSelection()?.toString();
          if (selected && selected.trim()) return selected;
        } catch {}
        try {
          const active = document.activeElement as
            | HTMLTextAreaElement
            | HTMLInputElement
            | null;
          if (active && typeof active.value === "string" && active.value.trim()) {
            return active.value;
          }
        } catch {}
        return "";
      };

      if (navigator.clipboard) {
        const origWriteText = navigator.clipboard.writeText?.bind(
          navigator.clipboard,
        );
        if (origWriteText) {
          navigator.clipboard.writeText = async (text: string) => {
            if (text && text.trim()) {
              win[resultKey] = text;
            }
            if (win.__codex_suppress_os_clipboard_write) return undefined;
            try {
              return await origWriteText(text);
            } catch {
              return undefined;
            }
          };
        }

        const origWrite = navigator.clipboard.write?.bind(navigator.clipboard);
        if (origWrite) {
          navigator.clipboard.write = async (items: ClipboardItems) => {
            try {
              for (const item of items) {
                if (item.types?.includes("text/plain")) {
                  const blob = await item.getType("text/plain");
                  const text = await blob.text();
                  if (text && text.trim()) {
                    win[resultKey] = text;
                    break;
                  }
                }
              }
            } catch {}
            if (win.__codex_suppress_os_clipboard_write) return undefined;
            try {
              return await origWrite(items);
            } catch {
              return undefined;
            }
          };
        }
      }

      if (typeof document.execCommand === "function") {
        const origExecCommand = document.execCommand.bind(document);
        document.execCommand = ((
          commandId: string,
          showUI?: boolean,
          value?: string,
        ): boolean => {
          if (
            String(commandId).toLowerCase() === "copy" &&
            win.__codex_suppress_os_clipboard_write
          ) {
            const captured = readSelectionOrActiveInput();
            if (captured) {
              win[resultKey] = captured;
            }
            return true;
          }
          return origExecCommand(commandId, showUI, value);
        }) as Document["execCommand"];
      }

      document.addEventListener(
        "copy",
        (event: ClipboardEvent) => {
          const text =
            event.clipboardData?.getData("text/plain") ||
            readSelectionOrActiveInput();
          if (text && text.trim()) {
            win[resultKey] = text;
          }
          if (win.__codex_suppress_os_clipboard_write) {
            event.preventDefault();
            event.stopImmediatePropagation?.();
          }
        },
        { capture: true },
      );
    },
    {
      resultKey: options.resultKey,
      suppressOsClipboardNow: Boolean(options.suppressOsClipboardNow),
      focusBody: Boolean(options.focusBody),
    },
  );
}

/**
 * Tắt cờ chặn OS Clipboard sau khi hoàn tất thao tác copy tự động của tab nền.
 */
export async function releaseOsClipboardSuppression(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      (window as unknown as Record<string, unknown>).__codex_suppress_os_clipboard_write =
        false;
    })
    .catch(() => {});
}
