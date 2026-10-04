import { connectLauncherBrowserHost, notifyLauncherTurn, readLauncherBrowserHostDescriptor } from "../../launcher-browser-host";
import { getConfigDir } from "../../config";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { m365HtmlToMarkdown, M365MarkdownBuffer, type M365MarkdownBlock } from "./markdown";
import { FastPathStreamBuffer } from "./temp-chat/fastPathScraper";
import { ensureM365CapabilityMode } from "./capability-picker";
import { resolveM365CapabilityMode } from "../../m365-models";
import { emitStructuredEvent } from "../../observability/emitter";
import { logDebugPipelineStation } from "../../observability/debug-logger";
import type { TraceContext } from "../../observability/types";

export interface M365BrowserRunOptions {
  onChunk: (text: string) => void;
  signal?: AbortSignal;
  descriptorPath?: string;
  traceId?: string;
  conversationKey?: string;
  isNewConversation?: boolean;
  shouldStop?: () => boolean;
  modelSlug?: string;
  traceContext?: TraceContext;
  forceTemporaryChat?: boolean;
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
  const startTime = Date.now();

  emitStructuredEvent({
    level: "info",
    event: "m365.provider.started",
    traceContext: options.traceContext,
    safeDetails: {
      provider: "m365-copilot",
      modelSlug: options.modelSlug,
      isNewConversation: Boolean(options.isNewConversation),
      injectedPromptPreview: promptText,
      rawPrompt: promptText,
      promptBytes: Buffer.byteLength(promptText, "utf8"),
    },
    diagnosticDetails: {
      promptBytes: Buffer.byteLength(promptText, "utf8"),
    },
  });

  // [DEBUG PIPELINE] STEP 2: Bridge Server ➔ M365 Copilot Web (RAW INJECTED PROMPT)
  logDebugPipelineStation(2, "BRIDGE SERVER ➔ M365 COPILOT WEB (RAW INJECTED PROMPT)", promptText);

