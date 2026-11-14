import type { Page } from "playwright-core";
import {
  FastPathStreamBuffer,
  m365HtmlToMarkdown,
  M365MarkdownBuffer,
  type M365MarkdownBlock,
} from "../web/protocol";
import type { BaseBrowserRunOptions } from "../web/browser";

export interface M365ResponseBaseline {
  aiCount: number;
  count: number;
  lastText: string;
  lastHtml: string;
}

export interface M365ResponseDomStatus {
  isGenerating: boolean;
  blocks: M365MarkdownBlock[];
  rawHtml?: string;
  isNew: boolean;
  hasContent: boolean;
  detectedWebError: string;
  fastPathRawText: string | null;
  isInputActionsIdle?: boolean;
}

export interface M365ResponseObservation {
  text: string;
  isGenerating: boolean;
  isCompleted: boolean;
  activityKey: string;
  status: M365ResponseDomStatus;
  blocks: M365MarkdownBlock[];
  fastPathActive: boolean;
  timedOut: boolean;
}

export interface M365ResponseRuntimeState {
  markdownBuffer: InstanceType<typeof M365MarkdownBuffer>;
  fastPathBuffer: FastPathStreamBuffer;
  fastPathActive: boolean;
  lastFastPathText: string;
  seenGenerating: boolean;
  hasSeenGenerating: boolean;
  completedCandidateAt: number | null;
  stableCycles: number;
  lastTextChangeAt: number;
  lastBlocks: M365MarkdownBlock[];
  attempts: number;
  lastStatus: M365ResponseDomStatus | null;
  pendingStatus: M365ResponseDomStatus | null;
}

/**
 * Chịu trách nhiệm riêng cho việc đánh dấu baseline DOM, cào trạng thái phản hồi
 * của Microsoft Copilot Web, chuẩn hóa Semantic Blocks và quản lý stream delta buffer.
 */
export class M365DomObserver {
  public createRuntimeState(): M365ResponseRuntimeState {
    return {
      markdownBuffer: new M365MarkdownBuffer({ htmlToMarkdown: m365HtmlToMarkdown }),
      fastPathBuffer: new FastPathStreamBuffer(),
      fastPathActive: false,
      lastFastPathText: "",
      seenGenerating: false,
      hasSeenGenerating: false,
      completedCandidateAt: null,
      stableCycles: 0,
      lastTextChangeAt: Date.now(),
      lastBlocks: [],
      attempts: 0,
      lastStatus: null,
      pendingStatus: null,
    };
  }

