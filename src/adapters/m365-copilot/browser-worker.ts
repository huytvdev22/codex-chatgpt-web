import { connectLauncherBrowserHost } from "../../launcher-browser-host";
import { getConfigDir } from "../../config";
import { join } from "node:path";
import { existsSync } from "node:fs";

export interface M365BrowserRunOptions {
  onChunk: (text: string) => void;
  signal?: AbortSignal;
  descriptorPath?: string;
}

function resolveDescriptorPath(customPath?: string): string {
  if (customPath && existsSync(customPath)) return customPath;
  const home = process.env.CODEX_CHATGPT_WEB_HOME || getConfigDir();
  return join(home, "runtime", "launcher-browser.json");
}

/**
 * Thực thi một lượt hội thoại với Microsoft 365 Copilot nhúng trong Launcher Desktop
 * Cơ chế: Kết nối Playwright CDP trực tiếp vào WebContentsView của Launcher (không mở tab ngoài, không AppleScript)
 */
export async function executeM365Turn(
  promptText: string,
  options: M365BrowserRunOptions
): Promise<string> {
  const descriptorPath = resolveDescriptorPath(options.descriptorPath);
  if (!existsSync(descriptorPath)) {
    throw new Error(
      `Không tìm thấy runtime descriptor của Launcher tại: ${descriptorPath}. Vui lòng đảm bảo ứng dụng Codex M365 Copilot Desktop đang mở!`
    );
  }

  const connection = await connectLauncherBrowserHost(descriptorPath, 20_000, undefined, options.signal);
  const { browser, page } = connection;

  try {
    // 1. Kiểm tra URL, đảm bảo đang ở trang M365 Copilot
    const currentUrl = page.url();
    if (!currentUrl.includes("m365.cloud.microsoft")) {
      await page.goto("https://m365.cloud.microsoft/chat", { waitUntil: "domcontentloaded", timeout: 20_000 });
    }

    // 2. Chờ khung nhập liệu xuất hiện
    const editorSelector = "#m365-chat-editor-target-element, div[contenteditable='true'], [role='textbox']";
    await page.waitForSelector(editorSelector, { timeout: 12_000 });

    // 3. Đọc nội dung tin nhắn cuối cùng trước khi gửi
    const lastContentBefore = await page.evaluate(() => {
      const messages = Array.from(document.querySelectorAll(".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage"));
      if (messages.length === 0) return "";
      const last = messages[messages.length - 1] as HTMLElement;
      return last.innerText || "";
    });

    // 4. Nhập prompt vào editor và kích hoạt nút Gửi
    const submitSuccess = await page.evaluate((text) => {
      const editor = (document.getElementById("m365-chat-editor-target-element") ||
        document.querySelector("div[contenteditable='true']") ||
        document.querySelector("[role='textbox']")) as HTMLElement;
      if (!editor) return false;
      editor.focus();

      // Xoá nội dung cũ nếu có
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.execCommand("delete", false, undefined);

      // Chèn prompt qua sự kiện paste
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));

      // Tìm và click nút Gửi
      const sendBtn = (document.querySelector('button[aria-label*="Submit"], button[aria-label*="Send"], button[aria-label*="Gửi"], [data-testid="send-button"]') ||
        editor.closest("form")?.querySelector("button[type='submit']")) as HTMLButtonElement;
      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
        return true;
      }

      // Fallback: Dispatch phím Enter
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      return true;
    }, promptText);

    if (!submitSuccess) {
      throw new Error("Không thể gửi prompt vào ô nhập liệu M365 Copilot trên ứng dụng Desktop!");
    }

    // 5. Polling theo dõi luồng sinh phản hồi của Copilot và stream về client
    let previousText = "";
    let seenGenerating = false;
    let attempts = 0;
    const maxAttempts = 320; // 320 * 250ms = 80 giây tối đa
    const pollIntervalMs = 250;

    while (attempts < maxAttempts) {
      if (options.signal?.aborted) {
        await page.evaluate(() => {
          const stopBtn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="Dừng"]') as HTMLButtonElement;
          if (stopBtn) stopBtn.click();
        }).catch(() => {});
        throw new DOMException("M365 Copilot turn aborted by client", "AbortError");
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));
      attempts++;

      const status = await page.evaluate((before) => {
        const stopBtn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="Dừng"]');
        const isGenerating = Boolean(stopBtn);
        const messages = Array.from(document.querySelectorAll(".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage"));
        const lastMsg = messages.length > 0 ? (messages[messages.length - 1] as HTMLElement) : null;
        let reply = "";
        let isNew = false;
        if (lastMsg) {
          const raw = lastMsg.innerText || "";
          if (raw !== before || isGenerating) {
            isNew = true;
            reply = raw.replace(/^Copilot said:\s*/i, "").trim();
          }
        }
        return { isGenerating, reply, isNew };
      }, lastContentBefore);

      if (status.isGenerating) {
        seenGenerating = true;
      }

      if (status.isNew && status.reply && status.reply !== previousText) {
        const delta = status.reply.slice(previousText.length);
        if (delta.length > 0) {
          options.onChunk(delta);
        }
        previousText = status.reply;
      }

      // Điều kiện kết thúc:
      // Đã thấy sinh mã (seenGenerating) và nút Stop biến mất, và đã có phản hồi
      // Hoặc đã qua hơn 10 nhịp kiểm tra (~2.5s) mà không thấy generating và đã có nội dung
      if ((seenGenerating || attempts > 10) && !status.isGenerating && previousText.length > 0) {
        break;
      }
    }

    return previousText;
  } finally {
    await browser.close().catch(() => {});
  }
}
