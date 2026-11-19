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
  ): Promise<AiStudioDomStatus> {
    return await page.evaluate(
      ({ selectors, baselineAnswerCount }) => {
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
            el.innerText ||
            el.getAttribute("aria-label") ||
            el.getAttribute("mattooltip") ||
            ""
          )
            .trim()
            .toLowerCase();
          return label.includes("stop") || label.includes("cancel");
        });

        const liveText = Array.from(
          document.querySelectorAll<HTMLElement>(selectors.liveStatus),
        )
          .map((el) => (el.innerText || el.textContent || "").trim())
          .join(" ");
        const isLiveRunning = /running/i.test(liveText);
        const isResponseReadyLive = /response ready/i.test(liveText);
        const isGenerating = isStopVisible || isLiveRunning;

        let detectedWebError = "";
        const alertErrorRegex =
          /Failed to generate content|permission denied|quota exceeded|rate limit|service unavailable/i;
        for (const alertEl of document.querySelectorAll<HTMLElement>(
          '[role="alert"], mat-snack-bar-container, simple-snack-bar, [class*="error-banner" i], [class*="toast" i]',
        )) {
          const text = (alertEl.innerText || alertEl.textContent || "").trim();
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
          ? (lastThought.innerText || lastThought.textContent || "").trim()
              .length
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
        const clone = targetAnswer.cloneNode(true) as HTMLElement;
        for (const noise of clone.querySelectorAll(
          [
            "h3.author-label",
            ".actions",
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
          /^(?:Permission denied\.|Failed to generate content\b|An internal error has occurred\.|Quota exceeded\b|Please check your account permissions)/i.test(
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

    let normalizedText = "";
    if (status.singleMarkdownCodeBlockText) {
      const inner = status.singleMarkdownCodeBlockText.trim();
      normalizedText = /^`{4}markdown\b/i.test(inner)
        ? inner
        : `\`\`\`\`markdown\n${inner}\n\`\`\`\``;
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
      status.rawHtml === state.lastHtml &&
      status.hasContent
    ) {
      state.stableCycles += 1;
    } else {
      state.stableCycles = 0;
    }

    state.lastObservedText = normalizedText;
    state.lastHtml = status.rawHtml;

    const hasUnclosedWebEnvelope =
      normalizedText.includes("<webResponse>") &&
      !normalizedText.includes("</webResponse>");

    const isCompleted = Boolean(
      !status.isGenerating &&
        !networkInFlight &&
        status.hasNewAnswerTurn &&
        status.hasContent &&
        ((status.hasTurnFooter && state.stableCycles >= 1) ||
          (status.responseReadyLive &&
            !hasUnclosedWebEnvelope &&
            state.stableCycles >= 4) ||
          state.stableCycles >= 24),
    );

    const phase =
      status.isGenerating || networkInFlight
        ? status.hasContent
          ? "answering"
          : `thinking:${status.thoughtsCount}`
        : "idle";

    return {
      text: normalizedText,
      isGenerating: status.isGenerating || networkInFlight,
      isCompleted,
      networkInFlight,
      activityKey: `${phase}:${status.thoughtsCount}:${status.thoughtTextLength}:${normalizedText.length}:${status.hasTurnFooter ? "footer" : "stream"}`,
      status,
      timedOut: false,
    };
  }
}
