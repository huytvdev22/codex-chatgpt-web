import type { Page } from "playwright-core";
import { webHtmlToMarkdown } from "../web/protocol";
import type { BrowserObservation } from "../web/browser";
import { CHATGPT_SELECTORS } from "./selectors";

export function normalizeCopiedChatGptSnippet(raw: string): string {
  let trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^\\`{4}markdown\b/i.test(trimmed) || /\\<\/?webResponse>/i.test(trimmed)) {
    trimmed = trimmed
      .replace(/\\`/g, "`")
      .replace(/\\(<\/?webResponse>)/gi, "$1");
  }
  const strippedLangHeader =
    /^markdown\r?\n(<webResponse\b[\s\S]*<\/webResponse>)$/i.exec(trimmed)?.[1]?.trim() ||
    trimmed;
  if (/^`{4}markdown\b/i.test(strippedLangHeader)) return strippedLangHeader;
  if (/^<webResponse\b/i.test(strippedLangHeader)) {
    return `\`\`\`\`markdown\n${strippedLangHeader}\n\`\`\`\``;
  }
  return strippedLangHeader;
}

export interface ChatGptResponseBaseline {
  assistantIds: string[];
  assistantCount: number;
  initialLatestText: string;
  previousLatestText: string;
  hasSeenGenerating: boolean;
  stableCount: number;
}

export interface ChatGptDomStatus {
  isGenerating: boolean;
  hasNewResponse: boolean;
  responseId?: string;
  turnState?: string;
  hasCopyControl: boolean;
  rawHtml: string;
  rawText: string;
  singleCodeBlockText: string | null;
  lightweightLength?: number;
  detectedWebError?: string;
}

export interface ChatGptResponseObservation extends BrowserObservation {
  responseId?: string;
  hasCopyControl: boolean;
  networkInFlight: boolean;
  timedOut: boolean;
}

export interface ChatGptObserverRuntimeState {
  stableCycles: number;
  attempts: number;
  lastObservedText: string;
  lastHtml: string;
  lastStreamSnapshotAt: number;
  pendingStatus: ChatGptDomStatus | null;
}

