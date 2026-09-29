import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface M365BrowserRunOptions {
  onChunk: (text: string) => void;
  signal?: AbortSignal;
}

const SUPPORTED_BROWSERS = [
  "Brave Browser",
  "Google Chrome",
  "Microsoft Edge",
];

/**
 * Thực thi đoạn JavaScript trên tab M365 Copilot
 * Tự động tìm kiếm trên Brave, Chrome hoặc Edge đang chạy
 */
async function runJsInBrowserTab(jsCode: string): Promise<string> {
  const escapedJs = jsCode.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  let lastError: Error | null = null;

  for (const browser of SUPPORTED_BROWSERS) {
    const appleScript = `
      tell application "${browser}"
        set targetTab to missing value
        repeat with w in windows
          repeat with t in tabs of w
            if URL of t contains "m365.cloud.microsoft" then
              set targetTab to t
              exit repeat
            end if
          end repeat
          if targetTab is not missing value then exit repeat
        end repeat
        
        if targetTab is missing value then
          error "NOT_FOUND"
        end if
        
        return execute targetTab javascript "${escapedJs}"
      end tell
    `;

    try {
      const { stdout } = await execFileAsync("osascript", ["-e", appleScript]);
      return stdout.trim();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("NOT_FOUND") || message.includes("Application isn’t running") || message.includes("not running")) {
        continue;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error(
    "Không tìm thấy tab Microsoft 365 Copilot (m365.cloud.microsoft) đang mở trong Brave Browser, Google Chrome hoặc Microsoft Edge! Vui lòng mở trình duyệt và đăng nhập vào https://m365.cloud.microsoft/chat"
  );
}

/**
 * Đảm bảo tab đang bật chế độ Temporary chat
 */
export async function ensureM365TemporaryChat(): Promise<void> {
  const script = `
    (() => {
      const toggleBtn = document.querySelector('button[aria-label="Temporary chat"], button[aria-label*="Tạm thời"]');
      if (!toggleBtn) return JSON.stringify({ ok: true, note: "button not found, maybe already temporary or different UI" });
      
      const isPressed = toggleBtn.getAttribute("aria-pressed") === "true";
      if (!isPressed) {
        toggleBtn.focus();
        toggleBtn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
        toggleBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        toggleBtn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
        toggleBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        toggleBtn.click();
      }
      
      return JSON.stringify({ ok: true, active: true });
    })()
  `;

  await runJsInBrowserTab(script);
}

/**
 * Lấy nội dung tin nhắn cuối cùng hiện tại trước khi gửi prompt mới
 */
async function getLastMessageContent(): Promise<string> {
  const script = `
    (() => {
      const messages = Array.from(document.querySelectorAll(".fai-CopilotMessage"));
      if (messages.length === 0) return JSON.stringify({ content: "" });
      const last = messages[messages.length - 1];
      return JSON.stringify({ content: last.innerText || "" });
    })()
  `;

  try {
    const raw = await runJsInBrowserTab(script);
    const parsed = JSON.parse(raw);
    return parsed.content || "";
  } catch {
    return "";
  }
}

/**
 * Dán prompt vào khung soạn thảo và bấm nút Gửi
 */
export async function sendM365Prompt(promptText: string): Promise<string> {
  await ensureM365TemporaryChat();

  const lastContentBefore = await getLastMessageContent();
  const escapedPrompt = JSON.stringify(promptText);

  // 1. Dán văn bản vào editor
  const insertScript = `
    (() => {
      const editor = document.getElementById("m365-chat-editor-target-element") || document.querySelector("div[contenteditable='true']");
      if (!editor) {
        return JSON.stringify({ ok: false, error: "Không tìm thấy ô nhập liệu #m365-chat-editor-target-element" });
      }

      editor.focus();
      
      // Xoá nội dung cũ
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("delete", false, null);

      // Bơm văn bản bằng sự kiện paste
      const dt = new DataTransfer();
      dt.setData("text/plain", ${escapedPrompt});
      editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));

      return JSON.stringify({ ok: true });
    })()
  `;

  const rawInsert = await runJsInBrowserTab(insertScript);
  const parsedInsert = JSON.parse(rawInsert);
  if (!parsedInsert.ok) {
    throw new Error(parsedInsert.error || "Không thể nhập prompt vào ô soạn thảo");
  }

  // 2. Chờ nút Gửi kích hoạt và nhấn Gửi
  let sent = false;
  for (let i = 0; i < 30; i++) {
    const clickRes = await runJsInBrowserTab(`
      (() => {
        const btn = document.querySelector('button[aria-label="Send"], button.fai-SendButton, button[aria-label*="Send"], button[aria-label*="Gửi"]');
        if (!btn) return "NO_BTN";
        if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return "DISABLED";

        btn.focus();
        btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
        btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
        btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        btn.click();
        return "CLICKED";
      })()
    `);

    if (clickRes.includes("CLICKED")) {
      sent = true;
      break;
    }
    await new Promise(r => setTimeout(r, 150));
  }

  if (!sent) {
    throw new Error("Không thể kích hoạt nút Gửi trên tab M365 Copilot sau khi dán prompt!");
  }

  return lastContentBefore;
}

/**
 * Lắng nghe phản hồi thời gian thực từ tab M365 Copilot
 */
export async function streamM365Response(
  lastContentBefore: string,
  options: M365BrowserRunOptions
): Promise<string> {
  const { onChunk, signal } = options;
  const escapedBefore = JSON.stringify(lastContentBefore);

  let previousText = "";
  let seenGenerating = false;
  let attempts = 0;
  const maxAttempts = 240; // 240 * 300ms = 72 giây tối đa
  const pollIntervalMs = 300;

  while (attempts < maxAttempts) {
    if (signal?.aborted) {
      // Nhấn nút Stop trên tab nếu có
      try {
        await runJsInBrowserTab(`
          (() => {
            const stopBtn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="Dừng"]');
            if (stopBtn) stopBtn.click();
          })()
        `);
      } catch {
        // bỏ qua lỗi nếu không nhấn được nút Stop
      }
      throw new DOMException("M365 Copilot turn aborted by client", "AbortError");
    }

    await new Promise(r => setTimeout(r, pollIntervalMs));
    attempts++;

    const pollRes = await runJsInBrowserTab(`
      (() => {
        const stopBtn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="Dừng"]');
        const isGenerating = !!stopBtn;

        const messages = Array.from(document.querySelectorAll(".fai-CopilotMessage"));
        const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
        let reply = "";
        let isNew = false;
        
        if (lastMsg) {
          const raw = lastMsg.innerText || "";
          if (raw !== ${escapedBefore} || isGenerating) {
            isNew = true;
            reply = raw.replace(/^Copilot said:\\s*/i, "").trim();
          }
        }

        return JSON.stringify({ isGenerating, reply, isNew });
      })()
    `);

    let status = { isGenerating: false, reply: "", isNew: false };
    try {
      status = JSON.parse(pollRes);
    } catch {
      continue;
    }

    if (status.isGenerating) {
      seenGenerating = true;
    }

    if (status.isNew && status.reply && status.reply !== previousText) {
      const delta = status.reply.slice(previousText.length);
      if (delta.length > 0) {
        onChunk(delta);
      }
      previousText = status.reply;
    }

    // Hoàn thành khi:
    // Đã thấy sinh mã (seenGenerating) và nút Stop đã biến mất, và đã nhận được nội dung
    // Hoặc sau 10 lần thử (~3s) mà không generating và đã có nội dung
    if ((seenGenerating || attempts > 10) && !status.isGenerating && previousText.length > 0) {
      break;
    }
  }

  return previousText;
}
