import { readFileSync } from "node:fs";
import type { Locator, Page, Request } from "playwright-core";
import { isAiStudioGenerationRequest } from "./ai-studio-browser-worker";
import {
  clickResilient,
  fillFieldNatural,
  humanPause,
  waitForBotGuardReady,
} from "./ai-studio-human-timing";
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
  presetCoHost:
    'button:has-text("The Energetic Co-Host"), [role="button"]:has-text("The Energetic Co-Host")',
  textModeToggle:
    'button.toggle-button[data-value="TEXT"], button[role="radio"][data-value="TEXT"], button.toggle-button:has-text("Text")',
  sceneTextarea: 'textarea[aria-label="Scene"]',
  sampleContextTextarea: 'textarea[aria-label="Sample Context"]',
  promptTextarea: 'textarea[aria-label="Enter a prompt"]',
  runButton: "button.ctrl-enter-submits",
  modelSettingsToggle: 'button[aria-label="Expand or collapse Model settings"]',
  temperatureInput: 'input.slider-number-input[role="spinbutton"]',
  voiceSettingsCard: "ms-voice-settings",
  voiceCardFallback: ".active-voice-card",
  voiceCardTrigger:
    'button.active-voice-card-trigger, .active-voice-card-trigger, button[aria-label="Open voice settings"]',
  speakerAliasInput: 'input[aria-label="Speaker name"], input.speaker-alias-input',
  speakerAliasTag: ".speaker-alias-tag",
  voicePersonaTextarea: 'textarea[aria-label*="voice persona" i]',
  availableVoicesRegion:
    'mat-dialog-container, ms-speaker-settings-panel, [aria-label="Available voices"]',
  voiceSearchInput: 'input[aria-label="Search voices"], .voice-search-input input',
  closeDrawerButton:
    'button[aria-label="Close panel"], button[data-test-close-button], button[mat-dialog-close]',
  downloadButton: 'button.download-button[aria-label="Download"]',
  pauseAudioButton: [
    'button[aria-label="Pause"]:not(.ctrl-enter-submits)',
    'button[aria-label*="Pause audio" i]:not(.ctrl-enter-submits)',
    'button[aria-label*="Pause playback" i]:not(.ctrl-enter-submits)',
    'button[mattooltip="Pause"]:not(.ctrl-enter-submits)',
    'button:not(.ctrl-enter-submits):has(.material-symbols-outlined:text-is("pause"))',
    'button:not(.ctrl-enter-submits):has(.material-symbols-outlined:text-is("pause_circle"))',
  ].join(", "),
  errorBanner:
    '[role="alert"], [role="status"], mat-snack-bar-container, simple-snack-bar, .mdc-snackbar, [class*="error-banner" i], [class*="toast" i], [class*="snackbar" i]',
} as const;

