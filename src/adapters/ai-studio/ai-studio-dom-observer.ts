import type { ElectronSurfaceClient } from "../web/electron-surface-client";
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
  singleMarkdownCodeBlockText?: string | null;
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

  public async captureBaseline(client: ElectronSurfaceClient): Promise<AiStudioResponseBaseline> {
    return await client.call<AiStudioResponseBaseline>("aiStudioCaptureBaseline", {
      containerSelector: AI_STUDIO_DOM_SELECTORS.modelTurnContainer,
      thoughtSelector: AI_STUDIO_DOM_SELECTORS.thoughtPanel,
    });
  }

  public async captureStatus(
    client: ElectronSurfaceClient,
    baseline: AiStudioResponseBaseline,
  ): Promise<AiStudioDomStatus> {
    return await client.call<AiStudioDomStatus>("aiStudioCaptureStatus", {
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

    let normalizedText = "";
    if (status.singleMarkdownCodeBlockText) {
      const inner = status.singleMarkdownCodeBlockText.trim();
      normalizedText = /^`{4}markdown\b/i.test(inner)
        ? inner
        : `\`\`\`\`markdown\n${inner}\n\`\`\`\``;
    } else {
      const htmlMarkdown = status.rawHtml ? aiStudioHtmlToMarkdown(status.rawHtml).trim() : "";
      normalizedText = htmlMarkdown || status.rawText.trim();
    }

    if (normalizedText === state.lastObservedText && status.rawHtml === state.lastHtml && status.hasContent) {
      state.stableCycles += 1;
    } else {
      state.stableCycles = 0;
    }

    state.lastObservedText = normalizedText;
    state.lastHtml = status.rawHtml;

    const hasUnclosedWebEnvelope =
      normalizedText.includes("<webResponse>") && !normalizedText.includes("</webResponse>");

    const isCompleted = Boolean(
      !status.isGenerating &&
      status.hasNewAnswerTurn &&
      status.hasContent &&
      (
        (status.hasTurnFooter && state.stableCycles >= 1) ||
        (status.responseReadyLive && !hasUnclosedWebEnvelope && state.stableCycles >= 4) ||
        state.stableCycles >= 24
      ),
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

