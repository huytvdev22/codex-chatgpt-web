import { connectLauncherBrowserHost, notifyLauncherTurn, readLauncherBrowserHostDescriptor } from "../../launcher-browser-host";
import { getConfigDir } from "../../config";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { m365HtmlToMarkdown, M365MarkdownBuffer, type M365MarkdownBlock } from "./markdown";

export interface M365BrowserRunOptions {
  onChunk: (text: string) => void;
  signal?: AbortSignal;
  descriptorPath?: string;
  traceId?: string;
  conversationKey?: string;
  isNewConversation?: boolean;
  shouldStop?: () => boolean;
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
        // Thử click nút "New chat" / "Cuộc trò chuyện mới" (hỗ trợ cả thẻ a và button)
        const newChatBtn = document.querySelector(
          'a[aria-label*="New chat" i], button[aria-label*="New chat" i], [aria-label*="New chat" i], [aria-label*="Cuộc trò chuyện mới" i], [aria-label*="New topic" i], [title*="New chat" i]'
        ) as HTMLElement | null;
        if (newChatBtn) {
          newChatBtn.click();
          newChatBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
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

    // 5. Polling theo dõi luồng sinh phản hồi của Copilot và stream về client theo cơ chế Semantic Block Buffering
    const markdownBuffer = new M365MarkdownBuffer();
    let seenGenerating = false;
    let attempts = 0;
    let stableCycles = 0;
    let lastTextChangeAt = Date.now();
    let lastBlocks: M365MarkdownBlock[] = [];
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

      if (options.shouldStop?.()) {
        break;
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));
      attempts++;

