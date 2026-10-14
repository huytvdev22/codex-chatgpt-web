import type { Page } from "playwright-core";
import type { IStreamObserver } from "../contracts/stream-observer.interface";
import type { ChatSelectorsDto } from "../dto/chat-selectors.dto";
import type { BrowserTurnOptionsDto } from "../dto/browser-turn-options.dto";
import { FastPathStreamBuffer } from "./fast-path-stream-buffer";
import { SemanticMarkdownBuffer, type SemanticMarkdownBlock } from "../../translation/core/semantic-markdown-buffer";
import { CdpLauncherConnector } from "./cdp-launcher-connector";
import { notifyLauncherTurn } from "../../../../launcher-browser-host";
import { emitStructuredEvent } from "../../../../observability/emitter";

export interface FastPathStreamObserverOptions {
  readonly pollIntervalMs?: number;
  readonly maxAttempts?: number;
  readonly providerName?: string;
}

/**
 * Trình quan sát Live DOM và streaming thời gian thực áp dụng Fast-Path Scriptor & Semantic Block Buffering
 * Chuẩn hóa State Machine: READY_TO_SEND -> GENERATING -> COMPLETED
 * Tích hợp Dynamic Liveness Timeout, DOM Virtualization Scroll, và Deadlock Breaker an toàn.
 */
export class FastPathStreamObserver implements IStreamObserver {
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly providerName: string;

  constructor(options?: FastPathStreamObserverOptions) {
    this.pollIntervalMs = options?.pollIntervalMs ?? 250;
    this.maxAttempts = options?.maxAttempts ?? 2400; // 2400 * 250ms = 600s
    this.providerName = options?.providerName ?? "web-chat";
  }

  /**
   * Đánh dấu baseline trên các tin nhắn AI đã tồn tại trước lượt gửi prompt
   */
  public async captureBaseline(page: Page): Promise<{ aiCount: number; lastText: string; lastHtml: string }> {
    return page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(
        ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']"
      ));
      const aiList: HTMLElement[] = [];
      for (const el of candidates) {
        if (el.matches("[data-content='user-message']") || el.querySelector("[data-content='user-message']")) {
          continue;
        }
        const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
        if (ariaLabel.includes("you said") || ariaLabel.includes("bạn đã nói")) {
          continue;
        }
        const isExplicitAi = el.matches(".fai-CopilotMessage, [data-content='ai-message']");
        const hasAiMarkers = Boolean(
          el.querySelector(".fai-CopilotMessage, [data-content='ai-message'], [data-testid='markdown-reply'], .fai-CopilotMessage__content, .fai-Shimmer, [role='progressbar']")
        );
        const heading = el.querySelector(".fai-CopilotMessage__accessibleHeading, [class*='heading' i], h2, h3, h4");
        const headingText = (heading?.textContent || "").toLowerCase();
        const isCopilotHeading = headingText.includes("copilot");

        if (isExplicitAi || hasAiMarkers || isCopilotHeading) {
          aiList.push(el);
        }
      }
      const aiMessages = aiList.filter((msg, idx, all) => !all.some((other, oIdx) => oIdx !== idx && other.contains(msg)));

      aiMessages.forEach((msg) => {
        msg.setAttribute("data-codex-turn-baseline", "true");
      });

