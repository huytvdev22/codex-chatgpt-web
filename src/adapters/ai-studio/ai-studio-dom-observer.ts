import type { Page } from "playwright-core";
import { SemanticMarkdownBuffer, webHtmlToMarkdown } from "../web/protocol";

export interface AiStudioResponseBaseline {
  modelContainerCount: number;
  answerCount: number;
  thoughtsCount: number;
  lastAnswerText: string;
}

export interface AiStudioDomStatus {
  isGenerating: boolean;
  responseReadyLive: boolean;
  hasNewAnswerTurn: boolean;
  hasTurnFooter: boolean;
  thoughtsCount: number;
  thoughtTextLength: number;
  answerTextLength?: number;
  rawHtml: string;
  rawText: string;
  singleMarkdownCodeBlockText?: string | null;
  hasContent: boolean;
  detectedWebError?: string;
}

export interface AiStudioResponseObservation {
  text: string;
  isGenerating: boolean;
  isCompleted: boolean;
  networkInFlight: boolean;
  activityKey: string;
  status: AiStudioDomStatus;
  timedOut: boolean;
}

export interface AiStudioResponseRuntimeState {
  markdownBuffer: SemanticMarkdownBuffer;
  stableCycles: number;
  attempts: number;
  lastObservedText: string;
  lastHtml: string;
  lastStreamSnapshotAt: number;
  pendingStatus: AiStudioDomStatus | null;
}

export const AI_STUDIO_DOM_SELECTORS = {
  composer:
    'textarea.cdk-textarea-autosize.textarea[aria-label="Enter a prompt"], textarea[aria-label="Enter a prompt"]',
  runOrStopButton: "button[ms-button].ctrl-enter-submits.ms-button-primary",
  modelTurnContainer: ".chat-session-content .chat-turn-container.model",
  thoughtPanel: "mat-expansion-panel.thought-panel",
  turnFooter: ".turn-footer",
  liveStatus: '[aria-live="polite"][aria-atomic="true"]',
};

/**
 * Chuyển HTML câu trả lời của Google AI Studio sang Markdown chuẩn hóa.
 */
export function aiStudioHtmlToMarkdown(html: string): string {
  return webHtmlToMarkdown(html);
}

/**
 * Quan sát DOM Google AI Studio qua Playwright `Page`:
 * - Tách riêng `thought-panel` khỏi câu trả lời cuối cùng.
 * - Đo thêm `thoughtTextLength` để nhận biết model đang stream Thinking dài.
 * - Không short-circuit khi kiểm tra nút Stop (`button[aria-label*="Stop" i]`).
 */
export class AiStudioDomObserver {
  public createRuntimeState(): AiStudioResponseRuntimeState {
    return {
      markdownBuffer: new SemanticMarkdownBuffer({
        htmlToMarkdown: aiStudioHtmlToMarkdown,
      }),
      stableCycles: 0,
      attempts: 0,
      lastObservedText: "",
      lastHtml: "",
      lastStreamSnapshotAt: 0,
      pendingStatus: null,
    };
  }

  public async captureBaseline(page: Page): Promise<AiStudioResponseBaseline> {
    return await page.evaluate(
      ({ containerSelector, thoughtSelector }) => {
        const containers = Array.from(
          document.querySelectorAll<HTMLElement>(containerSelector),
        );
        const thoughts = containers.filter((el) =>
          Boolean(el.querySelector(thoughtSelector)),
        );
        const answers = containers.filter(
          (el) => !el.querySelector(thoughtSelector),
        );
        const lastAnswer = answers[answers.length - 1];
        return {
          modelContainerCount: containers.length,
          answerCount: answers.length,
          thoughtsCount: thoughts.length,
          lastAnswerText: lastAnswer
            ? (lastAnswer.innerText || "").trim()
            : "",
        };
      },
      {
        containerSelector: AI_STUDIO_DOM_SELECTORS.modelTurnContainer,
        thoughtSelector: AI_STUDIO_DOM_SELECTORS.thoughtPanel,
      },
    );
  }

