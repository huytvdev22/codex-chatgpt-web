import type { Page } from "playwright-core";
import type { BrowserObservation } from "../web/browser";
import { webHtmlToMarkdown } from "../web/protocol";
import { GEMINI_SELECTORS } from "./selectors";

export function normalizeCopiedGeminiSnippet(raw: string): string {
  let trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^\\`{4}markdown\b/i.test(trimmed) || /\\<\/?webResponse>/i.test(trimmed)) {
    trimmed = trimmed
      .replace(/\\`/g, "`")
      .replace(/\\(<\/?webResponse>)/gi, "$1");
  }
  const strippedLangHeader =
    /^markdown\r?\n(<webResponse\b[\s\S]*<\/webResponse>)$/i
      .exec(trimmed)?.[1]
      ?.trim() || trimmed;
  if (/^`{4}markdown\b/i.test(strippedLangHeader)) return strippedLangHeader;
  if (/^<webResponse\b/i.test(strippedLangHeader)) {
    return `\`\`\`\`markdown\n${strippedLangHeader}\n\`\`\`\``;
  }
  return strippedLangHeader;
}

export interface GeminiResponseBaseline {
  responseIds: string[];
  responseCount: number;
  initialLatestText: string;
  previousLatestText: string;
  hasSeenGenerating: boolean;
  stableCount: number;
}

export interface GeminiDomStatus {
  isGenerating: boolean;
  isBusy: boolean;
  hasNewResponse: boolean;
  responseId?: string;
  hasCopyControl: boolean;
  rawHtml: string;
  rawText: string;
  singleCodeBlockText: string | null;
  lightweightLength?: number;
  detectedWebError?: string;
}

export interface GeminiResponseObservation extends BrowserObservation {
  responseId?: string;
  hasCopyControl: boolean;
  timedOut: boolean;
}

export interface GeminiObserverRuntimeState {
  stableCycles: number;
  attempts: number;
  lastObservedText: string;
  lastHtml: string;
  pendingStatus: GeminiDomStatus | null;
}

const GEMINI_WEB_ERROR_REGEX =
  /something went wrong|you['’]ve reached.*limit|rate limit|too many requests|try again later|network error|session has expired|couldn['’]t generate|unavailable/i;

/**
 * Quan sát DOM câu trả lời trên Gemini Web (`gemini.google.com`):
 * - Loại bỏ triệt để `thinking-overlay`, `model-thoughts` và `.code-block-decoration` khỏi nội dung.
 * - Dựa vào nút `Stop response` + `aria-busy="true"` trên `.markdown-main-panel` + nút `Copy`/`Redo` ở footer.
 */
export class GeminiDomObserver {
  public createRuntimeState(): GeminiObserverRuntimeState {
    return {
      stableCycles: 0,
      attempts: 0,
      lastObservedText: "",
      lastHtml: "",
      pendingStatus: null,
    };
  }

  public async captureBaseline(page: Page): Promise<GeminiResponseBaseline> {
    const baseline = await page.evaluate(
      ({ responseSel, thinkingSel }) => {
        const responses = Array.from(
          document.querySelectorAll<HTMLElement>(responseSel),
        );
        const responseIds = responses
          .map((resp) => {
            const panel = resp.querySelector<HTMLElement>(".markdown-main-panel");
            return panel?.id || null;
          })
          .filter((value): value is string => Boolean(value));

        const latest = responses[responses.length - 1];
        let initialLatestText = "";
        if (latest) {
          const content =
            latest.querySelector<HTMLElement>("message-content .markdown-main-panel") ||
            latest.querySelector<HTMLElement>("message-content") ||
            latest;
          const clone = content.cloneNode(true) as HTMLElement;
          for (const noise of clone.querySelectorAll(thinkingSel)) {
            noise.remove();
          }
          initialLatestText = (clone.textContent || "").trim();
        }

        return {
          responseIds,
          responseCount: responses.length,
          initialLatestText,
        };
      },
      {
        responseSel: GEMINI_SELECTORS.assistantResponse,
        thinkingSel: GEMINI_SELECTORS.thinkingContainers,
      },
    );

    return {
      ...baseline,
      previousLatestText: baseline.initialLatestText,
      hasSeenGenerating: false,
      stableCount: 0,
    };
  }