  /**
   * Khóa các assistant message đã tồn tại trước lượt gửi để tránh đọc nhầm lượt cũ.
   */
  public async captureBaseline(page: Page): Promise<M365ResponseBaseline> {
    return await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']",
        ),
      );
      const aiList: HTMLElement[] = [];

      for (const element of candidates) {
        if (
          element.matches("[data-content='user-message']") ||
          element.querySelector("[data-content='user-message']")
        ) {
          continue;
        }

        const ariaLabel = (
          element.getAttribute("aria-label") || ""
        ).toLowerCase();
        if (
          ariaLabel.includes("you said") ||
          ariaLabel.includes("bạn đã nói")
        ) {
          continue;
        }

        const explicitAi = element.matches(
          ".fai-CopilotMessage, [data-content='ai-message']",
        );
        const hasAiMarkers = Boolean(
          element.querySelector(
            ".fai-CopilotMessage, [data-content='ai-message'], [data-testid='markdown-reply'], .fai-CopilotMessage__content, .fai-Shimmer, [role='progressbar']",
          ),
        );
        const heading = element.querySelector(
          ".fai-CopilotMessage__accessibleHeading, [class*='heading' i], h2, h3, h4",
        );
        const copilotHeading = (
          heading?.textContent || ""
        ).toLowerCase().includes("copilot");

        if (explicitAi || hasAiMarkers || copilotHeading) {
          aiList.push(element);
        }
      }

      const aiMessages = aiList.filter(
        (message, index, all) =>
          !all.some(
            (other, otherIndex) =>
              otherIndex !== index && other.contains(message),
          ),
      );

      aiMessages.forEach(message => {
        message.setAttribute("data-codex-turn-baseline", "true");
      });

      const latestMessage = aiMessages[aiMessages.length - 1] || null;
      return {
        aiCount: aiMessages.length,
        count: aiMessages.length,
        lastText: (latestMessage?.textContent || "").trim(),
        lastHtml: latestMessage?.innerHTML || "",
      };
    });
  }

  /**
   * Trích xuất các khối ngữ nghĩa (Semantic Blocks) và trạng thái generating từ DOM hiện tại.
   */
  public async captureStatus(
    page: Page,
    beforeState: M365ResponseBaseline,
  ): Promise<M365ResponseDomStatus> {
    const status = await page.evaluate((before) => {
      const stopBtn = document.querySelector(
        'button[aria-label="Stop generating"], .fai-SendButton__stopIcon, [data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="Dừng" i]',
      );
      const editor = document.querySelector(
        '#m365-chat-editor-target-element, .fai-BebopLiteChatInput [role="textbox"], .fai-ChatInput [role="textbox"], div[contenteditable="true"]:not([aria-readonly="true"]):not([aria-label*="Code editor" i]), [role="textbox"]:not([aria-readonly="true"]):not([aria-label*="Code editor" i]), textarea:not([aria-readonly="true"])',
      );
      const editorDisabled = editor?.getAttribute("aria-disabled") === "true";

      // Lọc danh sách tin nhắn AI độc quyền (loại trừ hoàn toàn User message)
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']",
        ),
      );
      const aiList: HTMLElement[] = [];
      for (const el of candidates) {
        if (
          el.matches("[data-content='user-message']") ||
          el.querySelector("[data-content='user-message']")
        ) {
          continue;
        }
        const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
        if (ariaLabel.includes("you said") || ariaLabel.includes("bạn đã nói")) {
          continue;
        }
        const isExplicitAi = el.matches(
          ".fai-CopilotMessage, [data-content='ai-message']",
        );
        const hasAiMarkers = Boolean(
          el.querySelector(
            ".fai-CopilotMessage, [data-content='ai-message'], [data-testid='markdown-reply'], .fai-CopilotMessage__content, .fai-Shimmer, [role='progressbar']",
          ),
        );
        const heading = el.querySelector(
          ".fai-CopilotMessage__accessibleHeading, [class*='heading' i], h2, h3, h4",
        );
        const headingText = (heading?.textContent || "").toLowerCase();
        const isCopilotHeading = headingText.includes("copilot");

        if (isExplicitAi || hasAiMarkers || isCopilotHeading) {
          aiList.push(el);
        }
      }
      const aiMessages = aiList.filter(
        (msg, idx, all) =>
          !all.some((other, oIdx) => oIdx !== idx && other.contains(msg)),
      );

      // Quét thông báo lỗi hệ thống hoặc quota từ M365 Web
      let detectedWebError = "";
      const errorEl = document.querySelector(
        '[data-testid="error-message"], .fai-ErrorMessage, [role="alert"], [class*="errorMessage" i], [class*="error-banner" i]',
      );
      if (errorEl && errorEl.textContent?.trim()) {
        const errText = errorEl.textContent.trim();
        if (
          /something went wrong|try again|reached the limit|limit exceeded|đã xảy ra lỗi|vượt quá giới hạn/i.test(
            errText,
          )
        ) {
          detectedWebError = errText;
        }
      }

      const baselineCount =
        typeof before.aiCount === "number" ? before.aiCount : before.count;

      if (aiMessages.length === 0) {
        return {
          isGenerating: Boolean(stopBtn),
          blocks: [],
          isNew: false,
          hasContent: false,
          detectedWebError,
          fastPathRawText: null,
        };
      }

      const lastMsg = aiMessages[aiMessages.length - 1] as HTMLElement;
      const currentLastText = lastMsg ? lastMsg.textContent?.trim() || "" : "";
      const currentLastHtml = lastMsg ? lastMsg.innerHTML || "" : "";
      const isGenerating = Boolean(stopBtn);

      const isCancellationMessage =
        /(?:I've stopped generating|stopped generating the response|đã dừng tạo phản hồi|dừng tạo câu trả lời)/i.test(
          currentLastText,
        );
      const isMarkedBaseline = Boolean(
        lastMsg &&
          (lastMsg.hasAttribute("data-codex-turn-baseline") ||
            lastMsg.closest("[data-codex-turn-baseline]")),
      );
      const isContentUnchanged = Boolean(
        (!before.lastText || currentLastText === before.lastText) &&
          (!before.lastHtml || currentLastHtml === before.lastHtml),
      );
      const isLastMsgOld =
        (baselineCount > 0 && isMarkedBaseline && isContentUnchanged) ||
        isCancellationMessage;

      if (isLastMsgOld) {
        const isEditorBusy = isGenerating || editorDisabled;
        return {
          isGenerating: isEditorBusy,
          blocks: [],
          rawHtml: "",
          isNew: false,
          hasContent: false,
          detectedWebError,
          fastPathRawText: null,
        };
      }

      const markdownReplies = Array.from(
        lastMsg.querySelectorAll('[data-testid="markdown-reply"]'),
      ) as HTMLElement[];
      const replyEl =
        markdownReplies.find(
          el =>
            el.getAttribute("data-message-type") === "Chat" &&
            el.textContent?.trim(),
        ) ||
        markdownReplies.reverse().find(el => el.textContent?.trim()) ||
        null;
      const contentEl = (replyEl ||
        lastMsg.querySelector(
          ".fai-CopilotMessage__content, [data-content='content'], .fui-ChatMessage__body, .fai-ChatMessage__content",
        ) ||
        lastMsg) as HTMLElement;

      const codeBlockQuery =
        "div[role='group'][aria-label='Code Preview'], .scriptor-component-code-block, [class*='scriptor-component-code-block']";
      const searchRoots = [lastMsg, contentEl].filter(Boolean) as HTMLElement[];
      const allLiveCodeElements: HTMLElement[] = [];
      searchRoots.forEach(root => {
        root
          .querySelectorAll(codeBlockQuery)
          .forEach(el => allLiveCodeElements.push(el as HTMLElement));
      });
      const liveCodeBlocks = allLiveCodeElements.filter(
        (el, idx, all) =>
          all.indexOf(el) === idx &&
          !all.some(other => other !== el && other.contains(el)),
      );

      let monacoModelsText: string[] = [];
      try {
        const win = window as any;
        const models = win.monaco?.editor?.getModels?.();
        if (Array.isArray(models) && models.length > 0) {
          monacoModelsText = models
            .map((m: any) => (typeof m.getValue === "function" ? m.getValue() : ""))
            .filter(Boolean);
        }
      } catch {}

      const win = window as any;
      if (!win.__m365_code_lines_cache_by_block) {
        win.__m365_code_lines_cache_by_block = new Map<
          number,
          Map<number, string>
        >();
      }

      const codeData = liveCodeBlocks.map((block, blockIdx) => {
        const langEl = block.querySelector(
          "[data-testid='one-copilot-code-identity'] span, [class*='code-identity' i] span",
        );
        let lang = langEl?.textContent?.trim().toLowerCase() || "";
        if (lang === "plain text" || lang === "text") lang = "plain";

        let blockCache = win.__m365_code_lines_cache_by_block.get(blockIdx);
        if (!blockCache) {
          blockCache = new Map<number, string>();
          win.__m365_code_lines_cache_by_block.set(blockIdx, blockCache);
        }

        const lineEls = Array.from(block.querySelectorAll("[data-line-index]"));
        let codeText = "";
        if (lineEls.length > 0) {
          lineEls.forEach(el => {
            const idxAttr = el.getAttribute("data-line-index");
            if (idxAttr !== null) {
              const idx = parseInt(idxAttr, 10);
              if (!isNaN(idx)) {
                blockCache.set(
                  idx,
                  (el.textContent || "").replace(/\u00a0/g, " "),
                );
              }
            }
          });

          const keys = (Array.from(blockCache.keys()) as number[]).sort(
            (a, b) => a - b,
          );
          if (keys.length > 0) {
            const minIdx = keys[0];
            const maxIdx = keys[keys.length - 1];
            const assembled: string[] = [];
            for (let i = minIdx; i <= maxIdx; i++) {
              assembled.push(blockCache.get(i) ?? "");
            }
            codeText = assembled.join("\n");
          } else {
            codeText = lineEls
              .map(el => (el.textContent || "").replace(/\u00a0/g, " "))
              .join("\n");
          }
        } else {
          const findRoot =
            block.querySelector(
              "[data-virtualized-code-find-root='true'], [role='textbox'][aria-label*='Code editor' i]",
            ) || block.lastElementChild;
          codeText = (
            findRoot
              ? (findRoot as HTMLElement).innerText
              : (block as HTMLElement).innerText || ""
          ).replace(/\u00a0/g, " ");
        }

        if (
          monacoModelsText[blockIdx] &&
          monacoModelsText[blockIdx].length >= codeText.length
        ) {
          codeText = monacoModelsText[blockIdx];
        }

        codeText = codeText.replace(/^\n+|\n+$/g, "");
        return { lang, codeText };
      });

      let fastPathRawText: string | null = null;
      if (codeData.length === 1) {
        fastPathRawText = codeData[0].codeText;
      } else if (codeData.length > 1) {
        const mdBlock = codeData.find(
          b =>
            b.lang === "markdown" ||
            b.lang === "md" ||
            b.lang === "plain" ||
            !b.lang,
        );
        fastPathRawText = mdBlock
          ? mdBlock.codeText
          : codeData.reduce((prev, curr) =>
              curr.codeText.length > prev.codeText.length ? curr : prev,
            ).codeText;
      }

      const clone = contentEl.cloneNode(true) as HTMLElement;
      const allClonedCodeElements = Array.from(
        clone.querySelectorAll(codeBlockQuery),
      ) as HTMLElement[];
      const clonedCodeBlocks = allClonedCodeElements.filter(
        (el, _, all) => !all.some(other => other !== el && other.contains(el)),
      );

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

      clone
        .querySelectorAll(
          "[role='status'], [role='progressbar'], .fai-Shimmer, [class*='shimmer' i], .fai-StatusMessage, .fai-BebopMessageStatus, [role='toolbar'], .fai-CopilotMessage__actions, .fai-CopilotMessage__accessibleHeading, button, svg",
        )
        .forEach(el => el.remove());

      if (!replyEl) {
        const statusPhrases = [
          "checking that now",
          "taking a look",
          "getting things ready",
          "digging in",
          "working on it",
          "searching the web",
          "searching work data",
          "searching",
          "thinking",
          "generating response",
          "putting it together",
          "putting things together",
          "gathering thoughts",
          "looking through your files",
          "đang xem xét",
          "đang kiểm tra",
          "đang chuẩn bị",
          "đang tìm kiếm",
          "đang đào sâu",
          "đang xử lý",
          "đang suy nghĩ",
          "đang tạo câu trả lời",
          "đang tổng hợp",
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

      const blockTags = new Set([
        "p",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "pre",
        "code",
        "ul",
        "ol",
        "hr",
        "blockquote",
        "table",
      ]);
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
              const html = tag === "code" ? `<pre>${el.outerHTML}</pre>` : el.outerHTML;
              rawBlocks.push({
                tag: tag === "code" ? "pre" : tag,
                html,
                text,
              });
            }
            return;
          }
          const hasNestedBlocks = Boolean(
            el.querySelector(Array.from(blockTags).join(",")),
          );
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

      const allStatusPhrases = [
        "checking that now",
        "taking a look",
        "getting things ready",
        "digging in",
        "working on it",
        "searching the web",
        "searching work data",
        "searching",
        "thinking",
        "generating response",
        "putting it together",
        "putting things together",
        "gathering thoughts",
        "looking through your files",
        "đang xem xét",
        "đang kiểm tra",
        "đang chuẩn bị",
        "đang tìm kiếm",
        "đang đào sâu",
        "đang xử lý",
        "đang suy nghĩ",
        "đang tạo câu trả lời",
        "đang tổng hợp",
      ];

      const filteredBlocks = rawBlocks.filter(b => {
        const t = b.text.trim().toLowerCase();
        const isStatus = allStatusPhrases.some(
          sp => t.startsWith(sp) && t.length < sp.length + 35,
        );
        return (b.text.length > 0 && !isStatus) || b.tag === "hr";
      });

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
          streamable: idx < filteredBlocks.length - 1,
        };
      });

      const actionsEl = document.querySelector(".fai-BebopLiteChatInput__actions");
      const hasSubmitBtn = Boolean(
        actionsEl?.querySelector('button[type="submit"], .fai-SendButton'),
      );
      const isInputActionsIdle = Boolean(actionsEl) && !hasSubmitBtn && !stopBtn;

      const rawHtml = clone.innerHTML || "";
      const hasContent =
        (blocks.length > 0 ||
          Boolean(fastPathRawText && fastPathRawText.length > 0)) &&
        !isCancellationMessage;
      const isNew = !isLastMsgOld;
      return {
        isGenerating,
        blocks,
        rawHtml,
        isNew,
        hasContent,
        detectedWebError,
        fastPathRawText,
        isInputActionsIdle,
      };
    }, beforeState);

    return status as M365ResponseDomStatus;
  }

  public createObservation(
    responseState: M365ResponseRuntimeState,
    timedOut: boolean,
  ): M365ResponseObservation {
    const status =
      responseState.lastStatus ||
      ({
        isGenerating: false,
        blocks: responseState.lastBlocks,
        isNew: responseState.lastBlocks.length > 0,
        hasContent:
          responseState.lastBlocks.length > 0 ||
          responseState.lastFastPathText.length > 0,
        detectedWebError: "",
        fastPathRawText: responseState.lastFastPathText || null,
      } satisfies M365ResponseDomStatus);
    const text = responseState.fastPathActive
      ? responseState.lastFastPathText
      : responseState.lastBlocks.map(block => block.text).join("\n");

    return {
      text,
      isGenerating: status.isGenerating,
      isCompleted: !status.isGenerating && status.hasContent,
      activityKey: [
        status.isGenerating,
        responseState.fastPathActive,
        responseState.lastFastPathText.length,
        responseState.lastBlocks
          .map(block => `${block.key}:${block.text.length}`)
          .join("|"),
      ].join(":"),
      status,
      blocks: responseState.lastBlocks,
      fastPathActive: responseState.fastPathActive,
      timedOut,
    };
  }

  /**
   * Cập nhật state streaming từ DOM status, phát delta cho onChunk và đánh giá
   * điều kiện ổn định khi Copilot dừng sinh phản hồi.
   */
  public async applyStatus(
    page: Page,
    responseState: M365ResponseRuntimeState,
    status: M365ResponseDomStatus,
    options: Pick<BaseBrowserRunOptions, "onChunk">,
  ): Promise<M365ResponseObservation> {
    const stableCompletionMs = 500;

    if (status.isGenerating) {
      responseState.hasSeenGenerating = true;
      responseState.seenGenerating = true;
      responseState.completedCandidateAt = null;
    } else if (
      responseState.hasSeenGenerating &&
      responseState.completedCandidateAt === null
    ) {
      responseState.completedCandidateAt = Date.now();
    }

    if (status.detectedWebError) {
      throw new Error(`[M365 Web Error] ${status.detectedWebError}`);
    }

    if (
      responseState.attempts === 80 &&
      !responseState.seenGenerating &&
      status.blocks.length === 0
    ) {
      console.warn(
        "[m365-worker] [warning] Sau 20s vẫn chưa nhận được phản hồi từ M365 (có thể nút Gửi chưa được kích hoạt hoặc mạng chậm).",
      );
    }

    if (responseState.attempts % 4 === 0) {
      await page
        .evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
          document
            .querySelectorAll(
              "[role='group'][aria-label='Code Preview'], .monaco-scrollable-element, .scriptor-component-code-block",
            )
            .forEach(element => {
              try {
                const scrollElement = element as HTMLElement;
                const maxScroll =
                  scrollElement.scrollHeight - scrollElement.clientHeight;
                if (maxScroll > 0 && scrollElement.scrollTop < maxScroll) {
                  scrollElement.scrollTop = Math.min(
                    maxScroll,
                    scrollElement.scrollTop + 350,
                  );
                }
              } catch {}
            });
        })
        .catch(() => {});
    }

    if (
      typeof status.fastPathRawText === "string" &&
      status.fastPathRawText.length > 0
    ) {
      responseState.fastPathActive = true;
      responseState.lastFastPathText = status.fastPathRawText;
      const delta = responseState.fastPathBuffer.observe(
        responseState.lastFastPathText,
      );
      if (delta) {
        options.onChunk?.(delta);
        responseState.lastTextChangeAt = Date.now();
        responseState.stableCycles = 0;
      } else {
        responseState.stableCycles++;
      }
    } else if (!responseState.fastPathActive && status.blocks.length > 0) {
      responseState.lastBlocks = status.blocks;
      const delta = responseState.markdownBuffer.observe(
        responseState.lastBlocks,
      );
      if (delta) {
        options.onChunk?.(delta);
        responseState.lastTextChangeAt = Date.now();
        responseState.stableCycles = 0;
      } else {
        responseState.stableCycles++;
      }
    }

    responseState.lastStatus = status;

    const combinedText = responseState.fastPathActive
      ? responseState.lastFastPathText
      : responseState.lastBlocks.map(block => block.text).join(" ");
    const timeSinceChange = Date.now() - responseState.lastTextChangeAt;
    const isVeryShortInitialText = combinedText.trim().length < 120;
    const minGraceMs = isVeryShortInitialText ? 3_000 : 1_500;
    const requiredStableCycles = isVeryShortInitialText ? 6 : 2;
    const isStopDismissedStable =
      responseState.hasSeenGenerating &&
      !status.isGenerating &&
      responseState.completedCandidateAt !== null &&
      Date.now() - responseState.completedCandidateAt >= stableCompletionMs;
    const isInputIdle =
      Boolean(status.isInputActionsIdle) &&
      !status.isGenerating &&
      responseState.stableCycles >= requiredStableCycles;
    const isCompleted =
      status.hasContent &&
      !status.isGenerating &&
      (isInputIdle || isStopDismissedStable) &&
      timeSinceChange >= minGraceMs;

    const observation = this.createObservation(responseState, false);
    observation.isCompleted = isCompleted;

    if (isCompleted) {
      console.log(
        `[m365-worker] [completed] attempts=${responseState.attempts} hasSeenGenerating=${responseState.hasSeenGenerating} isInputIdle=${isInputIdle} timeSinceChange=${timeSinceChange}ms fastPath=${responseState.fastPathActive}`,
      );
    }

    return observation;
  }
}
