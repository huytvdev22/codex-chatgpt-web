import { connectLauncherBrowserHost, notifyLauncherTurn, readLauncherBrowserHostDescriptor } from "../../launcher-browser-host";
import { getConfigDir } from "../../config";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { m365HtmlToMarkdown } from "./markdown";

export interface M365BrowserRunOptions {
  onChunk: (text: string) => void;
  signal?: AbortSignal;
  descriptorPath?: string;
  traceId?: string;
  conversationKey?: string;
  isNewConversation?: boolean;
}

let activeM365ConversationKey: string | null = null;

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

  if (options.traceId) {
    try {
      await notifyLauncherTurn(descriptorPath, {
        phase: "start",
        traceId: options.traceId,
        helperPid: process.pid,
        conversationKey: options.conversationKey || "",
        connectorIdentity: "m365-copilot",
        requireRetainedConversation: false,
      }, undefined, options.signal);
    } catch {
      // Bỏ qua lỗi start nếu launcher chưa phản hồi
    }
  }

  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const m365SurfaceId = (descriptor as any).m365SurfaceId || descriptor.surfaceId;
  const connection = await connectLauncherBrowserHost(descriptorPath, 20_000, m365SurfaceId, options.signal);
  const { browser, page } = connection;
  let finalStatus: "completed" | "failed" | "aborted" = "failed";

  try {
    // 1. Kiểm tra URL, đảm bảo đang ở trang M365 Copilot
    const currentUrl = page.url();
    if (!currentUrl.includes("m365.cloud.microsoft")) {
      await page.goto("https://m365.cloud.microsoft/chat", { waitUntil: "domcontentloaded", timeout: 20_000 });
    }

    // 2. Nếu là cuộc hội thoại mới trên Codex, mở một phiên chat mới trên M365
    const shouldStartNewChat = options.isNewConversation || (
      options.conversationKey && activeM365ConversationKey && options.conversationKey !== activeM365ConversationKey
    );

    if (shouldStartNewChat) {
      await page.evaluate(() => {
        // Thử click nút "New chat" / "Cuộc trò chuyện mới"
        const newChatBtn = document.querySelector(
          'button[aria-label*="New chat" i], button[aria-label*="Cuộc trò chuyện mới" i], button[aria-label*="New topic" i], button[title*="New chat" i]'
        ) as HTMLButtonElement | null;
        if (newChatBtn) {
          newChatBtn.click();
          return;
        }

        // Hoặc tắt rồi bật lại Temporary Chat để làm mới phiên
        const tempBtn = document.querySelector('button[aria-label="Temporary chat"]') as HTMLButtonElement | null;
        if (tempBtn) {
          tempBtn.click();
          setTimeout(() => {
            if (tempBtn.getAttribute("aria-pressed") !== "true") {
              tempBtn.click();
            }
          }, 300);
        }
      }).catch(() => {});

      // Chờ giao diện ổn định sau khi kích hoạt new chat
      await new Promise(r => setTimeout(r, 600));
      activeM365ConversationKey = options.conversationKey || null;
    } else if (options.conversationKey) {
      activeM365ConversationKey = options.conversationKey;
    }

    // 3. Chờ khung nhập liệu xuất hiện
    const editorSelector = "#m365-chat-editor-target-element, div[contenteditable='true'], [role='textbox']";
    await page.waitForSelector(editorSelector, { timeout: 15_000 });

    // Đảm bảo Temporary Chat được bật nếu người dùng chưa bật
    await page.evaluate(() => {
      const tempBtn = document.querySelector('button[aria-label="Temporary chat"]') as HTMLButtonElement | null;
      if (tempBtn && tempBtn.getAttribute("aria-pressed") !== "true") {
        tempBtn.click();
      }
    }).catch(() => {});

    // Đọc số lượng và nội dung tin nhắn hiện tại trước khi gửi
    const beforeState = await page.evaluate(() => {
      const messages = Array.from(document.querySelectorAll(
        ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']"
      ));
      return {
        count: messages.length,
        lastHtml: messages.length > 0 ? (messages[messages.length - 1] as HTMLElement).innerHTML : "",
      };
    });

    // 4. Nhập prompt vào editor và kích hoạt nút Gửi
    await page.evaluate((text) => {
      const editor = (document.getElementById("m365-chat-editor-target-element") ||
        document.querySelector("div[contenteditable='true']") ||
        document.querySelector("[role='textbox']")) as HTMLElement;
      if (!editor) throw new Error("Không tìm thấy ô nhập liệu của M365 Copilot!");
      editor.focus();

      // Xoá nội dung cũ nếu có
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.execCommand("delete", false, undefined);

      // Chèn prompt
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
    }, promptText);

    // Chờ ngắn để React cập nhật trạng thái nút Gửi
    await new Promise(r => setTimeout(r, 250));

    // Thử click nút Send (.fai-SendButton / aria-label="Send")
    let sent = false;
    for (let i = 0; i < 5; i++) {
      sent = await page.evaluate(() => {
        const sendBtn = document.querySelector(
          '.fai-SendButton, button[aria-label="Send"], button[aria-label*="Send" i], button[aria-label*="Submit" i]'
        ) as HTMLButtonElement | null;
        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
          return true;
        }
        return false;
      });
      if (sent) break;
      await new Promise(r => setTimeout(r, 200));
    }

    // Nếu click chưa xong, fallback phím Enter native của CDP
    if (!sent) {
      await page.keyboard.press("Enter");
    }

    // 5. Polling theo dõi luồng sinh phản hồi của Copilot và stream về client
    let previousText = "";
    let seenGenerating = false;
    let attempts = 0;
    let stableCycles = 0;
    let lastTextChangeAt = Date.now();
    const maxAttempts = 480; // 480 * 250ms = 120 giây tối đa
    const pollIntervalMs = 250;

    while (attempts < maxAttempts) {
      if (options.signal?.aborted) {
        await page.evaluate(() => {
          const stopBtn = document.querySelector(
            'button[aria-label*="Stop" i], button[aria-label*="Dừng" i], button[aria-label="Stop generating"], [data-testid="stop-button"], button[aria-label*="Cancel" i]'
          ) as HTMLButtonElement | null;
          if (stopBtn) stopBtn.click();
        }).catch(() => {});
        throw new DOMException("M365 Copilot turn aborted by client", "AbortError");
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));
      attempts++;

      // Trích xuất HTML đã được làm sạch và chuẩn hóa khối code
      const status = await page.evaluate((before) => {
        const stopBtn = document.querySelector(
          'button[aria-label*="Stop" i], button[aria-label*="Dừng" i], button[aria-label="Stop generating"], [data-testid="stop-button"], button[aria-label*="Cancel" i]'
        );
        const editor = document.querySelector('#m365-chat-editor-target-element, div[contenteditable="true"], [role="textbox"]');
        const editorDisabled = editor?.getAttribute("aria-disabled") === "true";

        const messages = Array.from(document.querySelectorAll(
          ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']"
        ));
        
        // Nếu số lượng tin nhắn chưa tăng hoặc không có tin nhắn
        if (messages.length === 0) {
          return { isGenerating: Boolean(stopBtn), rawHtml: "", isNew: false, hasContent: false };
        }

        const lastMsg = messages[messages.length - 1] as HTMLElement;
        const hasShimmer = Boolean(lastMsg.querySelector('.fai-Shimmer, [class*="shimmer" i], .fai-StatusMessage, .fai-BebopMessageStatus'));
        const isGenerating = Boolean(stopBtn) || hasShimmer || editorDisabled;

        // Chỉ lấy thẻ content chứa câu trả lời thực sự của Copilot
        const contentEl = (lastMsg.querySelector(".fai-CopilotMessage__content, [data-content='content'], .fui-ChatMessage__body, .fai-ChatMessage__content") || lastMsg) as HTMLElement;

        // 1. Quét các khối code trên LIVE DOM trước khi clone để lấy chính xác text (có newline + indent) và language
        const codeBlockSelectors = ".scriptor-component-code-block, [class*='scriptor-component-code-block'], div[role='group'][aria-label='Code Preview']";
        const liveCodeBlocks = Array.from(contentEl.querySelectorAll(codeBlockSelectors));
        const codeData = liveCodeBlocks.map(block => {
          const langEl = block.querySelector("[data-testid='one-copilot-code-identity'] span, [class*='code-identity' i] span");
          let lang = langEl?.textContent?.trim().toLowerCase() || "";
          if (lang === "plain text" || lang === "text") lang = "plain";

          const findRoot = block.querySelector("[data-virtualized-code-find-root='true']") || block.lastElementChild;
          const codeText = (findRoot ? (findRoot as HTMLElement).innerText : (block as HTMLElement).innerText || "").replace(/^\n+|\n+$/g, "");
          return { lang, codeText };
        });

        // 2. Clone content element để thao tác dọn dẹp
        const clone = contentEl.cloneNode(true) as HTMLElement;

        // Thay thế các code block trong clone bằng cấu trúc pre/code chuẩn markdown
        const clonedCodeBlocks = Array.from(clone.querySelectorAll(codeBlockSelectors));
        clonedCodeBlocks.forEach((block, idx) => {
          const data = codeData[idx];
          if (!data) return;

          const pre = document.createElement("pre");
          const code = document.createElement("code");
          if (data.lang) {
            code.className = `language-${data.lang}`;
          }
          code.textContent = data.codeText;
          pre.appendChild(code);
          block.replaceWith(pre);
        });

        // Hỗ trợ nếu có thẻ pre thông thường
        clone.querySelectorAll("pre").forEach(pre => {
          if (!pre.querySelector("code")) {
            const code = document.createElement("code");
            code.textContent = pre.textContent || "";
            pre.textContent = "";
            pre.appendChild(code);
          }
        });

        // 3. Xoá toàn bộ status, progress, buttons, toolbar, svg và heading Copilot said thừa
        clone.querySelectorAll(
          "[role='status'], [role='progressbar'], .fai-Shimmer, [class*='shimmer' i], .fai-StatusMessage, .fai-BebopMessageStatus, [role='toolbar'], .fai-CopilotMessage__actions, .fai-CopilotMessage__accessibleHeading, button, svg"
        ).forEach(el => el.remove());

        // Loại bỏ các đoạn text status nếu còn sót trong các thẻ div/span
        const statusPhrases = [
          "taking a look",
          "getting things ready",
          "digging in",
          "working on it",
          "searching the web",
          "searching work data",
          "searching",
          "thinking",
          "generating response",
          "đang xem xét",
          "đang chuẩn bị",
          "đang tìm kiếm",
          "đang đào sâu",
          "đang xử lý",
          "đang suy nghĩ",
        ];
        clone.querySelectorAll("div, span, p").forEach(el => {
          const text = el.textContent?.trim().toLowerCase() || "";
          for (const phrase of statusPhrases) {
            if (text.startsWith(phrase) && text.length < phrase.length + 35) {
              el.remove();
              break;
            }
          }
        });

        const rawHtml = clone.innerHTML || "";
        const hasContent = (clone.textContent || "").trim().length > 0;
        const isNew = (messages.length > before.count) || (rawHtml !== before.lastHtml) || isGenerating;
        return { isGenerating, rawHtml, isNew, hasContent };
      }, beforeState);

      if (status.isGenerating) {
        seenGenerating = true;
      }

      if (options.traceId && attempts % 40 === 0) { // Cứ mỗi 10 giây gửi heartbeat
        notifyLauncherTurn(descriptorPath, {
          phase: "heartbeat",
          traceId: options.traceId,
          helperPid: process.pid,
          refreshViewport: false,
        }, undefined, options.signal).catch(() => {});
      }

      if (status.hasContent && status.rawHtml) {
        // Chuyển đổi HTML sang Markdown chuẩn bằng logic kế thừa từ ChatGPT
        const currentMarkdown = m365HtmlToMarkdown(status.rawHtml);

        // Bỏ qua nếu nội dung chỉ là thinking indicator hoặc text rác
        const isOnlyStatus = /^(?:Taking a look|Getting things ready|Digging in|Working on it|Searching the web|Searching work data|Searching|Thinking|Generating response|Đang xem xét|Đang chuẩn bị|Đang tìm kiếm|Đang đào sâu|Đang xử lý|Đang suy nghĩ|Đang tạo câu trả lời)[.…\s]*$/i.test(currentMarkdown);

        // Chỉ stream khi đã có nội dung trả lời thực sự
        if (!isOnlyStatus && currentMarkdown) {
          if (currentMarkdown !== previousText) {
            lastTextChangeAt = Date.now();
            stableCycles = 0;

            if (!previousText) {
              options.onChunk(currentMarkdown);
              previousText = currentMarkdown;
            } else if (currentMarkdown.startsWith(previousText)) {
              const delta = currentMarkdown.slice(previousText.length);
              if (delta.length > 0) {
                options.onChunk(delta);
              }
              previousText = currentMarkdown;
            } else if (currentMarkdown.length > previousText.length) {
              let matchLen = 0;
              while (matchLen < previousText.length && matchLen < currentMarkdown.length && previousText[matchLen] === currentMarkdown[matchLen]) {
                matchLen++;
              }
              const delta = currentMarkdown.slice(matchLen);
              if (delta.length > 0) {
                options.onChunk(delta);
              }
              previousText = currentMarkdown;
            }
          } else {
            stableCycles++;
          }
        }
      }

      // Điều kiện kết thúc:
      // 1. Phải có nội dung trả lời (previousText.length > 0)
      // 2. Không còn đang sinh (!status.isGenerating)
      // 3. Nội dung văn bản đã hoàn toàn ổn định (không thay đổi trong ít nhất 1.5 giây = 6 nhịp)
      const isSettled = stableCycles >= 6 || (Date.now() - lastTextChangeAt >= 1500);
      if (previousText.length > 0 && !status.isGenerating && isSettled) {
        break;
      }
    }

    finalStatus = "completed";
    return previousText;
  } catch (err) {
    if (options.signal?.aborted) finalStatus = "aborted";
    throw err;
  } finally {
    if (options.traceId) {
      notifyLauncherTurn(descriptorPath, {
        phase: "end",
        traceId: options.traceId,
        helperPid: process.pid,
        status: finalStatus,
        retain: true,
      }).catch(() => {});
    }
    await browser.close().catch(() => {});
  }
}