const ERROR_TEXT_PATTERN =
  /Failed to generate content|Http response at 400 or 500 level|http status code:\s*(?:4\d\d|5\d\d)|permission denied|quota exceeded|rate limit|service unavailable|invalid argument|unauthenticated|forbidden/i;

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
 * Playwright CDP Worker cho Google AI Studio Speech Generation (`/generate-speech`)
 * trên tab Launcher đã đăng nhập sẵn để sinh audio WAV không cần `GEMINI_API_KEY`.
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
    page: Page,
    options: AiStudioSpeechRunOptions,
  ): Promise<AiStudioSpeechResult> {
    this.throwIfAborted(options.signal);

    const targetUrl = buildAiStudioSpeechUrl(options.modelId);
    const isAlreadyOnTargetSpeechUrl = (() => {
      try {
        const rawUrl = page.url();
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

    await this.prepareEditor(page, options.signal);

    const baselineAudioSrc = await page
      .evaluate(() => document.querySelector("audio")?.getAttribute("src") || "")
      .catch(() => "");

    const parsedScript = parseGeminiSpeechScript(options.text);

    await fillFieldNatural(
      page,
      SPEECH_SELECTORS.sceneTextarea,
      parsedScript.scene,
      true,
    );
    await fillFieldNatural(
      page,
      SPEECH_SELECTORS.sampleContextTextarea,
      parsedScript.sampleContext,
      true,
    );
    await fillFieldNatural(
      page,
      SPEECH_SELECTORS.promptTextarea,
      parsedScript.transcript,
      false,
    );

    // Chờ Angular cập nhật danh sách speaker cards tự nhiên như người đọc kiểm tra lại
    await humanPause(page, 650, 950);

    if (options.speakers.length > 0) {
      const orderedSpeakers = orderSpeakersByTranscript(
        options.speakers,
        parsedScript.transcript,
      );
      await this.configureSpeakers(
        page,
        orderedSpeakers,
        parsedScript.audioProfiles,
        parsedScript.directorNotes,
        Boolean(options.reusedSurface),
      );
    }

    if (typeof options.temperature === "number" && Number.isFinite(options.temperature)) {
      await this.configureTemperature(page, options.temperature);
    }

    await page
      .locator(SPEECH_SELECTORS.runButton)
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });

    if (!options.reusedSurface) {
      await waitForBotGuardReady(page, 2_000, 2_800).catch(() => {});
    }
    await humanPause(page, 650, 1_050);

    const inFlight = new Set<Request>();
    const onReq = (req: Request) => {
      if (isAiStudioGenerationRequest(req.url(), req.method())) inFlight.add(req);
    };
    const onDone = (req: Request) => inFlight.delete(req);
    page.on("request", onReq);
    page.on("requestfinished", onDone);
    page.on("requestfailed", onDone);

    try {
      await clickResilient(page.locator(SPEECH_SELECTORS.runButton).first(), 3_000);
      const result = await this.waitForGeneratedAudio(
        page,
        baselineAudioSrc,
        options,
        () => inFlight.size > 0,
      );
      await this.pauseGeneratedAudioPlayback(page);
      return result;
    } finally {
      page.off("request", onReq);
      page.off("requestfinished", onDone);
      page.off("requestfailed", onDone);
      inFlight.clear();
    }
  }

  private async prepareEditor(page: Page, signal?: AbortSignal): Promise<void> {
    const promptLocator = page.locator(SPEECH_SELECTORS.promptTextarea).first();
    const presetLocator = page.locator(SPEECH_SELECTORS.presetCoHost).first();
    const textToggle = page.locator(SPEECH_SELECTORS.textModeToggle).first();

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      this.throwIfAborted(signal);
      if (await promptLocator.isVisible().catch(() => false)) break;
      if (await textToggle.isVisible().catch(() => false)) break;
      if (await presetLocator.isVisible().catch(() => false)) {
        await humanPause(page, 350, 600);
        await clickResilient(presetLocator, 3_000);
        await humanPause(page, 400, 700);
        await textToggle.waitFor({ state: "visible", timeout: 15_000 }).catch(async () => {
          await promptLocator.waitFor({ state: "visible", timeout: 5_000 });
        });
        break;
      }
      await page.waitForTimeout(200);
    }

    if (await textToggle.isVisible().catch(() => false)) {
      const pressed = await textToggle.getAttribute("aria-pressed").catch(() => null);
      const checked = await textToggle.getAttribute("aria-checked").catch(() => null);
      if (pressed !== "true" && checked !== "true") {
        await humanPause(page, 300, 550);
        await clickResilient(textToggle, 3_000);
        await humanPause(page, 350, 600);
      }
    }

    await promptLocator.waitFor({ state: "visible", timeout: 15_000 });
  }

  private async configureTemperature(page: Page, temperature: number): Promise<void> {
    const input = page.locator(SPEECH_SELECTORS.temperatureInput).first();
    if (!(await input.isVisible().catch(() => false))) {
      const toggle = page.locator(SPEECH_SELECTORS.modelSettingsToggle).first();
      if (await toggle.isVisible().catch(() => false)) {
        await humanPause(page, 250, 450);
        await clickResilient(toggle, 2_000).catch(() => {});
        await input.waitFor({ state: "visible", timeout: 3_000 }).catch(() => {});
        await humanPause(page, 250, 450);
      }
    }
    if (await input.isVisible().catch(() => false)) {
      await input.click({ timeout: 2_000 }).catch(() => {});
      await humanPause(page, 180, 320);
      await input.fill(String(temperature));
      await page.keyboard.press("Enter").catch(() => {});
      await humanPause(page, 250, 450);
    }
  }

  private async setCardSpeakerAlias(
    page: Page,
    cardSelector: string,
    cardIndex: number,
    aliasValue: string,
  ): Promise<boolean> {
    const cleanTarget = aliasValue.trim();
    const card = page.locator(cardSelector).nth(cardIndex);
    const aliasInput = card.locator(SPEECH_SELECTORS.speakerAliasInput).first();
    const inputCount = await aliasInput.count().catch(() => 0);
    if (inputCount === 0) {
      console.warn(
        `[ai-studio-speech] setCardSpeakerAlias idx=${cardIndex}: input not found in ${cardSelector}`,
      );
      return false;
    }

    const currentAlias = ((await aliasInput.inputValue().catch(() => "")) || "").trim();
    if (currentAlias.toLowerCase() === cleanTarget.toLowerCase()) {
      return true;
    }

    await card.scrollIntoViewIfNeeded({ timeout: 1_500 }).catch(() => {});
    await card.hover({ timeout: 1_000 }).catch(() => {});
    const isVis = await aliasInput.isVisible().catch(() => false);

    if (isVis) {
      await aliasInput.hover({ timeout: 1_000 }).catch(() => {});
      await humanPause(page, 140, 260);
      await aliasInput.click({ timeout: 2_000 }).catch(() => {});
      await humanPause(page, 180, 320);
      await aliasInput.fill(cleanTarget).catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
      await aliasInput.evaluate((el) => (el as HTMLInputElement).blur()).catch(() => {});
    } else {
      await aliasInput.evaluate((el, valueToSet) => {
        const input = el as HTMLInputElement;
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set;
        if (setter) setter.call(input, valueToSet);
        else input.value = valueToSet;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        try {
          input.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              inputType: "insertText",
              data: valueToSet,
            }),
          );
        } catch {}
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.blur();
      }, cleanTarget);
    }

    await humanPause(page, 260, 440);
    const afterAlias = ((await aliasInput.inputValue().catch(() => "")) || "").trim();
    console.log(
      `[ai-studio-speech] setCardSpeakerAlias idx=${cardIndex} vis=${isVis} before="${currentAlias}" target="${cleanTarget}" after="${afterAlias}"`,
    );
    return afterAlias.toLowerCase() === cleanTarget.toLowerCase();
  }

  private async configureSpeakers(
    page: Page,
    orderedSpeakers: Array<{ speaker: string; voiceName: string }>,
    audioProfiles: Record<string, string>,
    directorNotes: Record<string, { style?: string; pace?: string; accent?: string }>,
    resetOptionalProfiles: boolean,
  ): Promise<void> {
    const primaryCount = await page
      .locator(SPEECH_SELECTORS.voiceSettingsCard)
      .count()
      .catch(() => 0);
    const cardSelector =
      primaryCount > 0
        ? SPEECH_SELECTORS.voiceSettingsCard
        : SPEECH_SELECTORS.voiceCardFallback;

    const readSnapshot = async () =>
      await page.evaluate(
        ({ cardSel, inputSel, tagSel, triggerSel }) => {
          return Array.from(document.querySelectorAll<HTMLElement>(cardSel)).map(
            (card, idx) => {
              const inputEl = card.querySelector<HTMLInputElement>(inputSel);
              const tagEl = card.querySelector<HTMLElement>(tagSel);
              const triggerEl = card.querySelector<HTMLElement>(triggerSel);
              const cardText = (card.innerText || card.textContent || "").trim();
              const lines = cardText
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter(Boolean);
              let alias = (inputEl?.value || tagEl?.textContent || "").trim();
              if (!alias) {
                const matched = lines.find((line) => /^speaker\s*\d+$/i.test(line));
                if (matched) alias = matched;
              }
              const voiceEl = card.querySelector(
                ".voice-display-name, .voice-name, [class*='voice-name' i]",
              );
              const rawTrigger = (
                voiceEl?.textContent ||
                triggerEl?.innerText ||
                triggerEl?.textContent ||
                ""
              ).trim();
              const voiceLines = rawTrigger
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter(Boolean);
              const currentVoice = (voiceLines[0] || lines[0] || "").trim();
              return {
                index: idx,
                alias,
                aliasLower: alias.toLowerCase(),
                hasAliasInput: Boolean(inputEl),
                currentVoice,
                currentVoiceLower: currentVoice.toLowerCase(),
              };
            },
          );
        },
        {
          cardSel: cardSelector,
          inputSel: SPEECH_SELECTORS.speakerAliasInput,
          tagSel: SPEECH_SELECTORS.speakerAliasTag,
          triggerSel: SPEECH_SELECTORS.voiceCardTrigger,
        },
      );

    const cardsBefore = await readSnapshot();
    console.log(
      `[ai-studio-speech] Speaker cards before: selector=${cardSelector} ordered=${JSON.stringify(
        orderedSpeakers.map((s) => `${s.speaker}:${s.voiceName}`),
      )} cards=${JSON.stringify(cardsBefore)}`,
    );
    if (cardsBefore.length === 0) return;

    const hasEditableAliasOutside = cardsBefore.some((c) => c.hasAliasInput);
    const assignments: Array<{
      cardIndex: number;
      config: { speaker: string; voiceName: string };
    }> = [];

    if (hasEditableAliasOutside) {
      // Đúng thứ tự mở đầu trong kịch bản: Card 0 = orderedSpeakers[0], Card 1 = orderedSpeakers[1]
      const currentAliases = cardsBefore.map((c) => c.aliasLower);
      const pairCount = Math.min(cardsBefore.length, orderedSpeakers.length);
      for (let i = 0; i < pairCount; i += 1) {
        const speakerConfig = orderedSpeakers[i];
        const targetName = speakerConfig.speaker.trim();
        const targetLower = targetName.toLowerCase();
        if (currentAliases[i] !== targetLower) {
          for (let j = i + 1; j < cardsBefore.length; j += 1) {
            if (currentAliases[j] === targetLower) {
              const tmpAlias = `__speaker_tmp_${j}__`;
              await this.setCardSpeakerAlias(page, cardSelector, j, tmpAlias);
              currentAliases[j] = tmpAlias;
            }
          }
          await this.setCardSpeakerAlias(page, cardSelector, i, targetName);
          currentAliases[i] = targetLower;
        }
        assignments.push({ cardIndex: i, config: speakerConfig });
      }
    } else {
      const usedIndices = new Set<number>();
      for (let i = 0; i < orderedSpeakers.length; i += 1) {
        const cfg = orderedSpeakers[i];
        const targetLower = cfg.speaker.trim().toLowerCase();
        const matched = cardsBefore.find(
          (c) => !usedIndices.has(c.index) && c.aliasLower === targetLower,
        );
        if (matched) {
          usedIndices.add(matched.index);
          assignments.push({ cardIndex: matched.index, config: cfg });
        } else {
          const fallback =
            cardsBefore.find((c) => !usedIndices.has(c.index)) ?? cardsBefore[i];
          if (fallback) {
            usedIndices.add(fallback.index);
            assignments.push({ cardIndex: fallback.index, config: cfg });
          }
        }
      }
    }

    for (const { cardIndex, config } of assignments) {
      const card = page.locator(cardSelector).nth(cardIndex);

      const key = config.speaker.trim().toLowerCase();
      const profileText = audioProfiles[key] || "";
      const note = directorNotes[key];
      const noteParts = note
        ? [
            note.style ? `Style: ${note.style}` : "",
            note.pace ? `Pace: ${note.pace}` : "",
            note.accent ? `Accent: ${note.accent}` : "",
          ].filter(Boolean)
        : [];
      const personaText = [profileText, noteParts.join(". ")].filter(Boolean).join("\n");
      const personaInput = card.locator(SPEECH_SELECTORS.voicePersonaTextarea).first();
      if ((personaText || resetOptionalProfiles) && (await personaInput.isVisible().catch(() => false))) {
        await personaInput.click({ timeout: 2_000 }).catch(() => {});
        await humanPause(page, 180, 320);
        await personaInput.fill(personaText);
        await humanPause(page, 300, 500);
      }

      const targetVoice = config.voiceName.trim();
      const targetVoiceLower = targetVoice.toLowerCase();

      const snapBeforeVoice = await readSnapshot();
      if (snapBeforeVoice[cardIndex]?.currentVoiceLower === targetVoiceLower) {
        continue;
      }

      const trigger = card.locator(SPEECH_SELECTORS.voiceCardTrigger).first();
      await humanPause(page, 280, 480);
      await clickResilient(trigger, 3_000);

      const voicesRegion = page.locator(SPEECH_SELECTORS.availableVoicesRegion).first();
      await voicesRegion.waitFor({ state: "visible", timeout: 5_000 });
      await humanPause(page, 400, 700);

      const findVoiceTarget = async (): Promise<Locator | null> => {
        const voiceCards = voicesRegion.locator(".voice-card");
        const vcCount = await voiceCards.count().catch(() => 0);
        for (let idx = 0; idx < vcCount; idx += 1) {
          const vc = voiceCards.nth(idx);
          const dataName = (await vc.getAttribute("data-voice-name").catch(() => "")) || "";
          const nameText =
            ((await vc.locator(".voice-name").first().innerText().catch(() => "")) || "").trim();
          if (
            dataName.trim().toLowerCase() === targetVoiceLower ||
            nameText.toLowerCase() === targetVoiceLower
          ) {
            const btn = vc.locator("button.voice-card-content").first();
            return (await btn.count().catch(() => 0)) > 0 ? btn : vc;
          }
        }
        const voiceButtons = voicesRegion.locator('button, [role="button"], [role="option"]');
        const count = await voiceButtons.count();
        for (let bIdx = 0; bIdx < count; bIdx += 1) {
          const btn = voiceButtons.nth(bIdx);
          const txt = ((await btn.innerText().catch(() => "")) || "").trim();
          const lines = txt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          if (
            lines.some((line) => line.toLowerCase() === targetVoiceLower) ||
            txt.toLowerCase().startsWith(targetVoiceLower)
          ) {
            return btn;
          }
        }
        return null;
      };

      let verified = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let targetBtn = await findVoiceTarget();
        if (!targetBtn) {
          const searchInput = voicesRegion.locator(SPEECH_SELECTORS.voiceSearchInput).first();
          if (await searchInput.isVisible().catch(() => false)) {
            await searchInput.click({ timeout: 2_000 }).catch(() => {});
            await humanPause(page, 160, 280);
            await searchInput.fill(targetVoice);
            await humanPause(page, 500, 750);
            targetBtn = await findVoiceTarget();
          }
        }
        if (!targetBtn) {
          throw new Error(
            `Could not find voice '${targetVoice}' in AI Studio Available voices`,
          );
        }

        await clickResilient(targetBtn, 3_000);
        await humanPause(page, 350, 550);

        const cardSnap = await readSnapshot();
        if (cardSnap[cardIndex]?.currentVoiceLower === targetVoiceLower) {
          verified = true;
          break;
        }
      }

      const closeBtn = page.locator(SPEECH_SELECTORS.closeDrawerButton).first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await humanPause(page, 220, 380);
        await clickResilient(closeBtn, 2_000).catch(() => {});
      }
      if (await voicesRegion.isVisible().catch(() => false)) {
        await page.keyboard.press("Escape").catch(() => {});
        await voicesRegion.waitFor({ state: "hidden", timeout: 2_000 }).catch(() => {});
      }
      await humanPause(page, 320, 550);

      if (!verified) {
        console.warn(
          `[ai-studio-speech] Could not confirm voice '${targetVoice}' on card #${cardIndex}`,
        );
      }
    }

    const finalCards = await readSnapshot();
    console.log(
      `[ai-studio-speech] Speaker cards configured (ordered): ${JSON.stringify(
        finalCards.map((c) => ({ index: c.index, alias: c.alias, voice: c.currentVoice })),
      )}`,
    );
  }

  private async waitForGeneratedAudio(
    page: Page,
    baselineAudioSrc: string,
    options: AiStudioSpeechRunOptions,
    hasNetworkInFlight: () => boolean,
  ): Promise<AiStudioSpeechResult> {
    const hardTimeoutMs = options.hardTimeoutMs ?? this.defaultHardTimeoutMs;
    const deadline = Date.now() + hardTimeoutMs;
    let lastHeartbeatAt = Date.now();
    let seenRunStart = false;

    while (Date.now() < deadline) {
      this.throwIfAborted(options.signal);

      if (
        options.heartbeat &&
        Date.now() - lastHeartbeatAt >= this.defaultHeartbeatIntervalMs
      ) {
        lastHeartbeatAt = Date.now();
        await options.heartbeat().catch(() => {});
      }

      const state = await page.evaluate(
        ({ errorSelector, runSelector, errorPatternSource }) => {
          const errorPattern = new RegExp(errorPatternSource, "i");
          let detectedError = "";
          for (const el of document.querySelectorAll<HTMLElement>(errorSelector)) {
            const text = (el.innerText || el.textContent || "").trim();
            if (text && errorPattern.test(text)) {
              detectedError = text.replace(/\s+/g, " ").slice(0, 300);
              break;
            }
          }
          const audioSrc = document.querySelector("audio")?.getAttribute("src") || "";
          const runBtn = document.querySelector<HTMLButtonElement>(runSelector);
          const runText = (
            runBtn?.innerText ||
            runBtn?.textContent ||
            ""
          )
            .trim()
            .toLowerCase();
          const isGenerating =
            runText.includes("stop") ||
            runText.includes("cancel") ||
            Boolean(runBtn?.disabled);
          return { detectedError, audioSrc, isGenerating };
        },
        {
          errorSelector: SPEECH_SELECTORS.errorBanner,
          runSelector: SPEECH_SELECTORS.runButton,
          errorPatternSource: ERROR_TEXT_PATTERN.source,
        },
      );

      if (state.detectedError && ERROR_TEXT_PATTERN.test(state.detectedError)) {
        throw new Error(`[AI Studio Web Error] ${state.detectedError}`);
      }

      if (state.isGenerating || hasNetworkInFlight()) {
        seenRunStart = true;
      }

      const hasNewAudio =
        Boolean(state.audioSrc) && state.audioSrc !== baselineAudioSrc;
      const readyAfterRun =
        hasNewAudio && !state.isGenerating && !hasNetworkInFlight();
      if (
        readyAfterRun &&
        (seenRunStart || state.audioSrc.startsWith("blob:"))
      ) {
        const extracted = await this.extractAudioPayload(page, state.audioSrc);
        if (extracted) return extracted;
      }

      await page.waitForTimeout(300);
    }

    throw new Error(
      `AI Studio speech generation timed out after ${hardTimeoutMs}ms`,
    );
  }

  private async extractAudioPayload(
    page: Page,
    audioSrc: string,
  ): Promise<AiStudioSpeechResult | null> {
    if (audioSrc) {
      const fetched = await page
        .evaluate(async (src) => {
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
        }, audioSrc)
        .catch(() => null);

      if (fetched && fetched.byteLength > 0 && fetched.audioBase64) {
        return {
          audioBase64: fetched.audioBase64,
          mimeType: fetched.mimeType,
        };
      }
    }

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

  /**
   * Dừng tự động phát (autoplay) sau khi Google AI Studio `/generate-speech` vừa sinh audio xong
   * (do tab speech được giữ lại tái sử dụng giữa các chunk).
   * - Ưu tiên click đúng nút Pause UI (chỉ khớp trạng thái Pause, không bao giờ bấm nhầm Play).
   * - Chỉ ép `audio.pause()` trong DOM khi nút UI không có hoặc vẫn đang phát, rồi cài guard 2s
   *   chống autoplay khởi động trễ (tự hủy ngay khi người dùng tương tác trên trang).
   */
  private async pauseGeneratedAudioPlayback(page: Page): Promise<void> {
    try {
      const pauseButton = page.locator(SPEECH_SELECTORS.pauseAudioButton).first();

      for (let attempt = 0; attempt < 5; attempt += 1) {
        let clickedThisRound = false;
        if (await pauseButton.isVisible().catch(() => false)) {
          await pauseButton.click({ timeout: 1_000 }).catch(() => {});
          clickedThisRound = true;
          await page.waitForTimeout(120);
        }

        const audioState = await page
          .evaluate(
            ({ action, allowDomPause }) => {
              if (action !== "checkAudioPlaybackState") return null;
              const audios = Array.from(document.querySelectorAll<HTMLAudioElement>("audio"));
              let playingCount = 0;
              for (const audio of audios) {
                if (!audio.paused) {
                  if (allowDomPause) {
                    try {
                      audio.pause();
                    } catch {}
                  }
                  if (!audio.paused) playingCount += 1;
                }
              }
              return { audioCount: audios.length, playingCount };
            },
            { action: "checkAudioPlaybackState", allowDomPause: !clickedThisRound },
          )
          .catch(() => null);

        if (!audioState) {
          return;
        }

        const stillHasPauseBtn = await pauseButton.isVisible().catch(() => false);
        if (audioState.playingCount === 0 && !stillHasPauseBtn && attempt >= 1) {
          break;
        }
        await page.waitForTimeout(180);
      }

      await page
        .evaluate(
          ({ action }) => {
            if (action !== "installLateAutoPauseGuard") return null;
            const win = window as unknown as {
              __codexSpeechAutoPauseUntil?: number;
              __codexSpeechGuardBound?: boolean;
            };
            win.__codexSpeechAutoPauseUntil = Date.now() + 2_000;

            for (const audio of document.querySelectorAll<HTMLAudioElement>("audio")) {
              if (!audio.paused) {
                try {
                  audio.pause();
                } catch {}
              }
            }

            if (!win.__codexSpeechGuardBound) {
              win.__codexSpeechGuardBound = true;
              const cancelGuard = () => {
                win.__codexSpeechAutoPauseUntil = 0;
              };
              document.addEventListener("pointerdown", cancelGuard, { capture: true, passive: true });
              document.addEventListener("keydown", cancelGuard, { capture: true, passive: true });
              document.addEventListener(
                "play",
                (evt) => {
                  const target = evt.target;
                  if (
                    target instanceof HTMLAudioElement &&
                    win.__codexSpeechAutoPauseUntil &&
                    Date.now() <= win.__codexSpeechAutoPauseUntil
                  ) {
                    try {
                      target.pause();
                    } catch {}
                  }
                },
                true,
              );
            }
            return true;
          },
          { action: "installLateAutoPauseGuard" },
        )
        .catch(() => null);
    } catch {
      // Không làm fail lượt tạo audio nếu nút Pause đã tự tắt hoặc UI player chưa render
    }
  }
}