      // Trích xuất các khối ngữ nghĩa (Semantic Blocks) đã được làm sạch và chuẩn hóa khối code
      const status = await page.evaluate((before) => {
        const stopBtn = document.querySelector(
          'button[aria-label*="Stop" i], button[aria-label*="Dừng" i], button[aria-label="Stop generating"], [data-testid="stop-button"], button[aria-label*="Cancel" i]'
        );
        const editor = document.querySelector('#m365-chat-editor-target-element, div[contenteditable="true"], [role="textbox"]');
        const editorDisabled = editor?.getAttribute("aria-disabled") === "true";

        const messages = Array.from(document.querySelectorAll(
          ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']"
        ));
        
        if (messages.length === 0) {
          return { isGenerating: Boolean(stopBtn), blocks: [], isNew: false, hasContent: false };
        }

        const lastMsg = messages[messages.length - 1] as HTMLElement;
        // Chú ý: KHÔNG dùng .fai-StatusMessage hay .fai-BebopMessageStatus vì đây là status card tồn tại vĩnh viễn trong DOM sau khi Copilot tìm kiếm xong!
        // Chỉ dùng shimmer thực sự (đang animate loading) hoặc role="progressbar"
        const hasActiveShimmer = Boolean(lastMsg.querySelector('.fai-Shimmer, [class*="shimmer" i]:not(.fai-StatusMessage):not(.fai-BebopMessageStatus), [role="progressbar"]'));
        const isGenerating = Boolean(stopBtn) || editorDisabled || hasActiveShimmer;

        // Ưu tiên cao nhất: lấy markdown-reply có type="Chat" hoặc có text (bỏ qua thẻ Progress rỗng)
        const markdownReplies = Array.from(lastMsg.querySelectorAll('[data-testid="markdown-reply"]')) as HTMLElement[];
        const replyEl = markdownReplies.find(el => el.getAttribute("data-message-type") === "Chat" && el.textContent?.trim())
          || markdownReplies.reverse().find(el => el.textContent?.trim()) || null;
        const contentEl = replyEl || (lastMsg.querySelector(".fai-CopilotMessage__content, [data-content='content'], .fui-ChatMessage__body, .fai-ChatMessage__content") || lastMsg) as HTMLElement;

        // 1. Quét các khối code trên LIVE DOM trước khi clone để lấy chính xác text (có newline + indent) và language
        // Chỉ chọn container ngoài cùng của mỗi khối code (tránh lặp cả div[role='group'] lẫn thẻ con .scriptor-component-code-block)
        const codeBlockQuery = "div[role='group'][aria-label='Code Preview'], .scriptor-component-code-block, [class*='scriptor-component-code-block']";
        const allLiveCodeElements = Array.from(contentEl.querySelectorAll(codeBlockQuery)) as HTMLElement[];
        const liveCodeBlocks = allLiveCodeElements.filter((el, _, all) => !all.some(other => other !== el && other.contains(el)));

        const codeData = liveCodeBlocks.map(block => {
          const langEl = block.querySelector("[data-testid='one-copilot-code-identity'] span, [class*='code-identity' i] span");
          let lang = langEl?.textContent?.trim().toLowerCase() || "";
          if (lang === "plain text" || lang === "text") lang = "plain";

          // Lấy chính xác code từ các thẻ data-line-index
          const lineEls = Array.from(block.querySelectorAll("[data-line-index]"));
          let codeText = "";
          if (lineEls.length > 0) {
            codeText = lineEls.map(el => (el.textContent || "").replace(/\u00a0/g, " ")).join("\n");
          } else {
            const findRoot = block.querySelector("[data-virtualized-code-find-root='true'], [role='textbox'][aria-label*='Code editor' i]") || block.lastElementChild;
            codeText = (findRoot ? (findRoot as HTMLElement).innerText : (block as HTMLElement).innerText || "").replace(/\u00a0/g, " ");
          }
          codeText = codeText.replace(/^\n+|\n+$/g, "");
          return { lang, codeText };
        });

        // 2. Clone content element để thao tác dọn dẹp
        const clone = contentEl.cloneNode(true) as HTMLElement;

        // Thay thế các code block trong clone bằng cấu trúc pre/code chuẩn markdown
        const allClonedCodeElements = Array.from(clone.querySelectorAll(codeBlockQuery)) as HTMLElement[];
        const clonedCodeBlocks = allClonedCodeElements.filter((el, _, all) => !all.some(other => other !== el && other.contains(el)));

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

          // Chỉ thay thế đúng chính phần tử container khối code, TUYỆT ĐỐI không thay thế parentElement!
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

        // Nếu không có replyEl (fallback), lọc các cụm từ status nếu còn sót trong các thẻ div/span
        if (!replyEl) {
          const statusPhrases = [
            "checking that now", "taking a look", "getting things ready", "digging in",
            "working on it", "searching the web", "searching work data", "searching",
            "thinking", "generating response", "putting it together", "putting things together",
            "gathering thoughts", "looking through your files",
            "đang xem xét", "đang kiểm tra", "đang chuẩn bị", "đang tìm kiếm",
            "đang đào sâu", "đang xử lý", "đang suy nghĩ", "đang tạo câu trả lời", "đang tổng hợp"
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
        }

        // 4. Phân rã thành các Semantic Blocks bảo toàn 100% Text Nodes và thẻ <br>
        const blockTags = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "code", "ul", "ol", "hr", "blockquote", "table"]);
        const rawBlocks: Array<{ tag: string; html: string; text: string }> = [];
        const inlineNodes: Node[] = [];

        function flushInline() {
          if (inlineNodes.length === 0) return;
          const temp = document.createElement("p");
          for (const n of inlineNodes) {
            temp.appendChild(n.cloneNode(true));
          }
          inlineNodes.length = 0;
          const text = temp.textContent?.trim() || "";
          if (text.length > 0) {
            rawBlocks.push({
              tag: "p",
              html: temp.outerHTML,
              text,
            });
          }
        }

        function processNode(node: Node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as HTMLElement;
            const tag = el.tagName.toLowerCase();
            if (blockTags.has(tag)) {
              flushInline();
              const text = el.textContent?.trim() || "";
              if (text.length > 0 || tag === "hr") {
                // Bảo toàn thẻ code độc lập để parser nhận diện chính xác
                const html = tag === "code" ? `<pre>${el.outerHTML}</pre>` : el.outerHTML;
                rawBlocks.push({
                  tag: tag === "code" ? "pre" : tag,
                  html,
                  text,
                });
              }
              return;
            }
            // Nếu là thẻ div/section chứa các block con, duyệt sâu vào các con
            const hasNestedBlocks = Boolean(el.querySelector(Array.from(blockTags).join(",")));
            if (hasNestedBlocks) {
              flushInline();
              Array.from(el.childNodes).forEach(child => processNode(child));
              flushInline();
              return;
            }
          }
          // Mọi node khác (Text node, <br>, <span>, <strong>, <a>...) gom vào inlineNodes
          inlineNodes.push(node);
        }

