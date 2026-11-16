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
  rawHtml: string;
  rawText: string;
  hasContent: boolean;
  detectedWebError?: string;
}

export interface AiStudioResponseObservation {
  text: string;
  isGenerating: boolean;
  isCompleted: boolean;
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
  composer: 'textarea.cdk-textarea-autosize.textarea[aria-label="Enter a prompt"], textarea[aria-label="Enter a prompt"]',
  runOrStopButton: 'button[ms-button].ctrl-enter-submits.ms-button-primary',
  modelTurnContainer: '.chat-session-content .chat-turn-container.model',
  thoughtPanel: 'mat-expansion-panel.thought-panel',
  turnFooter: '.turn-footer',
  liveStatus: '[aria-live="polite"][aria-atomic="true"]',
};

/**
 * Chuyển HTML câu trả lời của Google AI Studio sang Markdown chuẩn hóa.
 */
export function aiStudioHtmlToMarkdown(html: string): string {
  return webHtmlToMarkdown(html);
}

/**
 * Quan sát DOM Google AI Studio, tách biệt hoàn toàn sibling `Thoughts` turn
 * (`mat-expansion-panel.thought-panel`) khỏi `Final Answer` turn.
 */
export class AiStudioDomObserver {
  public createRuntimeState(): AiStudioResponseRuntimeState {
    return {
      markdownBuffer: new SemanticMarkdownBuffer({ htmlToMarkdown: aiStudioHtmlToMarkdown }),
      stableCycles: 0,
      attempts: 0,
      lastObservedText: "",
      lastHtml: "",
      pendingStatus: null,
    };
  }

  public async captureBaseline(page: Page): Promise<AiStudioResponseBaseline> {
    return await page.evaluate(({ containerSelector, thoughtSelector }) => {
      const containers = Array.from(document.querySelectorAll<HTMLElement>(containerSelector));
      const thoughts = containers.filter(el => Boolean(el.querySelector(thoughtSelector)));
      const answers = containers.filter(el => !el.querySelector(thoughtSelector));
      const lastAnswer = answers[answers.length - 1];
      return {
        modelContainerCount: containers.length,
        answerCount: answers.length,
        thoughtsCount: thoughts.length,
        lastAnswerText: lastAnswer ? (lastAnswer.innerText || "").trim() : "",
      };
    }, {
      containerSelector: AI_STUDIO_DOM_SELECTORS.modelTurnContainer,
      thoughtSelector: AI_STUDIO_DOM_SELECTORS.thoughtPanel,
    });
  }

  public async captureStatus(
    page: Page,
    baseline: AiStudioResponseBaseline,
  ): Promise<AiStudioDomStatus> {
    return await page.evaluate(({ selectors, baselineAnswerCount }) => {
      const actionBtn = document.querySelector<HTMLButtonElement>(selectors.runOrStopButton);
      const btnText = (actionBtn?.innerText || actionBtn?.getAttribute("aria-label") || "").trim().toLowerCase();
      const liveText = Array.from(document.querySelectorAll<HTMLElement>(selectors.liveStatus))
        .map(el => (el.innerText || el.textContent || "").trim())
        .join(" ");
      const isLiveRunning = /running/i.test(liveText);
      const isResponseReadyLive = /response ready/i.test(liveText);
      const isStopVisible = btnText.includes("stop") || btnText.includes("cancel");
      const isGenerating = isStopVisible || isLiveRunning;

      let detectedWebError = "";
      const alertErrorRegex = /Failed to generate content|permission denied|quota exceeded|rate limit|service unavailable/i;
      for (const alertEl of document.querySelectorAll<HTMLElement>(
        '[role="alert"], mat-snack-bar-container, simple-snack-bar, [class*="error-banner" i], [class*="toast" i]',
      )) {
        const text = (alertEl.innerText || alertEl.textContent || "").trim();
        if (text && alertErrorRegex.test(text)) {
          detectedWebError = text.replace(/\s+/g, " ").slice(0, 300);
          break;
        }
      }

      const allContainers = Array.from(document.querySelectorAll<HTMLElement>(selectors.modelTurnContainer));
      const thoughtsCount = allContainers.filter(el => Boolean(el.querySelector(selectors.thoughtPanel))).length;
      const answerContainers = allContainers.filter(el => !el.querySelector(selectors.thoughtPanel));

      const freshAnswers = answerContainers.slice(baselineAnswerCount);
      const targetAnswer = freshAnswers[freshAnswers.length - 1];
      if (!targetAnswer) {
        return {
          isGenerating,
          responseReadyLive: isResponseReadyLive,
          hasNewAnswerTurn: false,
          hasTurnFooter: false,
          thoughtsCount,
          rawHtml: "",
          rawText: "",
          hasContent: false,
          detectedWebError,
        };
      }

      const hasTurnFooter = Boolean(targetAnswer.querySelector(selectors.turnFooter));
      const clone = targetAnswer.cloneNode(true) as HTMLElement;
      for (const noise of clone.querySelectorAll(
        "h3.author-label, .actions, .turn-footer, mat-accordion, mat-expansion-panel.thought-panel",
      )) {
        noise.remove();
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
        rawHtml,
        rawText,
        hasContent: rawText.length > 0 || rawHtml.length > 0,
        detectedWebError,
      };
    }, {
      selectors: AI_STUDIO_DOM_SELECTORS,
      baselineAnswerCount: baseline.answerCount,
    });
  }

  public applyStatus(
    state: AiStudioResponseRuntimeState,
    status: AiStudioDomStatus,
  ): AiStudioResponseObservation {
    if (status.detectedWebError) {
      throw new Error(`[AI Studio Web Error] ${status.detectedWebError}`);
    }

    const htmlMarkdown = status.rawHtml ? aiStudioHtmlToMarkdown(status.rawHtml).trim() : "";
    const normalizedText = htmlMarkdown || status.rawText.trim();

    if (normalizedText === state.lastObservedText && status.rawHtml === state.lastHtml && status.hasContent) {
      state.stableCycles += 1;
    } else {
      state.stableCycles = 0;
    }

    state.lastObservedText = normalizedText;
    state.lastHtml = status.rawHtml;

    const isCompleted = Boolean(
      !status.isGenerating &&
      status.hasNewAnswerTurn &&
      status.hasContent &&
      (status.hasTurnFooter || status.responseReadyLive || state.stableCycles >= 2),
    );

    const phase = status.isGenerating
      ? (status.hasContent ? "answering" : `thinking:${status.thoughtsCount}`)
      : "idle";

    return {
      text: normalizedText,
      isGenerating: status.isGenerating,
      isCompleted,
      activityKey: `${phase}:${status.thoughtsCount}:${normalizedText.length}:${status.hasTurnFooter ? "footer" : "stream"}`,
      status,
      timedOut: false,
    };
  }
}

