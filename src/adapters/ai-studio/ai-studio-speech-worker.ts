import type { ElectronSurfaceClient } from "../web/electron-surface-client";
import { AI_STUDIO_ORIGIN } from "./conversation-url";

export const AI_STUDIO_DEFAULT_TTS_MODEL = "gemini-2.5-pro-preview-tts";

export interface SpeechSpeakerConfig {
  speaker: string;
  voiceName: string;
}

export interface ParsedSpeechScript {
  scene: string;
  sampleContext: string;
  transcript: string;
  audioProfiles: Record<string, string>;
  directorNotes: Record<string, { style?: string; pace?: string; accent?: string }>;
}

export interface AiStudioSpeechRunOptions {
  modelId?: string;
  text: string;
  temperature?: number;
  speakers: SpeechSpeakerConfig[];
  reusedSurface?: boolean;
  signal?: AbortSignal;
  heartbeat?: () => Promise<void>;
  hardTimeoutMs?: number;
}

export interface AiStudioSpeechResult {
  audioBase64: string;
  mimeType: string;
}

const SPEECH_SELECTORS = {
  presetCoHost: 'button, [role="button"]',
  textModeToggle:
    'button.toggle-button[data-value="TEXT"], button[role="radio"][data-value="TEXT"]',
  sceneTextarea: 'textarea[aria-label="Scene"]',
  sampleContextTextarea: 'textarea[aria-label="Sample Context"]',
  promptTextarea: 'textarea[aria-label="Enter a prompt"]',
  runButton: "button.ctrl-enter-submits",
  modelSettingsToggle: 'button[aria-label="Expand or collapse Model settings"]',
  temperatureInput: 'input.slider-number-input[role="spinbutton"]',
  voiceCard: ".active-voice-card",
  voiceCardTrigger: "button.active-voice-card-trigger",
  speakerAliasInput: 'input.speaker-alias-input[aria-label="Speaker name"]',
  speakerAliasTag: ".speaker-alias-tag",
  voicePersonaTextarea: 'textarea[aria-label*="voice persona" i]',
  availableVoicesRegion: '[aria-label="Available voices"]',
  closeDrawerButton: 'button[aria-label="Close panel"]',
  downloadButton: 'button.download-button[aria-label="Download"]',
  errorBanner: '[role="alert"], [role="status"], mat-snack-bar-container, simple-snack-bar, .mdc-snackbar, [class*="error-banner" i], [class*="toast" i], [class*="snackbar" i]',
} as const;

const ERROR_TEXT_PATTERN = /Failed to generate content|Http response at 400 or 500 level|http status code:\s*(?:4\d\d|5\d\d)|permission denied|quota exceeded|rate limit|service unavailable|invalid argument|unauthenticated|forbidden/i;

function extractMarkdownSection(text: string, headingPattern: RegExp): string {
  const lines = text.split(/\r?\n/);
  let capturing = false;
  const collected: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,3}\s+/.test(trimmed)) {
      if (capturing) break;
      if (headingPattern.test(trimmed)) {
        capturing = true;
      }
      continue;
    }
    if (capturing) {
      collected.push(line);
    }
  }

  return collected.join("\n").trim();
}

function parsePerSpeakerLines(
  sectionText: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!sectionText) return result;
  for (const line of sectionText.split(/\r?\n/)) {
    const match = /^For\s+([^:]+):\s*(.+)$/i.exec(line.trim());
    if (match) {
      result[match[1].trim().toLowerCase()] = match[2].trim();
    }
  }
  return result;
}

/**
 * Tách nội dung prompt Gemini TTS thành các phần tương ứng trên UI `/generate-speech`:
 * `Scene`, `Sample Context`, `Transcript`, `Audio Profile` và `Director's note`.
 * Nếu client gửi thẳng đoạn thoại không có heading markdown thì giữ nguyên toàn bộ vào `transcript`.
 */