        Array.from(clone.childNodes).forEach(child => processNode(child));
        flushInline();

        const allStatusPhrases = [
          "checking that now", "taking a look", "getting things ready", "digging in",
          "working on it", "searching the web", "searching work data", "searching",
          "thinking", "generating response", "putting it together", "putting things together",
          "gathering thoughts", "looking through your files",
          "đang xem xét", "đang kiểm tra", "đang chuẩn bị", "đang tìm kiếm",
          "đang đào sâu", "đang xử lý", "đang suy nghĩ", "đang tạo câu trả lời", "đang tổng hợp"
        ];

        const filteredBlocks = rawBlocks.filter(b => {
          const t = b.text.trim().toLowerCase();
          const isStatus = allStatusPhrases.some(sp => t.startsWith(sp) && t.length < sp.length + 35);
          return (b.text.length > 0 && !isStatus) || b.tag === "hr";
        });

        // Sinh khóa Block ổn định (Semantic Signature Key) chống nhảy lệch offset và chống lặp tiêu đề
        const signatureOccurrences = new Map<string, number>();
        const blocks = filteredBlocks.map((b, idx) => {
          const snippet = b.text.trim().slice(0, 50).replace(/\s+/g, " ");
          const signature = `${b.tag}::${snippet}`;
          const occurrence = (signatureOccurrences.get(signature) || 0) + 1;
          signatureOccurrences.set(signature, occurrence);
          const stableKey = `${signature}#${occurrence}`;

          return {
            key: stableKey,
            tag: b.tag,
            html: b.html,
            text: b.text,
            streamable: idx < filteredBlocks.length - 1, // Khối đã hoàn tất vì đã xuất hiện khối kế tiếp
          };
        });

        const rawHtml = clone.innerHTML || "";
        const hasContent = blocks.length > 0;
        const isNew = (messages.length > before.count) || isGenerating;
        return { isGenerating, blocks, rawHtml, isNew, hasContent };
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

      // Stream các khối đã hoàn thành thông qua M365MarkdownBuffer
      if (status.blocks && status.blocks.length > 0) {
        lastBlocks = status.blocks as M365MarkdownBlock[];
        const delta = markdownBuffer.observe(lastBlocks);
        if (delta.length > 0) {
          options.onChunk(delta);
          lastTextChangeAt = Date.now();
          stableCycles = 0;
        } else {
          stableCycles++;
        }
      }

      // Điều kiện kết thúc:
      // 1. Phải có nội dung trả lời (hasContent)
      // 2. Không còn đang sinh (!status.isGenerating)
      // 3. Nội dung văn bản đã ổn định (ít nhất 4 nhịp = 1.0 giây không đổi text)
      const isSettled = stableCycles >= 4 || (Date.now() - lastTextChangeAt >= 1000);
      if (status.hasContent && !status.isGenerating && isSettled) {
        console.log(`[m365-worker] [settled] attempts=${attempts} durationMs=${attempts * pollIntervalMs}`);
        break;
      }
    }

    // Kết thúc lượt sinh: Flush toàn bộ các khối còn lại (bao gồm khối cuối cùng)
    const { delta: finalDelta, markdown: fullMarkdown } = markdownBuffer.finish(lastBlocks);
    if (finalDelta.length > 0 && !options.shouldStop?.()) {
      options.onChunk(finalDelta);
    }

    finalStatus = "completed";
    console.log(`[m365-worker] [completed] totalChars=${fullMarkdown.length} finalStatus=${finalStatus}`);
    return fullMarkdown;
  } catch (err) {
    if (options.signal?.aborted) {
      finalStatus = "aborted";
      console.log(`[m365-worker] [aborted] turn aborted by client`);
    } else {
      console.error(`[m365-worker] [error]`, err);
    }
    throw err;
  } finally {
    if (options.traceId) {
      const notifyPromise = notifyLauncherTurn(descriptorPath, {
        phase: "end",
        traceId: options.traceId,
        helperPid: process.pid,
        status: finalStatus,
        retain: true,
      }).catch(() => {});
      await withTimeout(notifyPromise, 2000, undefined);
    }
    console.log(`[m365-worker] [cleanup] closing browser connection (timeout 3000ms)...`);
    await withTimeout(browser.close().catch(() => {}), 3000, undefined);
    console.log(`[m365-worker] [cleanup] browser closed`);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