const CHATGPT_WEB_ERROR_REGEX =
  /usage limit|you['’]ve reached|too many requests|something went wrong|there was an error generating a response|unusual activity|session has expired|network error|only one message at a time/i;

/**
 * Quan sát DOM câu trả lời trên ChatGPT Web (`chatgpt.com`):
 * - Nhận dạng theo `assistantIds`, fallback `assistantCount` hoặc nội dung node thay đổi.
 * - Dùng `textContent` và `innerHTML` (an toàn cả khi node offscreen có `innerText === ""`).
 * - Bỏ qua render Turndown lặp lại trong lúc model đang stream (`isGenerating === true`).
 */
export class ChatGptDomObserver {
  public createRuntimeState(): ChatGptObserverRuntimeState {
    return {
      stableCycles: 0,
      attempts: 0,
      lastObservedText: "",
      lastHtml: "",
      lastStreamSnapshotAt: 0,
      pendingStatus: null,
    };
  }

  public async captureBaseline(page: Page): Promise<ChatGptResponseBaseline> {
    const baseline = await page.evaluate((assistantSelector) => {
      const messages = Array.from(
        document.querySelectorAll<HTMLElement>(assistantSelector),
      );
      const latestMessage = messages[messages.length - 1];
      const assistantIds = messages
        .map((message) => {
          const wrapper = message.closest<HTMLElement>(
            "[data-chatgpt-selection-message-id], [data-response-body]",
          );
          return (
            wrapper?.getAttribute("data-chatgpt-selection-message-id") ||
            wrapper?.getAttribute("data-response-body") ||
            null
          );
        })
        .filter((value): value is string => Boolean(value));

      return {
        assistantIds,
        assistantCount: messages.length,
        initialLatestText: (latestMessage?.textContent || "").trim(),
      };
    }, CHATGPT_SELECTORS.assistantMessage);

    return {
      ...baseline,
      previousLatestText: baseline.initialLatestText,
      hasSeenGenerating: false,
      stableCount: 0,
    };
  }

  public async captureStatus(
    page: Page,
    baseline: ChatGptResponseBaseline,
    options?: { captureFullWhileGenerating?: boolean },
  ): Promise<ChatGptDomStatus> {
    const captureFullWhileGenerating = options?.captureFullWhileGenerating === true;
    return await page.evaluate(
      ({ selectors, baselineIds, baselineCount, baselineLatestText, captureFullWhileGenerating }) => {
        const isElementVisible = (el: Element): boolean => {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = window.getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden";
        };

        const isGenerating = Array.from(
          document.querySelectorAll(selectors.stopButton),
        ).some(isElementVisible);

        const knownIds = new Set(baselineIds);
        const messages = Array.from(
          document.querySelectorAll<HTMLElement>(selectors.assistantMessage),
        );
        const newMessages = messages.filter((message, index) => {
          const wrapper = message.closest<HTMLElement>(
            selectors.responseBodyWrapper,
          );
          const messageId =
            wrapper?.getAttribute("data-chatgpt-selection-message-id") ||
            wrapper?.getAttribute("data-response-body");
          return messageId ? !knownIds.has(messageId) : index >= baselineCount;
        });

        let latestMessage = newMessages[newMessages.length - 1];
        if (!latestMessage) {
          const latestExisting = messages[messages.length - 1];
          const latestText = (latestExisting?.textContent || "").trim();
          if (latestText && latestText !== baselineLatestText) {
            latestMessage = latestExisting;
          }
        }

        // Chỉ kiểm tra banner lỗi hệ thống nằm ngoài vùng markdown câu trả lời.
        let detectedWebError = "";
        for (const banner of document.querySelectorAll<HTMLElement>(
          selectors.errorBanner,
        )) {
          if (banner.closest(selectors.assistantMessage)) continue;
          if (!isElementVisible(banner)) continue;
          const text = (banner.innerText || banner.textContent || "").trim();
          if (
            text &&
            /limit|error|expired|unusual activity|something went wrong|too many|one message/i.test(
              text,
            )
          ) {
            detectedWebError = text.replace(/\s+/g, " ").slice(0, 300);
            break;
          }
        }

        if (!latestMessage) {
          return {
            isGenerating,
            hasNewResponse: false,
            hasCopyControl: false,
            rawHtml: "",
            rawText: "",
            singleCodeBlockText: null,
            lightweightLength: 0,
            detectedWebError,
          };
        }

        const responseWrapper =
          latestMessage.closest<HTMLElement>(selectors.responseBodyWrapper) ||
          latestMessage.parentElement;
        const turnWrapper =
          latestMessage.closest<HTMLElement>(selectors.turnContainer) ||
          responseWrapper?.parentElement ||
          null;
        const responseId =
          responseWrapper?.getAttribute("data-chatgpt-selection-message-id") ||
          responseWrapper?.getAttribute("data-response-body") ||
          undefined;
        const turnState =
          turnWrapper?.getAttribute("data-talvt-turn-state") || undefined;

        const hasCopyControl = Boolean(
          responseWrapper?.querySelector(selectors.copyCodeButton) ||
            turnWrapper?.querySelector(selectors.copyAssistantMessageButton),
        );

        const lightweightLength = (latestMessage.textContent || "").trim().length;
        if (isGenerating && turnState !== "complete" && !captureFullWhileGenerating) {
          return {
            isGenerating: true,
            hasNewResponse: true,
            responseId,
            turnState,
            hasCopyControl,
            rawHtml: "",
            rawText: "",
            singleCodeBlockText: null,
            lightweightLength,
            detectedWebError,
          };
        }

        const clone = latestMessage.cloneNode(true) as HTMLElement;
        for (const noise of clone.querySelectorAll(
          'button, [data-markdown-copy="exclude"], [data-thread-find-skip="true"]',
        )) {
          noise.remove();
        }

        let singleCodeBlockText: string | null = null;
        const codeBlocks = Array.from(
          clone.querySelectorAll<HTMLElement>(selectors.codeBlock),
        );
        if (codeBlocks.length === 1) {
          const singleBlock = codeBlocks[0]!;
          const codeEl =
            singleBlock.querySelector("pre code") ||
            singleBlock.querySelector("code") ||
            singleBlock.querySelector("pre") ||
            singleBlock;
          const extractedCode = (codeEl.textContent || "").trim();

          const outsideClone = clone.cloneNode(true) as HTMLElement;
          for (const blk of outsideClone.querySelectorAll(selectors.codeBlock)) {
            blk.remove();
          }
          const outsideText = (outsideClone.textContent || "").trim();
          if (!outsideText && extractedCode) {
            singleCodeBlockText = extractedCode;
          }
        }

        const rawHtml = clone.innerHTML.trim();
        const rawText = (clone.textContent || "").trim();

        return {
          isGenerating,
          hasNewResponse: true,
          responseId,
          turnState,
          hasCopyControl,
          rawHtml,
          rawText,
          singleCodeBlockText,
          lightweightLength,
          detectedWebError,
        };
      },
      {
        selectors: CHATGPT_SELECTORS,
        baselineIds: baseline.assistantIds,
        baselineCount: baseline.assistantCount,
        baselineLatestText: baseline.initialLatestText,
        captureFullWhileGenerating,
      },
    );
  }

  public applyStatus(
    state: ChatGptObserverRuntimeState,
    baseline: ChatGptResponseBaseline,
    status: ChatGptDomStatus,
    networkInFlight = false,
  ): ChatGptResponseObservation {
    if (
      status.detectedWebError &&
      CHATGPT_WEB_ERROR_REGEX.test(status.detectedWebError)
    ) {
      throw new Error(`[ChatGPT Web Error] ${status.detectedWebError}`);
    }

    if (status.isGenerating || networkInFlight) {
      baseline.hasSeenGenerating = true;
    }

    let normalizedText = "";
    if (status.singleCodeBlockText) {
      normalizedText = normalizeCopiedChatGptSnippet(status.singleCodeBlockText);
    } else if (
      status.rawHtml &&
      status.rawHtml === state.lastHtml &&
      state.lastObservedText
    ) {
      normalizedText = state.lastObservedText;
    } else {
      const markdown = status.rawHtml
        ? webHtmlToMarkdown(status.rawHtml).trim()
        : "";
      normalizedText = normalizeCopiedChatGptSnippet(
        markdown || status.rawText.trim(),
      );
    }

    if (normalizedText && normalizedText !== baseline.previousLatestText) {
      baseline.previousLatestText = normalizedText;
      baseline.stableCount = 0;
      state.stableCycles = 0;
    } else if (normalizedText) {
      baseline.stableCount += 1;
      state.stableCycles += 1;
    } else {
      baseline.stableCount = 0;
      state.stableCycles = 0;
    }

    state.lastObservedText = normalizedText;
    state.lastHtml = status.rawHtml;

    const hasUnclosedWebEnvelope =
      normalizedText.includes("<webResponse>") &&
      !normalizedText.includes("</webResponse>");

    const effectiveGenerating = status.isGenerating || networkInFlight;
    const completedWithTurnState =
      status.hasNewResponse &&
      !effectiveGenerating &&
      status.turnState === "complete" &&
      status.hasCopyControl &&
      normalizedText.length > 0 &&
      !hasUnclosedWebEnvelope &&
      state.stableCycles >= 1;

    const completedWithCopy =
      status.hasNewResponse &&
      !effectiveGenerating &&
      status.hasCopyControl &&
      normalizedText.length > 0 &&
      !hasUnclosedWebEnvelope &&
      state.stableCycles >= 2;

    const completedByStability =
      status.hasNewResponse &&
      !effectiveGenerating &&
      normalizedText.length > 0 &&
      baseline.stableCount >= (baseline.hasSeenGenerating ? 4 : 8);

    const observedLen = normalizedText.length || status.lightweightLength || 0;

    return {
      text: normalizedText,
      isGenerating: effectiveGenerating,
      isCompleted:
        completedWithTurnState || completedWithCopy || completedByStability,
      responseId: status.responseId,
      hasCopyControl: status.hasCopyControl,
      networkInFlight,
      timedOut: false,
      activityKey: [
        status.responseId ||
          (status.hasNewResponse
            ? "new-response-without-id"
            : "no-new-response"),
        effectiveGenerating,
        status.turnState || "unknown",
        status.hasCopyControl,
        observedLen,
      ].join(":"),
    };
  }
}