export function parseGeminiSpeechScript(rawText: string): ParsedSpeechScript {
  const normalized = rawText.replace(/\r\n/g, "\n").trim();
  const scene = extractMarkdownSection(normalized, /^##\s+Scene:?$/i);
  const sampleContext = extractMarkdownSection(normalized, /^##\s+Sample\s+Context:?$/i);
  const transcriptSection = extractMarkdownSection(normalized, /^##\s+Transcript:?$/i);
  const audioProfileSection = extractMarkdownSection(normalized, /^#\s+Audio\s+Profile:?$/i);
  const directorsNoteSection = extractMarkdownSection(normalized, /^#\s+Director'?s\s+note:?$/i);

  const audioProfiles = parsePerSpeakerLines(audioProfileSection);
  const rawDirectorLines = parsePerSpeakerLines(directorsNoteSection);
  const directorNotes: Record<string, { style?: string; pace?: string; accent?: string }> = {};

  for (const [speakerKey, line] of Object.entries(rawDirectorLines)) {
    const styleMatch = /Style:\s*([^.]+?)(?:\.|$)/i.exec(line);
    const paceMatch = /Pace:\s*([^.]+?)(?:\.|$)/i.exec(line);
    const accentMatch = /Accent:\s*([^.]+?)(?:\.|$)/i.exec(line);
    directorNotes[speakerKey] = {
      ...(styleMatch ? { style: styleMatch[1].trim() } : {}),
      ...(paceMatch ? { pace: paceMatch[1].trim() } : {}),
      ...(accentMatch ? { accent: accentMatch[1].trim() } : {}),
    };
  }

  const hasStructuredSections = Boolean(scene || sampleContext || transcriptSection);
  return {
    scene,
    sampleContext,
    transcript: hasStructuredSections ? (transcriptSection || normalized) : normalized,
    audioProfiles,
    directorNotes,
  };
}

function findSpeakerFirstIndex(transcript: string, speakerName: string): number {
  const escaped = speakerName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return Number.MAX_SAFE_INTEGER;
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:`, "i").exec(transcript);
  return match ? match.index : Number.MAX_SAFE_INTEGER;
}

/**
 * Sắp xếp danh sách speaker theo thứ tự xuất hiện lần đầu trong transcript để khớp vị trí card trên AI Studio UI.
 */
export function orderSpeakersByTranscript(
  speakers: SpeechSpeakerConfig[],
  transcript: string,
): SpeechSpeakerConfig[] {
  return speakers
    .map((speaker, originalIndex) => ({
      speaker,
      originalIndex,
      firstIndex: findSpeakerFirstIndex(transcript, speaker.speaker),
    }))
    .sort((a, b) => a.firstIndex - b.firstIndex || a.originalIndex - b.originalIndex)
    .map((item) => item.speaker);
}

export function buildAiStudioSpeechUrl(modelId = AI_STUDIO_DEFAULT_TTS_MODEL): string {
  const cleanModel = modelId.replace(/^ai-studio\//i, "").trim() || AI_STUDIO_DEFAULT_TTS_MODEL;
  return `${AI_STUDIO_ORIGIN}/generate-speech?model=${encodeURIComponent(cleanModel)}`;
}

/**
 * Tự động hóa giao diện Google AI Studio Speech Generation (`/generate-speech`)
 * qua tab Launcher đã đăng nhập sẵn để sinh audio WAV không cần `GEMINI_API_KEY`.
 */
export class AiStudioSpeechWorker {
  private readonly defaultHardTimeoutMs = 5 * 60_000;
  private readonly defaultHeartbeatIntervalMs = 10_000;

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new DOMException("AI Studio speech generation aborted", "AbortError");
    }
  }

  public async executeSpeech(
    client: ElectronSurfaceClient,
    options: AiStudioSpeechRunOptions,
  ): Promise<AiStudioSpeechResult> {
    this.throwIfAborted(options.signal);

    const targetUrl = buildAiStudioSpeechUrl(options.modelId);
    const rawUrl = await client.getUrl(options.signal).catch(() => "");
    const isAlreadyOnTargetSpeechUrl = (() => {
      try {
        if (!rawUrl) return false;
        const current = new URL(rawUrl);
        const target = new URL(targetUrl);
        return (
          current.origin === target.origin &&
          current.pathname === target.pathname &&
          current.searchParams.get("model") === target.searchParams.get("model")
        );
      } catch {
        return false;
      }
    })();

    if (!isAlreadyOnTargetSpeechUrl) {
      await client.navigate(targetUrl, { timeoutMs: 25_000, signal: options.signal });
    }

    await client.call(
      "aiStudioSpeechPrepareEditor",
      {
        promptSelector: SPEECH_SELECTORS.promptTextarea,
        textToggleSelector: SPEECH_SELECTORS.textModeToggle,
      },
      { signal: options.signal, timeoutMs: 35_000 },
    );

    const baselineRes = await client
      .call<{ audioSrc: string }>("aiStudioSpeechGetBaselineAudioSrc", {}, { signal: options.signal })
      .catch(() => ({ audioSrc: "" }));
    const baselineAudioSrc = baselineRes.audioSrc || "";

    const parsedScript = parseGeminiSpeechScript(options.text);

    await client.fillTextarea(SPEECH_SELECTORS.sceneTextarea, parsedScript.scene, {
      optional: true,
      signal: options.signal,
    });
    await client.fillTextarea(SPEECH_SELECTORS.sampleContextTextarea, parsedScript.sampleContext, {
      optional: true,
      signal: options.signal,
    });
    await client.fillTextarea(SPEECH_SELECTORS.promptTextarea, parsedScript.transcript, {
      signal: options.signal,
    });

    // Chờ Angular cập nhật danh sách speaker cards theo đúng thứ tự/tên trong transcript vừa dán
    await client.sleep(350, options.signal);

    if (options.speakers.length > 0) {
      const orderedSpeakers = orderSpeakersByTranscript(options.speakers, parsedScript.transcript);
      await client.call(
        "aiStudioSpeechConfigureSpeakers",
        {
          orderedSpeakers,
          audioProfiles: parsedScript.audioProfiles,
          directorNotes: parsedScript.directorNotes,
          resetOptionalProfiles: Boolean(options.reusedSurface),
        },
        { signal: options.signal, timeoutMs: 45_000 },
      );
    }

    if (typeof options.temperature === "number" && Number.isFinite(options.temperature)) {
      await client.call(
        "aiStudioSpeechConfigureTemperature",
        { temperature: options.temperature },
        { signal: options.signal },
      );
    }

    await client.waitForSelector(SPEECH_SELECTORS.runButton, {
      timeoutMs: 10_000,
      signal: options.signal,
    });
    if (!options.reusedSurface) {
      await client
        .call(
          "aiStudioWaitForBotGuardReady",
          { minPageAgeMs: 1_200, maxWaitMs: 1_500 },
          { signal: options.signal },
        )
        .catch(() => {});
    }
    await client.clickSelector(SPEECH_SELECTORS.runButton, { signal: options.signal });

    return await this.waitForGeneratedAudio(client, baselineAudioSrc, options);
  }

  private async waitForGeneratedAudio(
    client: ElectronSurfaceClient,
    baselineAudioSrc: string,
    options: AiStudioSpeechRunOptions,
  ): Promise<AiStudioSpeechResult> {
    const hardTimeoutMs = options.hardTimeoutMs ?? this.defaultHardTimeoutMs;
    const deadline = Date.now() + hardTimeoutMs;
    let lastHeartbeatAt = Date.now();

    while (Date.now() < deadline) {
      this.throwIfAborted(options.signal);

      if (options.heartbeat && Date.now() - lastHeartbeatAt >= this.defaultHeartbeatIntervalMs) {
        lastHeartbeatAt = Date.now();
        await options.heartbeat().catch(() => {});
      }

      const state = await client.call<{
        detectedError: string;
        audioSrc: string;
        isGenerating: boolean;
      }>(
        "aiStudioSpeechCaptureState",
        {
          errorSelector: SPEECH_SELECTORS.errorBanner,
          runSelector: SPEECH_SELECTORS.runButton,
          errorPatternSource: ERROR_TEXT_PATTERN.source,
        },
        { signal: options.signal },
      );

      if (state.detectedError && ERROR_TEXT_PATTERN.test(state.detectedError)) {
        throw new Error(`[AI Studio Web Error] ${state.detectedError}`);
      }

      const hasNewAudio = Boolean(state.audioSrc) && state.audioSrc !== baselineAudioSrc;
      const readyAfterRun = hasNewAudio && !state.isGenerating;
      if (readyAfterRun) {
        const extracted = await client
          .call<AiStudioSpeechResult | null>(
            "aiStudioSpeechExtractAudio",
            {
              audioSrc: state.audioSrc,
              downloadSelector: SPEECH_SELECTORS.downloadButton,
            },
            { signal: options.signal },
          )
          .catch(() => null);
        if (extracted && extracted.audioBase64) {
          return extracted;
        }
      }

      await client.sleep(300, options.signal);
    }

    throw new Error(`AI Studio speech generation timed out after ${hardTimeoutMs}ms`);
  }
}