  public async captureStatus(
    page: Page,
    baseline: GeminiResponseBaseline,
  ): Promise<GeminiDomStatus> {
    return await page.evaluate(
      ({ selectors, baselineIds, baselineCount, baselineLatestText }) => {
        const isElementVisible = (el: Element): boolean => {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = window.getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden";
        };

        const stopVisible = Array.from(
          document.querySelectorAll(selectors.stopButton),
        ).some(isElementVisible);

        const knownIds = new Set(baselineIds);
        const responses = Array.from(
          document.querySelectorAll<HTMLElement>(selectors.assistantResponse),
        );
        const newResponses = responses.filter((resp, index) => {
          const panel = resp.querySelector<HTMLElement>(".markdown-main-panel");
          const respId = panel?.id;
          return respId ? !knownIds.has(respId) : index >= baselineCount;
        });

        let latestResponse = newResponses[newResponses.length - 1];
        if (!latestResponse && responses.length > 0) {
          const latestExisting = responses[responses.length - 1]!;
          const existingContent =
            latestExisting.querySelector<HTMLElement>(
              "message-content .markdown-main-panel",
            ) ||
            latestExisting.querySelector<HTMLElement>("message-content") ||
            latestExisting;
          const existingText = (existingContent.textContent || "").trim();
          if (existingText && existingText !== baselineLatestText) {
            latestResponse = latestExisting;
          }
        }

        let detectedWebError = "";
        for (const banner of document.querySelectorAll<HTMLElement>(
          selectors.errorBanner,
        )) {
          if (banner.closest(selectors.assistantResponse)) continue;
          if (!isElementVisible(banner)) continue;
          const text = (banner.innerText || banner.textContent || "").trim();
          if (
            text &&
            /something went wrong|limit|error|expired|too many|try again|unavailable/i.test(
              text,
            )
          ) {
            detectedWebError = text.replace(/\s+/g, " ").slice(0, 300);
            break;
          }
        }

        if (!latestResponse) {
          return {
            isGenerating: stopVisible,
            isBusy: false,
            hasNewResponse: false,
            hasCopyControl: false,
            rawHtml: "",
            rawText: "",
            singleCodeBlockText: null,
            lightweightLength: 0,
            detectedWebError,
          };
        }

        const panel =
          latestResponse.querySelector<HTMLElement>(
            "message-content .markdown-main-panel",
          ) ||
          latestResponse.querySelector<HTMLElement>("message-content") ||
          latestResponse;
        const responseId = panel.id || undefined;
        const isBusy = panel.getAttribute("aria-busy") === "true";
        const isGenerating = stopVisible || isBusy;

        const hasCopyControl = Boolean(
          latestResponse.querySelector(selectors.copyAssistantResponseButton) ||
            latestResponse.querySelector(selectors.redoButton) ||
            latestResponse.querySelector(selectors.copyCodeButton),
        );

        const lightweightLength = (panel.textContent || "").trim().length;
        if (isGenerating) {
          return {
            isGenerating: true,
            isBusy,
            hasNewResponse: true,
            responseId,
            hasCopyControl,
            rawHtml: "",
            rawText: "",
            singleCodeBlockText: null,
            lightweightLength,
            detectedWebError,
          };
        }

        const clone = panel.cloneNode(true) as HTMLElement;
        for (const noise of clone.querySelectorAll(
          `${selectors.thinkingContainers}, button, [aria-hidden="true"]`,
        )) {
          noise.remove();
        }

        // Chuyển các <code-block> của Gemini thành <pre><code> sạch trước khi qua Turndown
        for (const cb of Array.from(clone.querySelectorAll("code-block"))) {
          const headerSpan = cb.querySelector(".code-block-decoration span");
          const lang = (headerSpan?.textContent || "")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_+-]/g, "");
          for (const dec of cb.querySelectorAll(selectors.codeBlockDecoration)) {
            dec.remove();
          }
          const pre = cb.querySelector("pre");
          if (pre) {
            const code = pre.querySelector("code");
            if (code && lang && !/\blanguage-/.test(code.className)) {
              code.classList.add(`language-${lang}`);
            }
            cb.replaceWith(pre);
          }
        }

        let singleCodeBlockText: string | null = null;
        const preBlocks = Array.from(clone.querySelectorAll<HTMLElement>("pre"));
        if (preBlocks.length === 1) {
          const singlePre = preBlocks[0]!;
          const codeEl = singlePre.querySelector("code") || singlePre;
          const extractedCode = (codeEl.textContent || "").trim();

          const outsideClone = clone.cloneNode(true) as HTMLElement;
          for (const blk of outsideClone.querySelectorAll("pre")) {
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
          isGenerating: false,
          isBusy,
          hasNewResponse: true,
          responseId,
          hasCopyControl,
          rawHtml,
          rawText,
          singleCodeBlockText,
          lightweightLength,
          detectedWebError,
        };
      },
      {
        selectors: GEMINI_SELECTORS,
        baselineIds: baseline.responseIds,
        baselineCount: baseline.responseCount,
        baselineLatestText: baseline.initialLatestText,
      },
    );
  }

  public applyStatus(
    state: GeminiObserverRuntimeState,
    baseline: GeminiResponseBaseline,
    status: GeminiDomStatus,
  ): GeminiResponseObservation {
    if (
      status.detectedWebError &&
      GEMINI_WEB_ERROR_REGEX.test(status.detectedWebError)
    ) {
      throw new Error(`[Gemini Web Error] ${status.detectedWebError}`);
    }

    if (status.isGenerating || status.isBusy) {
      baseline.hasSeenGenerating = true;
    }

    let normalizedText = "";
    if (status.singleCodeBlockText) {
      normalizedText = normalizeCopiedGeminiSnippet(status.singleCodeBlockText);
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
      normalizedText = normalizeCopiedGeminiSnippet(
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

    const effectiveGenerating = status.isGenerating || status.isBusy;
    const completedWithCopy =
      status.hasNewResponse &&
      !effectiveGenerating &&
      status.hasCopyControl &&
      normalizedText.length > 0 &&
      !hasUnclosedWebEnvelope &&
      state.stableCycles >= 1;

    const completedByStability =
      status.hasNewResponse &&
      !effectiveGenerating &&
      normalizedText.length > 0 &&
      baseline.stableCount >= (baseline.hasSeenGenerating ? 4 : 8);

    const observedLen = normalizedText.length || status.lightweightLength || 0;

    return {
      text: normalizedText,
      isGenerating: effectiveGenerating,
      isCompleted: completedWithCopy || completedByStability,
      responseId: status.responseId,
      hasCopyControl: status.hasCopyControl,
      timedOut: false,
      activityKey: [
        status.responseId ||
          (status.hasNewResponse
            ? "new-response-without-id"
            : "no-new-response"),
        effectiveGenerating,
        status.hasCopyControl,
        observedLen,
      ].join(":"),
    };
  }
}