      const lastEl = aiMessages.length > 0 ? (aiMessages[aiMessages.length - 1] as HTMLElement) : null;
      return {
        aiCount: aiMessages.length,
        lastText: lastEl ? (lastEl.textContent?.trim() || "") : "",
        lastHtml: lastEl ? (lastEl.innerHTML || "") : "",
      };
    }).catch(() => ({ aiCount: 0, lastText: "", lastHtml: "" }));
  }

  /**
   * Quan sát Live DOM và streaming text delta liên tục cho đến khi ổn định
   */
  public async observe(page: Page, selectors: ChatSelectorsDto, options: BrowserTurnOptionsDto): Promise<string> {
    const beforeState = await this.captureBaseline(page);
    const markdownBuffer = new SemanticMarkdownBuffer();
    const fastPathBuffer = new FastPathStreamBuffer();
    let fastPathActive = false;
    let lastFastPathText = "";
    let hasSeenGenerating = false;
    let completedCandidateAt: number | null = null;
    const stableCompletionMs = 500;
    let attempts = 0;
    let stableCycles = 0;
    let lastTextChangeAt = Date.now();
    let lastBlocks: SemanticMarkdownBlock[] = [];
    let lastStatus: any = null;

    while (attempts < this.maxAttempts) {
      if (options.signal?.aborted) {
        await page.evaluate((sel: string) => {
          const stopBtn = document.querySelector(sel) as HTMLButtonElement | null;
          if (stopBtn) stopBtn.click();
        }, selectors.stopButton).catch(() => {});
        throw new DOMException(`[${this.providerName}] Turn aborted by client`, "AbortError");
      }

      if (options.shouldStop?.() && lastStatus && !lastStatus.isGenerating) {
        console.log(`[${this.providerName}] [early-stop] options.shouldStop triggered và bot đã thoát trạng thái generating.`);
        break;
      }

      await new Promise(r => setTimeout(r, this.pollIntervalMs));
      attempts++;

      const status = await page.evaluate((params: { before: any; selectors: ChatSelectorsDto }) => {
        const stopBtn = document.querySelector(params.selectors.stopButton);
        const editor = document.querySelector(params.selectors.editor);
        const editorDisabled = editor?.getAttribute("aria-disabled") === "true";

        const candidates = Array.from(document.querySelectorAll<HTMLElement>(
          ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']"
        ));
        const aiList: HTMLElement[] = [];
        for (const el of candidates) {
          if (el.matches("[data-content='user-message']") || el.querySelector("[data-content='user-message']")) {
            continue;
          }
          const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
          if (ariaLabel.includes("you said") || ariaLabel.includes("bạn đã nói")) {
            continue;
          }
          const isExplicitAi = el.matches(".fai-CopilotMessage, [data-content='ai-message']");
          const hasAiMarkers = Boolean(
            el.querySelector(".fai-CopilotMessage, [data-content='ai-message'], [data-testid='markdown-reply'], .fai-CopilotMessage__content, .fai-Shimmer, [role='progressbar']")
          );
          const heading = el.querySelector(".fai-CopilotMessage__accessibleHeading, [class*='heading' i], h2, h3, h4");
          const headingText = (heading?.textContent || "").toLowerCase();
          const isCopilotHeading = headingText.includes("copilot");

          if (isExplicitAi || hasAiMarkers || isCopilotHeading) {
            aiList.push(el);
          }
        }
        const aiMessages = aiList.filter((msg, idx, all) => !all.some((other, oIdx) => oIdx !== idx && other.contains(msg)));

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

        const baselineCount = typeof params.before.aiCount === "number" ? params.before.aiCount : 0;
        if (aiMessages.length === 0) {
          return { isGenerating: Boolean(stopBtn), blocks: [], isNew: false, hasContent: false, detectedWebError, fastPathRawText: null };
        }

        const lastMsg = aiMessages[aiMessages.length - 1] as HTMLElement;
        const currentLastText = lastMsg ? (lastMsg.textContent?.trim() || "") : "";
        const currentLastHtml = lastMsg ? (lastMsg.innerHTML || "") : "";
        const isGenerating = Boolean(stopBtn);

        const isCancellationMessage = /(?:I've stopped generating|stopped generating the response|đã dừng tạo phản hồi|dừng tạo câu trả lời)/i.test(currentLastText);
        const isMarkedBaseline = Boolean(lastMsg && (lastMsg.hasAttribute("data-codex-turn-baseline") || lastMsg.closest("[data-codex-turn-baseline]")));
        const isContentUnchanged = Boolean(
          (!params.before.lastText || currentLastText === params.before.lastText) &&
          (!params.before.lastHtml || currentLastHtml === params.before.lastHtml)
        );
        const isLastMsgOld = (baselineCount > 0 && isMarkedBaseline && isContentUnchanged) || isCancellationMessage;

        if (isLastMsgOld) {
          return {
            isGenerating: isGenerating || editorDisabled,
            blocks: [],
            rawHtml: "",
            isNew: false,
            hasContent: false,
            detectedWebError,
            fastPathRawText: null,
          };
        }

        const markdownReplies = Array.from(lastMsg.querySelectorAll('[data-testid="markdown-reply"]')) as HTMLElement[];
        const replyEl = markdownReplies.find(el => el.getAttribute("data-message-type") === "Chat" && el.textContent?.trim())
          || markdownReplies.reverse().find(el => el.textContent?.trim()) || null;
        const contentEl = replyEl || (lastMsg.querySelector(".fai-CopilotMessage__content, [data-content='content'], .fui-ChatMessage__body, .fai-ChatMessage__content") || lastMsg) as HTMLElement;

        const codeBlockQuery = "div[role='group'][aria-label='Code Preview'], .scriptor-component-code-block, [class*='scriptor-component-code-block']";
        const searchRoots = [lastMsg, contentEl].filter(Boolean) as HTMLElement[];
        const allLiveCodeElements: HTMLElement[] = [];
        searchRoots.forEach(root => {
          root.querySelectorAll(codeBlockQuery).forEach(el => allLiveCodeElements.push(el as HTMLElement));
        });
        const liveCodeBlocks = allLiveCodeElements.filter((el, idx, all) => all.indexOf(el) === idx && !all.some(other => other !== el && other.contains(el)));

        let monacoModelsText: string[] = [];
        try {
          const win = window as any;
          const models = win.monaco?.editor?.getModels?.();
          if (Array.isArray(models) && models.length > 0) {
            monacoModelsText = models.map((m: any) => typeof m.getValue === "function" ? m.getValue() : "").filter(Boolean);
          }
        } catch { }

        const win = window as any;

        // Scope cache theo đúng assistant message hiện tại. Trước đây cache chỉ
        // được key bằng blockIdx và tồn tại trên window xuyên suốt nhiều turn.
        // Khi Format Retry tạo assistant message mới, code block mới thường lại
        // bắt đầu từ blockIdx=0 nên các dòng của response cũ có thể bị ghép vào
        // response mới, làm hỏng transport fence/envelope trước strict parser.
        const messageKey = [
          lastMsg.getAttribute("data-message-id") || "",
          lastMsg.getAttribute("data-testid") || "",
          lastMsg.getAttribute("id") || "",
          String(aiList.length),
        ].join("|");

        if (
          win.__live_code_cache_message_key !== messageKey ||
          !(win.__live_code_lines_cache instanceof Map)
        ) {
          win.__live_code_cache_message_key = messageKey;
          win.__live_code_lines_cache = new Map<number, Map<number, string>>();
        }

        const codeData = liveCodeBlocks.map((block, blockIdx) => {
          const langEl = block.querySelector("[data-testid='one-copilot-code-identity'] span, [class*='code-identity' i] span");
          let lang = langEl?.textContent?.trim().toLowerCase() || "";
          if (lang === "plain text" || lang === "text") lang = "plain";

          let blockCache = win.__live_code_lines_cache.get(blockIdx);
          if (!blockCache) {
            blockCache = new Map<number, string>();
            win.__live_code_lines_cache.set(blockIdx, blockCache);
          }

          const lineEls = Array.from(block.querySelectorAll("[data-line-index]"));
          let codeText = "";
          if (lineEls.length > 0) {
            lineEls.forEach((el) => {
              const idxAttr = el.getAttribute("data-line-index");
              if (idxAttr !== null) {
                const idx = parseInt(idxAttr, 10);
                if (!isNaN(idx)) {
                  blockCache.set(idx, (el.textContent || "").replace(/\u00a0/g, " "));
                }
              }
            });

            const keys = (Array.from(blockCache.keys()) as number[]).sort((a, b) => a - b);
            if (keys.length > 0) {
              const minIdx = keys[0];
              const maxIdx = keys[keys.length - 1];
              const assembled: string[] = [];
              for (let i = minIdx; i <= maxIdx; i++) {
                assembled.push(blockCache.get(i) ?? "");
              }
              codeText = assembled.join("\n");
            } else {
              codeText = lineEls.map(el => (el.textContent || "").replace(/\u00a0/g, " ")).join("\n");
            }
          } else {
            const findRoot = block.querySelector("[data-virtualized-code-find-root='true'], [role='textbox'][aria-label*='Code editor' i]") || block.lastElementChild;
            codeText = (findRoot ? (findRoot as HTMLElement).innerText : (block as HTMLElement).innerText || "").replace(/\u00a0/g, " ");
          }

          if (monacoModelsText[blockIdx] && monacoModelsText[blockIdx].length >= codeText.length) {
            codeText = monacoModelsText[blockIdx];
          }

          codeText = codeText.replace(/^\n+|\n+$/g, "");
          return { lang, codeText };
        });

        let fastPathRawText: string | null = null;
        if (codeData.length === 1) {
          fastPathRawText = codeData[0].codeText;
        } else if (codeData.length > 1) {
          const mdBlock = codeData.find(b => b.lang === "markdown" || b.lang === "md" || b.lang === "plain" || !b.lang);
          fastPathRawText = mdBlock ? mdBlock.codeText : codeData.reduce((prev, curr) => curr.codeText.length > prev.codeText.length ? curr : prev).codeText;
        }

        const clone = contentEl.cloneNode(true) as HTMLElement;
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
          block.replaceWith(pre);
        });

        clone.querySelectorAll("pre").forEach(pre => {
          if (!pre.querySelector("code")) {
            const code = document.createElement("code");
            code.textContent = pre.textContent || "";
            pre.textContent = "";
            pre.appendChild(code);
          }
        });

        clone.querySelectorAll(
          "[role='status'], [role='progressbar'], .fai-Shimmer, [class*='shimmer' i], .fai-StatusMessage, .fai-BebopMessageStatus, [role='toolbar'], .fai-CopilotMessage__actions, .fai-CopilotMessage__accessibleHeading, button, svg"
        ).forEach(el => el.remove());

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
            rawBlocks.push({ tag: "p", html: temp.outerHTML, text });
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
                const html = tag === "code" ? `<pre>${el.outerHTML}</pre>` : el.outerHTML;
                rawBlocks.push({ tag: tag === "code" ? "pre" : tag, html, text });
              }
              return;
            }
            const hasNestedBlocks = Boolean(el.querySelector(Array.from(blockTags).join(",")));
            if (hasNestedBlocks) {
              flushInline();
              Array.from(el.childNodes).forEach(child => processNode(child));
              flushInline();
              return;
            }
          }
          inlineNodes.push(node);
        }

        Array.from(clone.childNodes).forEach(child => processNode(child));
        flushInline();

        const signatureOccurrences = new Map<string, number>();
        const blocks = rawBlocks.map((b, idx) => {
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
            streamable: idx < rawBlocks.length - 1,
          };
        });

        const actionsEl = document.querySelector(params.selectors.actions || '.fai-BebopLiteChatInput__actions');
        const hasSubmitBtn = Boolean(actionsEl?.querySelector('button[type="submit"], .fai-SendButton'));
        const isInputActionsIdle = Boolean(actionsEl) && !hasSubmitBtn && !stopBtn;

        const rawHtml = clone.innerHTML || "";
        const hasContent = (blocks.length > 0 || Boolean(fastPathRawText && fastPathRawText.length > 0)) && !isCancellationMessage;
        const isNew = !isLastMsgOld;
        return { isGenerating, blocks, rawHtml, isNew, hasContent, detectedWebError, fastPathRawText, isInputActionsIdle };
      }, { before: beforeState, selectors });

      if (status.isGenerating) {
        hasSeenGenerating = true;
        completedCandidateAt = null;
      } else if (hasSeenGenerating) {
        if (completedCandidateAt === null) {
          completedCandidateAt = Date.now();
        }
      }

      if (status.detectedWebError) {
        throw new Error(`[${this.providerName} Web Error] ${status.detectedWebError}`);
      }

      if (attempts % 40 === 0) {
        const descPath = CdpLauncherConnector.resolveDescriptorPath(options.descriptorPath);
        notifyLauncherTurn(descPath, {
          phase: "heartbeat",
          traceId: options.traceId || "",
          helperPid: process.pid,
          refreshViewport: false,
        }, undefined, options.signal).catch(() => {});
      }

      // Kích thích render DOM ảo hóa Monaco
      if (attempts % 4 === 0) {
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
          document.querySelectorAll("[role='group'][aria-label='Code Preview'], .monaco-scrollable-element, .scriptor-component-code-block").forEach(el => {
            try {
              const scrollEl = el as HTMLElement;
              const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
              if (maxScroll > 0 && scrollEl.scrollTop < maxScroll) {
                scrollEl.scrollTop = Math.min(maxScroll, scrollEl.scrollTop + 350);
              }
            } catch { }
          });
        }).catch(() => {});
      }

      if (typeof status.fastPathRawText === "string" && status.fastPathRawText.length > 0) {
        fastPathActive = true;
        lastFastPathText = status.fastPathRawText;
        const delta = fastPathBuffer.observe(lastFastPathText);
        if (delta.length > 0) {
          options.onChunk?.(delta);
          lastTextChangeAt = Date.now();
          stableCycles = 0;
        } else {
          stableCycles++;
        }
      } else if (!fastPathActive && status.blocks && status.blocks.length > 0) {
        lastBlocks = status.blocks as SemanticMarkdownBlock[];
        const delta = markdownBuffer.observe(lastBlocks);
        if (delta.length > 0) {
          options.onChunk?.(delta);
          lastTextChangeAt = Date.now();
          stableCycles = 0;
        } else {
          stableCycles++;
        }
      }

      const combinedText = fastPathActive ? lastFastPathText : lastBlocks.map(b => b.text).join(" ");
      const timeSinceChange = Date.now() - lastTextChangeAt;

      // Khôi phục structured liveness telemetry của browser worker cũ.
      // Event chỉ chứa metadata trạng thái, tuyệt đối không phát nội dung
      // browser stream ra consumer trước strict validation.
      if (attempts % 16 === 0) {
        const elapsedSeconds = Math.round(
          (attempts * this.pollIntervalMs) / 1000
        );
        const stableSeconds = Math.round(timeSinceChange / 1000);
        const outputChars = combinedText.length;
        const hasUnclosedToolCall =
          /(?:<|\b)\s*tool\\?_call\s*>/i.test(combinedText) &&
          !/(?:<\s*\/|\/\s*)tool\\?_call\s*>/i.test(combinedText);
        const hasUnclosedPatch =
          /(?:\\?\*){2,3}\s*Begin Patch/i.test(combinedText) &&
          !/(?:\\?\*){2,3}\s*End Patch/i.test(combinedText);
        const hasUnclosedPlan =
          /<\s*proposed[_]*plan\s*>/i.test(combinedText) &&
          !/<\s*\/proposed[_]*plan\s*>/i.test(combinedText);
        const statusSummary = status.isGenerating
          ? `${this.providerName} đang sinh văn bản (${elapsedSeconds}s, ${outputChars} ký tự)...`
          : status.hasContent
            ? `${this.providerName} tạm dừng sinh, đang chờ ổn định (${stableSeconds}s, ${outputChars} ký tự)...`
            : `Đang chờ ${this.providerName} bắt đầu phản hồi (${elapsedSeconds}s)...`;

        emitStructuredEvent({
          level: "info",
          event: "m365.provider.progress",
          traceContext: options.traceContext,
          safeDetails: {
            elapsedSeconds,
            isGenerating: status.isGenerating,
            outputChars,
            stableSeconds,
            hasUnclosedToolCall,
            hasUnclosedPatch,
            hasUnclosedPlan,
            statusSummary,
            domStatus: status.isGenerating
              ? "generating"
              : status.hasContent
                ? "settling"
                : "idle",
          },
        });
      }

      const isVeryShortInitialText = (combinedText.trim().length < 120);
      const minGraceMs = isVeryShortInitialText ? 3_000 : 1_500;
      const requiredStableCycles = isVeryShortInitialText ? 6 : 2;

      const isStopDismissedStable = hasSeenGenerating && !status.isGenerating && completedCandidateAt !== null && (Date.now() - completedCandidateAt >= stableCompletionMs);
      const isState1Idle = Boolean((status as any).isInputActionsIdle) && !status.isGenerating && (stableCycles >= requiredStableCycles);

      const generationFinished = isState1Idle || isStopDismissedStable;
      const textStable = timeSinceChange >= minGraceMs;
      const isSettled = !status.isGenerating && generationFinished && textStable;

      if (status.hasContent && !status.isGenerating && isSettled) {
        break;
      }

      lastStatus = status;
      if (attempts >= this.maxAttempts) {
        const timeSinceLastChange = Date.now() - lastTextChangeAt;
        const isActivelyGenerating = status.isGenerating || timeSinceLastChange < 30_000;
        if (isActivelyGenerating && attempts < this.maxAttempts + 2400) {
          // Gia hạn thêm thời gian chờ liveness
        } else {
          break;
        }
      }
    }

    let fullMarkdown = "";
    let finalDelta = "";
    if (fastPathActive || (fastPathBuffer.getText() && fastPathBuffer.getText().length > 0)) {
      const res = fastPathBuffer.finish(lastFastPathText || fastPathBuffer.getText());
      fullMarkdown = res.markdown || fastPathBuffer.getText();
      finalDelta = res.delta;
    }
    if (!fullMarkdown || !fullMarkdown.trim()) {
      const res = markdownBuffer.finish(lastBlocks);
      if (res.markdown && res.markdown.trim()) {
        fullMarkdown = res.markdown;
        finalDelta = res.delta;
      }
    }
    if (!fullMarkdown || !fullMarkdown.trim()) {
      fullMarkdown = fastPathBuffer.getText() || lastFastPathText || (lastBlocks || []).map(b => b.text).join("\n") || "";
      if (fullMarkdown && !finalDelta) {
        finalDelta = fullMarkdown;
      }
    }

    if (finalDelta.length > 0 && !options.shouldStop?.()) {
      options.onChunk?.(finalDelta);
    }

    return fullMarkdown;
  }
}