  try {
    // 1. Kiểm tra URL, đảm bảo đang ở trang M365 Copilot
    const currentUrl = page.url();
    if (!currentUrl.includes("m365.cloud.microsoft")) {
      await page.goto("https://m365.cloud.microsoft/chat", { waitUntil: "domcontentloaded", timeout: 20_000 });
    }

    // 2. Kiểm tra chế độ Temporary Chat Per Request
    const isTemporaryMode = Boolean(options.forceTemporaryChat || descriptor.m365TemporaryChatPerRequest);
    const shouldStartNewChat = isTemporaryMode || options.isNewConversation || (
      options.conversationKey && activeM365ConversationKey && options.conversationKey !== activeM365ConversationKey
    );

    console.log(`[m365-worker] Trạng thái phiên: isTemporaryMode=${isTemporaryMode}, shouldStartNewChat=${shouldStartNewChat}`);

    if (shouldStartNewChat) {
      // 2.1. Nếu URL đang lưu thread cũ (/chat/c/...), điều hướng thẳng về /chat để mở phiên trắng
      if (page.url().includes("/chat/c/")) {
        console.log(`[m365-worker] Điều hướng về /chat từ thread cũ: ${page.url()}`);
        await page.goto("https://m365.cloud.microsoft/chat", { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => { });
        await new Promise(r => setTimeout(r, 400));
      }

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
        const tempBtn = document.querySelector('button[aria-label*="Temporary chat" i], button[aria-label*="Cuộc trò chuyện tạm thời" i]') as HTMLButtonElement | null;
        if (tempBtn) {
          tempBtn.click();
          setTimeout(() => {
            if (tempBtn.getAttribute("aria-pressed") !== "true") {
              tempBtn.click();
            }
          }, 200);
        }
      }).catch(() => { });

      // Chờ giao diện ổn định sau khi kích hoạt new chat
      await new Promise(r => setTimeout(r, 400));

      // Bật Temporary Chat nếu ở chế độ Temporary Mode
      if (isTemporaryMode) {
        await page.evaluate(() => {
          const tempBtn = document.querySelector(
            'button[aria-label*="Temporary chat" i], button[aria-label*="Cuộc trò chuyện tạm thời" i]'
          ) as HTMLButtonElement | null;
          if (tempBtn && tempBtn.getAttribute("aria-pressed") !== "true") {
            tempBtn.click();
            tempBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          }
        }).catch(() => { });
        await new Promise(r => setTimeout(r, 300));
      }

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
    }).catch(() => { });

    // 3.1. Đảm bảo model mong muốn (Capability Mode) được chọn trên giao diện M365 Copilot
    if (options.modelSlug) {
      const targetMode = resolveM365CapabilityMode(options.modelSlug);
      await ensureM365CapabilityMode(page, targetMode).catch(err => {
        console.warn(`[m365-worker] Warning: Failed to ensure capability mode '${targetMode}':`, err);
      });
    }

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
      // Reset cache tích lũy dòng code của lượt trước
      delete (window as any).__m365_code_lines_cache;
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
    const fastPathBuffer = new FastPathStreamBuffer();
    let fastPathActive = false;
    let lastFastPathText = "";
    let seenGenerating = false;
    let attempts = 0;
    let stableCycles = 0;
    let lastTextChangeAt = Date.now();
    let lastBlocks: M365MarkdownBlock[] = [];
    const maxAttempts = 2400; // 2400 * 250ms = 600 giây (10 phút) tối đa
    const pollIntervalMs = 250;

    while (attempts < maxAttempts) {
      if (options.signal?.aborted) {
        await page.evaluate(() => {
          const stopBtn = document.querySelector(
            'button[aria-label*="Stop" i], button[aria-label*="Dừng" i], button[aria-label="Stop generating"], [data-testid="stop-button"], button[aria-label*="Cancel" i]'
          ) as HTMLButtonElement | null;
          if (stopBtn) stopBtn.click();
        }).catch(() => { });
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

        // Quét thông báo lỗi hệ thống hoặc quota từ M365 Web
        let detectedWebError = "";
        const errorEl = document.querySelector(
          '[data-testid="error-message"], .fai-ErrorMessage, [role="alert"], [class*="errorMessage" i], [class*="error-banner" i]'
        );
        if (errorEl && errorEl.textContent?.trim()) {
          const errText = errorEl.textContent.trim();
          if (/something went wrong|try again|reached the limit|limit exceeded|đã xảy ra lỗi|vượt quá giới hạn/i.test(errText)) {
            detectedWebError = errText;
          }
        }

        if (messages.length === 0) {
          return { isGenerating: Boolean(stopBtn), blocks: [], isNew: false, hasContent: false, detectedWebError };
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

        // Kiểm tra Monaco model trực tiếp trên window nếu có
        let monacoModelsText: string[] = [];
        try {
          const win = window as any;
          const models = win.monaco?.editor?.getModels?.();
          if (Array.isArray(models) && models.length > 0) {
            monacoModelsText = models.map((m: any) => typeof m.getValue === "function" ? m.getValue() : "").filter(Boolean);
          }
        } catch { }

        // Khởi tạo bộ nhớ đệm tích lũy dòng code theo data-line-index trên window để chống mất dòng khi virtual scrolling
        const win = window as any;
        if (!win.__m365_code_lines_cache) {
          win.__m365_code_lines_cache = new Map<number, string>();
        }

        const codeData = liveCodeBlocks.map((block, blockIdx) => {
          const langEl = block.querySelector("[data-testid='one-copilot-code-identity'] span, [class*='code-identity' i] span");
          let lang = langEl?.textContent?.trim().toLowerCase() || "";
          if (lang === "plain text" || lang === "text") lang = "plain";

          // Lấy chính xác code từ các thẻ data-line-index
          const lineEls = Array.from(block.querySelectorAll("[data-line-index]"));
          let codeText = "";
          if (lineEls.length > 0) {
            // Tích lũy các dòng vào cache trên window theo line index
            lineEls.forEach((el) => {
              const idxAttr = el.getAttribute("data-line-index");
              if (idxAttr !== null) {
                const idx = parseInt(idxAttr, 10);
                if (!isNaN(idx)) {
                  win.__m365_code_lines_cache.set(idx, (el.textContent || "").replace(/\u00a0/g, " "));
                }
              }
            });

            // Ghép lại toàn bộ các dòng từ dòng 0 đến dòng lớn nhất từng thấy
            const keys = Array.from(win.__m365_code_lines_cache.keys()) as number[];
            if (keys.length > 0) {
              const maxIdx = Math.max(...keys);
              const assembled: string[] = [];
              for (let i = 0; i <= maxIdx; i++) {
                assembled.push(win.__m365_code_lines_cache.get(i) ?? "");
              }
              codeText = assembled.join("\n");
            } else {
              codeText = lineEls.map(el => (el.textContent || "").replace(/\u00a0/g, " ")).join("\n");
            }
          } else {
            const findRoot = block.querySelector("[data-virtualized-code-find-root='true'], [role='textbox'][aria-label*='Code editor' i]") || block.lastElementChild;
            codeText = (findRoot ? (findRoot as HTMLElement).innerText : (block as HTMLElement).innerText || "").replace(/\u00a0/g, " ");
          }

          // Ưu tiên Monaco model nếu model có nội dung dài hơn hoặc hoàn chỉnh hơn
          if (monacoModelsText[blockIdx] && monacoModelsText[blockIdx].length >= codeText.length) {
            codeText = monacoModelsText[blockIdx];
          }

          codeText = codeText.replace(/^\n+|\n+$/g, "");
          return { lang, codeText };
        });

        // Fast-Path: Nhận diện khối Markdown/plain code block từ Scriptor Editor
        let fastPathRawText: string | null = null;
        if (codeData.length === 1) {
          const lang = codeData[0].lang;
          if (!lang || lang === "markdown" || lang === "md" || lang === "plain") {
            fastPathRawText = codeData[0].codeText;
          }
        } else if (codeData.length > 1) {
          const mdBlock = codeData.find(b => b.lang === "markdown" || b.lang === "md");
          if (mdBlock) {
            fastPathRawText = mdBlock.codeText;
          }
        }

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
        const hasContent = blocks.length > 0 || Boolean(fastPathRawText && fastPathRawText.length > 0);
        const isNew = (messages.length > before.count) || isGenerating;
        return { isGenerating, blocks, rawHtml, isNew, hasContent, detectedWebError, fastPathRawText };
      }, beforeState);

      // Nếu phát hiện lỗi giao diện web của M365 (quota, session hết hạn, error banner), ném lỗi ngay
      if (status.detectedWebError) {
        throw new Error(`[M365 Web Error] ${status.detectedWebError}`);
      }

      if (status.isGenerating) {
        seenGenerating = true;
      }

      // Cảnh báo nếu sau 20s gửi tin nhắn mà M365 chưa có phản hồi nào
      if (attempts === 80 && !seenGenerating && status.blocks.length === 0) {
        console.warn(`[m365-worker] [warning] Sau 20s vẫn chưa nhận được phản hồi từ M365 (có thể nút Gửi chưa được kích hoạt hoặc mạng chậm).`);
      }

      if (options.traceId && attempts % 40 === 0) { // Cứ mỗi 10 giây gửi heartbeat tới launcher
        notifyLauncherTurn(descriptorPath, {
          phase: "heartbeat",
          traceId: options.traceId,
          helperPid: process.pid,
          refreshViewport: false,
        }, undefined, options.signal).catch(() => { });
      }

      // Định kỳ cuộn trang xuống đáy để kích thích trình duyệt render DOM liên tục
      if (attempts % 4 === 0) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      }

      // Stream các khối đã hoàn thành: Ưu tiên Fast-Path nếu đang ở chế độ Temporary Mode
      if (isTemporaryMode && typeof status.fastPathRawText === "string") {
        fastPathActive = true;
        lastFastPathText = status.fastPathRawText;
        const delta = fastPathBuffer.observe(lastFastPathText);
        if (delta.length > 0) {
          options.onChunk(delta);
          lastTextChangeAt = Date.now();
          stableCycles = 0;
        } else {
          stableCycles++;
        }
      } else if (!isTemporaryMode && status.blocks && status.blocks.length > 0) {
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

      // Định kỳ mỗi ~4 giây (16 chu kỳ) phát log tiến độ chi tiết để theo dõi trạng thái sống (Liveness)
      if (attempts % 16 === 0) {
        const elapsedSec = Math.round((attempts * pollIntervalMs) / 1000);
        const currentChars = fastPathActive ? lastFastPathText.length : lastBlocks.reduce((acc, b) => acc + b.text.length, 0);
        const stableSec = Math.round((Date.now() - lastTextChangeAt) / 1000);
        const combinedTextSoFar = fastPathActive ? lastFastPathText : lastBlocks.map(b => b.text).join(" ");
        const unclosedToolCall = /(?:<|\b)\s*tool\\\\?_call\s*>/i.test(combinedTextSoFar) && !/(?:<\s*\/|\/\s*)tool\\\\?_call\s*>/i.test(combinedTextSoFar);
        const unclosedPatch = /(?:\\?\*){3}\s*Begin Patch/i.test(combinedTextSoFar) && !/(?:\\?\*){3}\s*End Patch/i.test(combinedTextSoFar);
        const unclosedPlan = /<\s*proposed[\\_]*plan\s*>/i.test(combinedTextSoFar) && !/<\s*\/proposed[\\_]*plan\s*>/i.test(combinedTextSoFar);

        const statusSummary = status.isGenerating
          ? `M365 đang sinh văn bản (${elapsedSec}s, ${currentChars} ký tự)...`
          : (status.hasContent
            ? `M365 tạm dừng sinh, đang chờ ổn định (${stableSec}s, ${currentChars} ký tự)...`
            : `Đang chờ M365 bắt đầu phản hồi (${elapsedSec}s)...`);

        emitStructuredEvent({
          level: "info",
          event: "m365.provider.progress",
          traceContext: options.traceContext,
          safeDetails: {
            elapsedSeconds: elapsedSec,
            isGenerating: status.isGenerating,
            outputChars: currentChars,
            stableSeconds: stableSec,
            hasUnclosedToolCall: unclosedToolCall,
            hasUnclosedPatch: unclosedPatch,
            hasUnclosedPlan: unclosedPlan,
            statusSummary,
            domStatus: status.isGenerating ? "generating" : (status.hasContent ? "settling" : "idle"),
          },
        });
      }

      // Điều kiện kết thúc:
      // 1. Phải có nội dung trả lời (hasContent)
      // 2. Không còn đang sinh (!status.isGenerating)
      // 3. Khối tool_call, patch hoặc proposed_plan đã đóng trọn vẹn, hoặc văn bản đã ngừng thay đổi đủ lâu
      const combinedText = fastPathActive ? lastFastPathText : lastBlocks.map(b => b.text).join(" ");
      const hasUnclosedToolCall = /(?:<|\b)\s*tool\\?_call\s*>/i.test(combinedText) && !/(?:<\s*\/|\/\s*)tool\\?_call\s*>/i.test(combinedText);
      const hasUnclosedPatch = /(?:\\?\*){2,3}\s*Begin Patch/i.test(combinedText) && !/(?:\\?\*){2,3}\s*End Patch/i.test(combinedText);
      const hasUnclosedPlan = /<\s*proposed[\\_]*plan\s*>/i.test(combinedText) && !/<\s*\/proposed[\\_]*plan\s*>/i.test(combinedText);
      const toolCallFullyClosed = /(?:<\s*\/|\/\s*)tool\\?_call\s*>/i.test(combinedText);
      const planFullyClosed = /<\s*\/proposed[\\_]*plan\s*>/i.test(combinedText);

      // Nếu M365 đã dừng sinh và văn bản không đổi:
      // - Nếu có thẻ tool_call hoặc proposed_plan đã đóng trọn vẹn: Chỉ cần ổn định 1 giây là kết thúc ngay
      // - Nếu đang có khối mở dở dang: TUYỆT ĐỐI KHÔNG ngắt sớm
      // - Đối với văn bản dài (> 2.000 ký tự) không có thẻ đóng dứt điểm: Cần thời gian chờ ổn định tối thiểu 6.0 giây (24 chu kỳ)
      //   để tránh việc LLM tạm dừng tạo chữ giữa các đoạn (như trường hợp kế hoạch 20 mục)
      const isLongResponse = combinedText.length > 2000;
      const minStableTime = isLongResponse ? 6000 : 3000;
      const minStableCycles = isLongResponse ? 24 : 8;

      const isSettled = !status.isGenerating && (
        ((toolCallFullyClosed || planFullyClosed) && (stableCycles >= 4 || Date.now() - lastTextChangeAt >= 1000)) ||
        (!hasUnclosedToolCall && !hasUnclosedPatch && !hasUnclosedPlan && (
          stableCycles >= minStableCycles || Date.now() - lastTextChangeAt >= minStableTime
        ))
      );

      if (status.hasContent && !status.isGenerating && isSettled) {
        console.log(`[m365-worker] [settled] attempts=${attempts} durationMs=${attempts * pollIntervalMs} toolCallClosed=${toolCallFullyClosed} planClosed=${planFullyClosed} fastPath=${fastPathActive}`);
        break;
      }

      // Dynamic Liveness Timeout:
      // Nếu đã chạm mốc maxAttempts nhưng M365 vẫn đang sinh (isGenerating) hoặc văn bản vừa thay đổi trong vòng 30s:
      // Tiếp tục gia hạn thời gian chờ để không bao giờ cắt cụt câu trả lời lớn đang sinh dở
      if (attempts >= maxAttempts) {
        const timeSinceLastChange = Date.now() - lastTextChangeAt;
        const isActivelyGenerating = status.isGenerating || timeSinceLastChange < 30_000;
        if (isActivelyGenerating && attempts < maxAttempts + 2400) { // Gia hạn thêm tối đa 10 phút nếu vẫn sinh
          if (attempts % 40 === 0) {
            console.log(`[m365-worker] [extended-liveness] Model vẫn đang tích cực sinh phản hồi (${Math.round(timeSinceLastChange / 1000)}s kể từ token gần nhất), tiếp tục chờ...`);
          }
        } else {
          break;
        }
      }
    }

    const timedOut = attempts >= maxAttempts && (status.isGenerating || Date.now() - lastTextChangeAt >= 30_000);
    if (timedOut) {
      console.warn(`[m365-worker] [timeout] Đã đạt ngưỡng tối đa ${Math.round(attempts * pollIntervalMs / 1000)}s chờ M365 kết thúc.`);
    }

    // Kết thúc lượt sinh: Flush toàn bộ các khối còn lại (bao gồm khối cuối cùng)
    let fullMarkdown: string;
    let finalDelta: string;
    if (fastPathActive) {
      const res = fastPathBuffer.finish(lastFastPathText);
      fullMarkdown = res.markdown;
      finalDelta = res.delta;
    } else {
      const res = markdownBuffer.finish(lastBlocks);
      fullMarkdown = res.markdown;
      finalDelta = res.delta;
    }

    // Fail-Closed: Ở chế độ Temporary Chat Per Request, bắt buộc M365 phải trả về trong codeblock
    if (isTemporaryMode && (!fastPathActive || !fullMarkdown || !fullMarkdown.trim())) {
      throw new Error(
        `[M365 Format Error] M365 Copilot không trả về phản hồi bên trong khối codeblock markdown (4-backtick). Vui lòng kiểm tra lại prompt format của M365.`
      );
    }

    if (finalDelta.length > 0 && !options.shouldStop?.()) {
      options.onChunk(finalDelta);
    }

    finalStatus = "completed";
    emitStructuredEvent({
      level: timedOut ? "warning" : "info",
      event: "m365.provider.finished",
      traceContext: options.traceContext,
      safeDetails: {
        provider: "m365-copilot",
        status: finalStatus,
        durationMs: Date.now() - startTime,
        outputChars: fullMarkdown.length,
        responsePreview: fullMarkdown,
        rawResponse: fullMarkdown,
        timedOut,
        terminalReason: timedOut ? "polling_timeout" : "completed_settled",
        terminalExplanation: timedOut
          ? `Hết thời gian chờ tối đa 120s nhưng M365 chưa đóng khối phản hồi hoàn toàn.`
          : `M365 đã hoàn tất và văn bản đã ổn định.`,
      },
      diagnosticDetails: {
        outputBytes: Buffer.byteLength(fullMarkdown, "utf8"),
      },
    });
    console.log(`[m365-worker] [completed] totalChars=${fullMarkdown.length} finalStatus=${finalStatus} timedOut=${timedOut}`);

    // [DEBUG PIPELINE] STEP 3: M365 Copilot Web ➔ Bridge Server (RAW RESPONSE SCRAPING)
    logDebugPipelineStation(3, "M365 COPILOT WEB ➔ BRIDGE SERVER (RAW RESPONSE SCRAPING)", fullMarkdown);

    return fullMarkdown;
  } catch (err) {
    if (options.signal?.aborted) {
      finalStatus = "aborted";
      emitStructuredEvent({
        level: "warning",
        event: "m365.provider.finished",
        traceContext: options.traceContext,
        safeDetails: {
          provider: "m365-copilot",
          status: finalStatus,
          durationMs: Date.now() - startTime,
          outputChars: 0,
        },
      });
      console.log(`[m365-worker] [aborted] turn aborted by client`);
    } else {
      finalStatus = "failed";
      emitStructuredEvent({
        level: "error",
        event: "m365.provider.finished",
        traceContext: options.traceContext,
        safeDetails: {
          provider: "m365-copilot",
          status: finalStatus,
          durationMs: Date.now() - startTime,
          outputChars: 0,
        },
        diagnosticDetails: {
          errorMessage: err instanceof Error ? err.message : String(err),
        },
      });
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
      }).catch(() => { });
      await withTimeout(notifyPromise, 2000, undefined);
    }
    console.log(`[m365-worker] [cleanup] closing browser connection (timeout 3000ms)...`);
    await withTimeout(browser.close().catch(() => { }), 3000, undefined);
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
