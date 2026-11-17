import { readFileSync } from "node:fs";
import type { Locator, Page } from "playwright-core";
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
  signal?: AbortSignal;
  heartbeat?: () => Promise<void>;
  hardTimeoutMs?: number;
}

export interface AiStudioSpeechResult {
  audioBase64: string;
  mimeType: string;
}

const SPEECH_SELECTORS = {
  presetCoHost: 'button:has-text("The Energetic Co-Host"), [role="button"]:has-text("The Energetic Co-Host")',
  textModeToggle:
    'button.toggle-button[data-value="TEXT"], button[role="radio"][data-value="TEXT"], button.toggle-button:has-text("Text")',
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

  private async clickResilient(locator: Locator, timeoutMs = 3_000): Promise<void> {
    if (typeof (locator as { scrollIntoViewIfNeeded?: unknown }).scrollIntoViewIfNeeded === "function") {
      await locator.scrollIntoViewIfNeeded({ timeout: 1_500 }).catch(() => {});
    }

    try {
      await locator.click({ timeout: timeoutMs });
      return;
    } catch (firstError) {
      try {
        await locator.click({ force: true, timeout: Math.min(timeoutMs, 1_500) });
        return;
      } catch {
        if (typeof (locator as { evaluate?: unknown }).evaluate === "function") {
          await locator.evaluate((el) => {
            const node = el as HTMLElement;
            node.scrollIntoView?.({ block: "center", inline: "center" });
            node.click();
          });
          return;
        }
        throw firstError;
      }
    }
  }

  public async executeSpeech(
    page: Page,
    options: AiStudioSpeechRunOptions,
  ): Promise<AiStudioSpeechResult> {
    this.throwIfAborted(options.signal);

    const targetUrl = buildAiStudioSpeechUrl(options.modelId);
    const isAlreadyOnTargetSpeechUrl = (() => {
      try {
        const rawUrl = typeof page.url === "function" ? page.url() : "";
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
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 25_000 });
    }

    // Chờ vào editor/toggle hoặc chọn preset Podcast ("The Energetic Co-Host") nếu đang ở màn landing
    const promptLocator = page.locator(SPEECH_SELECTORS.promptTextarea).first();
    const presetLocator = page.locator(SPEECH_SELECTORS.presetCoHost).first();
    const textToggle = page.locator(SPEECH_SELECTORS.textModeToggle).first();

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      this.throwIfAborted(options.signal);
      if (await promptLocator.isVisible().catch(() => false)) break;
      if (await textToggle.isVisible().catch(() => false)) break;
      if (await presetLocator.isVisible().catch(() => false)) {
        await this.clickResilient(presetLocator, 3_000);
        await textToggle.waitFor({ state: "visible", timeout: 15_000 }).catch(async () => {
          await promptLocator.waitFor({ state: "visible", timeout: 5_000 });
        });
        break;
      }
      await page.waitForTimeout(200);
    }

    // Preset "The Energetic Co-Host" mở ở chế độ Composer (không có textarea Enter a prompt),
    // nên phải bấm chuyển sang chế độ Text TRƯỚC khi chờ promptLocator xuất hiện.
    await this.ensureTextMode(page, textToggle, promptLocator, options.signal);
    await promptLocator.waitFor({ state: "visible", timeout: 15_000 });

    // Chụp baseline audio.src trước khi chạy (preset mặc định load sẵn file mẫu enthusiastic-co-host.wav)
    const baselineAudioSrc = await page.evaluate(() => {
      return document.querySelector("audio")?.getAttribute("src") || "";
    }).catch(() => "");

    const parsedScript = parseGeminiSpeechScript(options.text);

    await this.fillTextareaIfPresent(page, SPEECH_SELECTORS.sceneTextarea, parsedScript.scene);
    await this.fillTextareaIfPresent(page, SPEECH_SELECTORS.sampleContextTextarea, parsedScript.sampleContext);
    await promptLocator.click({ timeout: 2_000 }).catch(() => {});
    await promptLocator.fill(parsedScript.transcript);

    // Chờ Angular cập nhật danh sách speaker cards theo đúng thứ tự/tên trong transcript vừa dán
    await page.waitForTimeout(350);

    if (options.speakers.length > 0) {
      await this.configureSpeakers(page, options.speakers, parsedScript, options.signal);
    }

    if (typeof options.temperature === "number" && Number.isFinite(options.temperature)) {
      await this.configureTemperature(page, options.temperature);
    }

    const runButton = page.locator(SPEECH_SELECTORS.runButton).first();
    await runButton.waitFor({ state: "visible", timeout: 10_000 });
    await this.clickResilient(runButton, 5_000);

    return await this.waitForGeneratedAudio(page, baselineAudioSrc, options);
  }

  /**
   * Đảm bảo playground chuyển hẳn sang chế độ Text; thử click lại hoặc fallback DOM click nếu Angular chưa ăn lần đầu.
   */
  private async ensureTextMode(
    page: Page,
    textToggle: ReturnType<Page["locator"]>,
    promptLocator: ReturnType<Page["locator"]>,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 6_000;
    let attempt = 0;

    while (Date.now() < deadline) {
      this.throwIfAborted(signal);
      if (await promptLocator.isVisible().catch(() => false)) return;

      const toggleVisible = await textToggle.isVisible().catch(() => false);
      if (!toggleVisible) {
        await page.waitForTimeout(150);
        continue;
      }

      const checked = await textToggle.getAttribute("aria-checked").catch(() => null);
      if (checked === "true") return;

      if (attempt % 2 === 0) {
        await textToggle.click({ timeout: 2_000, force: attempt > 0 }).catch(() => {});
      } else {
        await textToggle
          .evaluate((el) => {
            (el as HTMLElement).click();
          })
          .catch(() => {});
      }
      attempt += 1;

      await page.waitForTimeout(200);
      if (await promptLocator.isVisible().catch(() => false)) return;
      if ((await textToggle.getAttribute("aria-checked").catch(() => null)) === "true") return;
    }
  }

  private async fillTextareaIfPresent(page: Page, selector: string, value: string): Promise<void> {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.fill(value);
    }
  }

  private async configureTemperature(page: Page, temperature: number): Promise<void> {
    const tempInput = page.locator(SPEECH_SELECTORS.temperatureInput).first();
    if (!(await tempInput.isVisible().catch(() => false))) {
      const toggle = page.locator(SPEECH_SELECTORS.modelSettingsToggle).first();
      if (await toggle.isVisible().catch(() => false)) {
        await toggle.click({ timeout: 3_000 }).catch(() => {});
        await tempInput.waitFor({ state: "visible", timeout: 3_000 }).catch(() => {});
      }
    }
    if (!(await tempInput.isVisible().catch(() => false))) return;

    const formatted = String(Math.max(0, Math.min(2, temperature)));
    const current = ((await tempInput.inputValue().catch(() => "")) || "").trim();
    if (current === formatted) return;

    await tempInput.fill(formatted);
    await tempInput.press("Enter").catch(() => {});
    await tempInput.evaluate((el) => (el as HTMLElement).blur()).catch(() => {});
    await page.waitForTimeout(150);
  }

  private async setCardAlias(card: Locator, alias: string): Promise<void> {
    const aliasInput = card.locator(SPEECH_SELECTORS.speakerAliasInput).first();
    if (!(await aliasInput.isVisible().catch(() => false))) return;
    await aliasInput.fill(alias);
    await aliasInput.press("Enter").catch(() => {});
    await aliasInput.evaluate((el) => (el as HTMLElement).blur()).catch(() => {});
  }

  private async readCardAlias(card: Locator): Promise<string> {
    return (
      (await card.locator(SPEECH_SELECTORS.speakerAliasInput).first().inputValue().catch(() => "")) ||
      (await card.locator(SPEECH_SELECTORS.speakerAliasTag).first().textContent().catch(() => "")) ||
      ""
    ).trim().toLowerCase();
  }

  private async configureSpeakers(
    page: Page,
    speakers: SpeechSpeakerConfig[],
    script: ParsedSpeechScript,
    signal?: AbortSignal,
  ): Promise<void> {
    const cards = page.locator(SPEECH_SELECTORS.voiceCard);
    const cardCount = await cards.count();
    if (cardCount === 0) return;

    // Đưa speaker xuất hiện trước trong transcript lên card đầu tiên trên UI,
    // tránh model TTS Preview ở chế độ Text lấy giọng card 0 đọc cho người mở đầu.
    const orderedSpeakers = orderSpeakersByTranscript(speakers, script.transcript);
    const currentAliases: string[] = [];
    for (let i = 0; i < cardCount; i += 1) {
      currentAliases.push(await this.readCardAlias(cards.nth(i)));
    }

    const pairCount = Math.min(cardCount, orderedSpeakers.length);
    for (let i = 0; i < pairCount; i += 1) {
      this.throwIfAborted(signal);
      const speakerConfig = orderedSpeakers[i];
      const targetName = speakerConfig.speaker.trim();
      const targetLower = targetName.toLowerCase();

      if (currentAliases[i] !== targetLower) {
        for (let j = i + 1; j < cardCount; j += 1) {
          if (currentAliases[j] === targetLower) {
            const tmpAlias = `__speaker_tmp_${j}__`;
            await this.setCardAlias(cards.nth(j), tmpAlias);
            currentAliases[j] = tmpAlias;
          }
        }
        await this.setCardAlias(cards.nth(i), targetName);
        currentAliases[i] = targetLower;
      }

      const card = cards.nth(i);
      const profileText = script.audioProfiles[targetLower];
      const directorNote = script.directorNotes[targetLower];
      await this.applySpeakerDrawerSettings(page, card, speakerConfig.voiceName, profileText, directorNote);
    }
  }

  private async selectDirectorOption(
    page: Page,
    buttonLabel: "Style" | "Pace" | "Accent",
    targetValue?: string,
  ): Promise<void> {
    if (!targetValue) return;
    const button = page.locator(`button:has-text("${buttonLabel}")`).first();
    if (!(await button.isVisible().catch(() => false))) return;

    await button.click({ timeout: 2_000 }).catch(() => {});
    const menuItems = page.locator('[role="menu"] [role="menuitem"]');
    const visible = await menuItems.first().waitFor({ state: "visible", timeout: 2_000 }).then(() => true).catch(() => false);
    if (!visible) return;

    const targetLower = targetValue.trim().toLowerCase();
    const count = await menuItems.count();
    for (let i = 0; i < count; i += 1) {
      const item = menuItems.nth(i);
      const label = ((await item.textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (label === targetLower || label.includes(targetLower)) {
        await item.click({ timeout: 2_000 }).catch(() => {});
        await page.waitForTimeout(100);
        return;
      }
    }
    await page.keyboard.press("Escape").catch(() => {});
  }

  private async applySpeakerDrawerSettings(
    page: Page,
    card: Locator,
    voiceName: string,
    audioProfile?: string,
    directorNote?: { style?: string; pace?: string; accent?: string },
  ): Promise<void> {
    const trigger = card.locator(SPEECH_SELECTORS.voiceCardTrigger).first();
    await trigger.waitFor({ state: "visible", timeout: 5_000 });
    await this.clickResilient(trigger, 3_000);

    const voicesRegion = page.locator(SPEECH_SELECTORS.availableVoicesRegion).first();
    await voicesRegion.waitFor({ state: "visible", timeout: 5_000 });

    if (audioProfile !== undefined) {
      const personaBox = page.locator(SPEECH_SELECTORS.voicePersonaTextarea).first();
      if (await personaBox.isVisible().catch(() => false)) {
        await personaBox.fill(audioProfile);
      }
    }

    if (directorNote) {
      await this.selectDirectorOption(page, "Style", directorNote.style);
      await this.selectDirectorOption(page, "Pace", directorNote.pace);
      await this.selectDirectorOption(page, "Accent", directorNote.accent);
    }

    const targetVoiceLower = voiceName.trim().toLowerCase();
    const voiceButtons = voicesRegion.locator("button.voice-card-content, button[aria-label]:not(.play-icon)");
    const count = await voiceButtons.count();
    let matchedVoice = false;

    for (let i = 0; i < count; i += 1) {
      const btn = voiceButtons.nth(i);
      const ariaLabel = ((await btn.getAttribute("aria-label").catch(() => "")) || "").replace(/\s+/g, " ").trim();
      const spanName = ((await btn.locator(".voice-name").first().textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      const fallbackText = ((await btn.textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      const rawLabel = ariaLabel || spanName || fallbackText;
      const normalized = rawLabel.replace(/\s*\(Current\)\s*$/i, "").trim().toLowerCase();

      if (normalized === targetVoiceLower) {
        matchedVoice = true;
        if (!/\(Current\)$/i.test(ariaLabel || fallbackText)) {
          await this.clickResilient(btn, 3_000);
          await page.waitForTimeout(200);
        }
        break;
      }
    }

    if (!matchedVoice) {
      throw new Error(`Could not find voice '${voiceName}' in AI Studio Available voices`);
    }

    const closeBtn = page.locator(SPEECH_SELECTORS.closeDrawerButton).first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click({ timeout: 3_000 }).catch(() => {});
      await voicesRegion.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {});
    }
  }

  private async waitForGeneratedAudio(
    page: Page,
    baselineAudioSrc: string,
    options: AiStudioSpeechRunOptions,
  ): Promise<AiStudioSpeechResult> {
    const hardTimeoutMs = options.hardTimeoutMs ?? this.defaultHardTimeoutMs;
    const deadline = Date.now() + hardTimeoutMs;
    let lastHeartbeatAt = Date.now();
    let seenRunStart = false;

    while (Date.now() < deadline) {
      this.throwIfAborted(options.signal);

      if (options.heartbeat && Date.now() - lastHeartbeatAt >= this.defaultHeartbeatIntervalMs) {
        lastHeartbeatAt = Date.now();
        await options.heartbeat().catch(() => {});
      }

      const state = await page.evaluate(({ errorSelector, runSelector, errorPatternSource }) => {
        const errorPattern = new RegExp(errorPatternSource, "i");
        let detectedError = "";
        for (const el of document.querySelectorAll<HTMLElement>(errorSelector)) {
          const text = (el.innerText || el.textContent || "").trim();
          if (text && errorPattern.test(text)) {
            detectedError = text.replace(/\s+/g, " ").slice(0, 300);
            break;
          }
        }

        const audioEl = document.querySelector("audio");
        const audioSrc = audioEl?.getAttribute("src") || "";
        const runBtn = document.querySelector<HTMLButtonElement>(runSelector);
        const runText = (runBtn?.innerText || runBtn?.textContent || "").trim().toLowerCase();
        const isGenerating = runText.includes("stop") || runText.includes("cancel") || Boolean(runBtn?.disabled);

        return { detectedError, audioSrc, isGenerating };
      }, {
        errorSelector: SPEECH_SELECTORS.errorBanner,
        runSelector: SPEECH_SELECTORS.runButton,
        errorPatternSource: ERROR_TEXT_PATTERN.source,
      });

      if (state.detectedError && ERROR_TEXT_PATTERN.test(state.detectedError)) {
        throw new Error(`[AI Studio Web Error] ${state.detectedError}`);
      }

      if (state.isGenerating) {
        seenRunStart = true;
      }

      const hasNewAudio = Boolean(state.audioSrc) && state.audioSrc !== baselineAudioSrc;
      const readyAfterRun = hasNewAudio && !state.isGenerating;
      // Trường hợp blob URL mới xuất hiện ngay cả khi không kịp bắt trạng thái generating
      if (readyAfterRun || (seenRunStart && !state.isGenerating && state.audioSrc.startsWith("blob:"))) {
        const extracted = await this.extractAudioPayload(page, state.audioSrc);
        if (extracted) {
          return extracted;
        }
      }

      await page.waitForTimeout(300);
    }

    throw new Error(`AI Studio speech generation timed out after ${hardTimeoutMs}ms`);
  }

  private async extractAudioPayload(page: Page, audioSrc: string): Promise<AiStudioSpeechResult | null> {
    if (audioSrc) {
      const fetched = await page.evaluate(async (src) => {
        try {
          const res = await fetch(src);
          if (!res.ok) return null;
          const mimeType = res.headers.get("content-type") || "audio/wav";
          const buf = await res.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = "";
          const chunkSize = 0x8000;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
          }
          return {
            mimeType: mimeType.split(";")[0].trim() || "audio/wav",
            audioBase64: btoa(binary),
            byteLength: bytes.length,
          };
        } catch {
          return null;
        }
      }, audioSrc).catch(() => null);

      if (fetched && fetched.byteLength > 0 && fetched.audioBase64) {
        return {
          audioBase64: fetched.audioBase64,
          mimeType: fetched.mimeType,
        };
      }
    }

    // Fallback: click nút Download để lấy file .wav trực tiếp từ Playwright download event
    const downloadBtn = page.locator(SPEECH_SELECTORS.downloadButton).first();
    if (await downloadBtn.isVisible().catch(() => false)) {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 10_000 }),
        downloadBtn.click({ timeout: 3_000 }),
      ]);
      const filePath = await download.path();
      if (filePath) {
        const buffer = readFileSync(filePath);
        if (buffer.length > 0) {
          return {
            audioBase64: buffer.toString("base64"),
            mimeType: "audio/wav",
          };
        }
      }
    }

    return null;
  }
}