  public async captureStatus(
    page: Page,
    baseline: AiStudioResponseBaseline,
    options?: { captureFullWhileGenerating?: boolean },
  ): Promise<AiStudioDomStatus> {
    const captureFullWhileGenerating = options?.captureFullWhileGenerating === true;
    return await page.evaluate(
      ({ selectors, baselineAnswerCount, captureFullWhileGenerating }) => {
        const btnCandidates = [
          ...Array.from(
            document.querySelectorAll<HTMLElement>(selectors.runOrStopButton),
          ),
          ...Array.from(
            document.querySelectorAll<HTMLElement>(
              'button[aria-label*="Stop" i], button[aria-label*="Cancel generation" i]',
            ),
          ),
        ];
        const isStopVisible = btnCandidates.some((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 && rect.height <= 0) return false;
          const label = (
            el.getAttribute("aria-label") ||
            el.getAttribute("mattooltip") ||
            el.textContent ||
            ""
          )
            .trim()
            .toLowerCase();
          return label.includes("stop") || label.includes("cancel");
        });

        const liveText = Array.from(
          document.querySelectorAll<HTMLElement>(selectors.liveStatus),
        )
          .map((el) => (el.textContent || el.getAttribute("aria-label") || "").trim())
          .join(" ");
        const isLiveRunning = /running/i.test(liveText);
        const isResponseReadyLive = /response ready/i.test(liveText);
        const isGenerating = isStopVisible || isLiveRunning;

        let detectedWebError = "";
        const alertErrorRegex =
          /Failed to generate content|permission denied|quota exceeded|daily limit|rate limit|service unavailable/i;
        for (const alertEl of document.querySelectorAll<HTMLElement>(
          '[role="alert"], mat-snack-bar-container, simple-snack-bar, [class*="error-banner" i], [class*="toast" i]',
        )) {
          const text = (alertEl.textContent || "").trim();
          if (text && alertErrorRegex.test(text)) {
            detectedWebError = text.replace(/\s+/g, " ").slice(0, 300);
            break;
          }
        }

        const allContainers = Array.from(
          document.querySelectorAll<HTMLElement>(selectors.modelTurnContainer),
        );
        const thoughtContainers = allContainers.filter((el) =>
          Boolean(el.querySelector(selectors.thoughtPanel)),
        );
        const thoughtsCount = thoughtContainers.length;
        const lastThought = thoughtContainers[thoughtContainers.length - 1];
        const thoughtTextLength = lastThought
          ? (lastThought.textContent || "").trim().length
          : 0;
        const answerContainers = allContainers.filter(
          (el) => !el.querySelector(selectors.thoughtPanel),
        );

        const freshAnswers = answerContainers.slice(baselineAnswerCount);
        const targetAnswer = freshAnswers[freshAnswers.length - 1];
        if (!targetAnswer) {
          return {
            isGenerating,
            responseReadyLive: isResponseReadyLive,
            hasNewAnswerTurn: false,
            hasTurnFooter: false,
            thoughtsCount,
            thoughtTextLength,
            answerTextLength: 0,
            rawHtml: "",
            rawText: "",
            singleMarkdownCodeBlockText: null,
            hasContent: false,
            detectedWebError,
          };
        }

        const hasTurnFooter = Boolean(
          targetAnswer.querySelector(selectors.turnFooter),
        );

        // Fast-path nhẹ khi model vẫn đang stream: tránh cloneNode & innerText reflow
        // liên tục trên UI Thread của AI Studio. Đọc từ `ms-prompt-chunk` để không tính
        // header `.author-label` (`Model 1:42 PM`) hay `ms-chat-loading-indicator` (`Thinking`).
        if (isGenerating && !captureFullWhileGenerating) {
          const chunkNodes = Array.from(
            targetAnswer.querySelectorAll<HTMLElement>("ms-prompt-chunk"),
          );
          const lightweightLen =
            chunkNodes.length > 0
              ? chunkNodes.reduce((sum, el) => sum + (el.textContent || "").trim().length, 0)
              : (targetAnswer.textContent || "").trim().length;
          return {
            isGenerating: true,
            responseReadyLive: isResponseReadyLive,
            hasNewAnswerTurn: true,
            hasTurnFooter,
            thoughtsCount,
            thoughtTextLength,
            answerTextLength: lightweightLen,
            rawHtml: "",
            rawText: "",
            singleMarkdownCodeBlockText: null,
            hasContent: lightweightLen > 0,
            detectedWebError,
          };
        }
        const clone = targetAnswer.cloneNode(true) as HTMLElement;
        for (const noise of clone.querySelectorAll(
          [
            ".author-label",
            "h3.author-label",
            "ms-chat-loading-indicator",
            "[class*='loading-indicator' i]",
            ".actions",
            ".actions-container",
            ".turn-footer",
            "mat-accordion",
            "mat-expansion-panel.thought-panel",
            "ms-code-block mat-expansion-panel-header",
            ".code-block-header",
            "[class*='code-block-decoration' i]",
          ].join(", "),
        )) {
          noise.remove();
        }

        let singleMarkdownCodeBlockText: string | null = null;
        const originalCodeBlocks = Array.from(
          targetAnswer.querySelectorAll<HTMLElement>("ms-code-block"),
        );
        if (originalCodeBlocks.length === 1) {
          const origBlock = originalCodeBlocks[0];
          const headerLabel = (
            origBlock.querySelector(
              "mat-expansion-panel-header, .code-block-header",
            )?.textContent || ""
          )
            .trim()
            .toLowerCase();
          const isMarkdownLang =
            headerLabel.includes("markdown") || /\bmd\b/.test(headerLabel);
          const clonePre = clone.querySelector("ms-code-block pre code, pre code");
          const cloneOutsideText = (() => {
            const checkClone = clone.cloneNode(true) as HTMLElement;
            for (const el of checkClone.querySelectorAll("ms-code-block")) {
              el.remove();
            }
            return (checkClone.innerText || checkClone.textContent || "").trim();
          })();
          if (!cloneOutsideText && clonePre) {
            const extracted = (clonePre.textContent || "").trim();
            if (
              extracted &&
              (isMarkdownLang || /^<webResponse\b/i.test(extracted))
            ) {
              singleMarkdownCodeBlockText = extracted;
            }
          }
        }

        const rawHtml = clone.innerHTML.trim();
        const rawText = (clone.innerText || clone.textContent || "").trim();
        if (
          !detectedWebError &&
          !hasTurnFooter &&
          /^(?:Permission denied\.|Failed to generate content\b|An internal error has occurred\.|Quota exceeded\b|You have reached the daily limit\b|Please check your account permissions)/i.test(
            rawText,
          )
        ) {
          detectedWebError = rawText.replace(/\s+/g, " ").slice(0, 300);
        }

        return {
          isGenerating,
          responseReadyLive: isResponseReadyLive,
          hasNewAnswerTurn: true,
          hasTurnFooter,
          thoughtsCount,
          thoughtTextLength,
          rawHtml,
          rawText,
          singleMarkdownCodeBlockText,
          hasContent: rawText.length > 0 || Boolean(singleMarkdownCodeBlockText),
          detectedWebError,
        };
      },
      {
        selectors: AI_STUDIO_DOM_SELECTORS,
        baselineAnswerCount: baseline.answerCount,
        captureFullWhileGenerating,
      },
    );
  }

  public applyStatus(
    state: AiStudioResponseRuntimeState,
    status: AiStudioDomStatus,
    networkInFlight = false,
  ): AiStudioResponseObservation {
    if (status.detectedWebError) {
      throw new Error(`[AI Studio Web Error] ${status.detectedWebError}`);
    }

    const isLightweightPlaceholder =
      status.isGenerating &&
      !status.rawHtml &&
      !status.rawText &&
      !status.singleMarkdownCodeBlockText;

    let normalizedText = "";
    if (status.singleMarkdownCodeBlockText) {
      const inner = status.singleMarkdownCodeBlockText.trim();
      normalizedText = /^`{4}markdown\b/i.test(inner)
        ? inner
        : `\`\`\`\`markdown\n${inner}\n\`\`\`\``;
    } else if (isLightweightPlaceholder) {
      normalizedText = state.lastObservedText;
    } else if (
      status.rawHtml &&
      status.rawHtml === state.lastHtml &&
      state.lastObservedText
    ) {
      normalizedText = state.lastObservedText;
    } else {
      const htmlMarkdown = status.rawHtml
        ? aiStudioHtmlToMarkdown(status.rawHtml).trim()
        : "";
      normalizedText = htmlMarkdown || status.rawText.trim();
    }

    if (
      normalizedText === state.lastObservedText &&
      (isLightweightPlaceholder || status.rawHtml === state.lastHtml) &&
      status.hasContent
    ) {
      state.stableCycles += 1;
    } else {
      state.stableCycles = 0;
    }

    state.lastObservedText = normalizedText;
    if (!isLightweightPlaceholder) {
      state.lastHtml = status.rawHtml;
    }

    const hasUnclosedWebEnvelope =
      normalizedText.includes("<webResponse>") &&
      !normalizedText.includes("</webResponse>");

    const staleNetworkSettled =
      !status.isGenerating &&
      status.hasNewAnswerTurn &&
      status.hasContent &&
      status.hasTurnFooter &&
      !hasUnclosedWebEnvelope &&
      state.stableCycles >= 20;

    const effectiveNetworkInFlight = networkInFlight && !staleNetworkSettled;

    const isCompleted = Boolean(
      !status.isGenerating &&
        status.hasNewAnswerTurn &&
        status.hasContent &&
        ((!effectiveNetworkInFlight &&
          ((status.hasTurnFooter && state.stableCycles >= 1) ||
            (status.responseReadyLive &&
              !hasUnclosedWebEnvelope &&
              state.stableCycles >= 4) ||
            state.stableCycles >= 24)) ||
          staleNetworkSettled),
    );

    const phase =
      status.isGenerating || effectiveNetworkInFlight
        ? status.hasContent
          ? "answering"
          : `thinking:${status.thoughtsCount}`
        : "idle";

    const answerLength =
      status.answerTextLength !== undefined && !normalizedText
        ? status.answerTextLength
        : normalizedText.length;

    return {
      text: normalizedText,
      isGenerating: status.isGenerating || effectiveNetworkInFlight,
      isCompleted,
      networkInFlight: effectiveNetworkInFlight,
      activityKey: `${phase}:${status.thoughtsCount}:${status.thoughtTextLength}:${answerLength}:${status.hasTurnFooter ? "footer" : "stream"}`,
      status,
      timedOut: false,
    };
  }
}
