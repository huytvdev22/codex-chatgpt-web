import { readFileSync } from "node:fs";
import type { Locator, Page, Request } from "playwright-core";
import { AI_STUDIO_ORIGIN } from "../ai-studio/conversation-url";
import {
  AI_STUDIO_DEFAULT_TTS_MODEL,
  orderSpeakersByTranscript,
  parseGeminiSpeechScript,
  type AiStudioSpeechResult,
  type AiStudioSpeechRunOptions,
} from "../ai-studio/ai-studio-speech-worker";
import { isAiStudioGenerationRequest } from "./ai-studio-pw-browser-worker";

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
  errorBanner:
    '[role="alert"], [role="status"], mat-snack-bar-container, simple-snack-bar, .mdc-snackbar, [class*="error-banner" i], [class*="toast" i], [class*="snackbar" i]',
} as const;

const ERROR_TEXT_PATTERN =
  /Failed to generate content|Http response at 400 or 500 level|http status code:\s*(?:4\d\d|5\d\d)|permission denied|quota exceeded|rate limit|service unavailable|invalid argument|unauthenticated|forbidden/i;

export function buildAiStudioPlaywrightSpeechUrl(
  modelId = AI_STUDIO_DEFAULT_TTS_MODEL,
): string {
  const cleanModel =
    modelId.replace(/^ai-studio(?:-pw)?\//i, "").trim() ||
    AI_STUDIO_DEFAULT_TTS_MODEL;
  return `${AI_STUDIO_ORIGIN}/generate-speech?model=${encodeURIComponent(cleanModel)}`;
}

/**
 * Playwright CDP Worker cho Google AI Studio Speech Generation (`/generate-speech`)
 * nhằm test A/B song song với phiên bản `electron-control`.
 */
export class AiStudioPlaywrightSpeechWorker {
  private readonly defaultHardTimeoutMs = 5 * 60_000;
  private readonly defaultHeartbeatIntervalMs = 10_000;

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new DOMException("AI Studio PW speech generation aborted", "AbortError");
    }
  }

  private async humanPause(page: Page, minMs: number, maxMs: number): Promise<void> {
    const low = Math.max(0, Math.round(minMs));
    const high = Math.max(low, Math.round(maxMs));
    const duration = low === high ? low : low + Math.floor(Math.random() * (high - low + 1));
    await page.waitForTimeout(duration);
  }

  private async clickResilient(locator: Locator, timeoutMs = 3_000): Promise<void> {
    const page = locator.page();
    await locator.scrollIntoViewIfNeeded({ timeout: 1_500 }).catch(() => {});
    await locator.hover({ timeout: 1_000 }).catch(() => {});
    await this.humanPause(page, 140, 280);
    try {
      await locator.click({ timeout: timeoutMs });
    } catch (firstError) {
      try {
        await locator.click({ force: true, timeout: Math.min(timeoutMs, 1_500) });
      } catch {
        const clicked = await locator
          .evaluate((el) => {
            const node = el as HTMLElement;
            node.scrollIntoView?.({ block: "center", inline: "center" });
            node.click();
            return true;
          })
          .catch(() => false);
        if (!clicked) throw firstError;
      }
    }
  }

  private async fillFieldNatural(
    page: Page,
    selector: string,
    value: string,
    optional = false,
  ): Promise<void> {
    const loc = page.locator(selector).first();
    const visible = await loc.isVisible().catch(() => false);
    if (!visible) {
      if (optional) return;
      throw new Error(`Speech input not found: ${selector}`);
    }
    await loc.scrollIntoViewIfNeeded({ timeout: 1_500 }).catch(() => {});
    await loc.hover({ timeout: 1_000 }).catch(() => {});
    await this.humanPause(page, 160, 300);
    await loc.click({ timeout: 2_000 }).catch(() => {});
    await this.humanPause(page, 260, 460);
    await loc.fill(value);
    await this.humanPause(page, 380, 650);
  }

  public async executeSpeech(
    page: Page,
    options: AiStudioSpeechRunOptions,
  ): Promise<AiStudioSpeechResult> {
    this.throwIfAborted(options.signal);

    const targetUrl = buildAiStudioPlaywrightSpeechUrl(options.modelId);
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

    await this.fillFieldNatural(
      page,
      SPEECH_SELECTORS.sceneTextarea,
      parsedScript.scene,
      true,
    );
    await this.fillFieldNatural(
      page,
      SPEECH_SELECTORS.sampleContextTextarea,
      parsedScript.sampleContext,
      true,
    );
    await this.fillFieldNatural(
      page,
      SPEECH_SELECTORS.promptTextarea,
      parsedScript.transcript,
      false,
    );

    // Chờ Angular cập nhật danh sách speaker cards tự nhiên như người đọc kiểm tra lại
    await this.humanPause(page, 650, 950);

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
      await this.waitForBotGuardReady(page, 2_000, 2_800).catch(() => {});
    }
    await this.humanPause(page, 650, 1_050);

    const inFlight = new Set<Request>();
    const onReq = (req: Request) => {
      if (isAiStudioGenerationRequest(req.url(), req.method())) inFlight.add(req);
    };
    const onDone = (req: Request) => inFlight.delete(req);
    page.on("request", onReq);
    page.on("requestfinished", onDone);
    page.on("requestfailed", onDone);

    try {
      await this.clickResilient(page.locator(SPEECH_SELECTORS.runButton).first(), 3_000);
      return await this.waitForGeneratedAudio(
        page,
        baselineAudioSrc,
        options,
        () => inFlight.size > 0,
      );
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
        await this.humanPause(page, 350, 600);
        await this.clickResilient(presetLocator, 3_000);
        await this.humanPause(page, 400, 700);
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
        await this.humanPause(page, 300, 550);
        await this.clickResilient(textToggle, 3_000);
        await this.humanPause(page, 350, 600);
      }
    }

    await promptLocator.waitFor({ state: "visible", timeout: 15_000 });
  }

  private async waitForBotGuardReady(
    page: Page,
    minPageAgeMs: number,
    maxWaitMs: number,
  ): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < maxWaitMs) {
      const probe = await page
        .evaluate(() => {
          const resources = performance.getEntriesByType("resource") || [];
          const waaReady = resources.some((entry) => {
            const name = String(entry?.name || "");
            return (
              /waa-pa\.clients6\.google\.com|google\.com\/js\/th/i.test(name) &&
              (!Number.isFinite((entry as PerformanceResourceTiming)?.responseEnd) ||
                (entry as PerformanceResourceTiming).responseEnd > 0)
            );
          });
          return { waaReady, pageAgeMs: performance.now() };
        })
        .catch(() => ({ waaReady: false, pageAgeMs: 0 }));

      if (probe.waaReady && probe.pageAgeMs >= minPageAgeMs) return;
      await page.waitForTimeout(150);
    }
  }

  private async configureTemperature(page: Page, temperature: number): Promise<void> {
    const input = page.locator(SPEECH_SELECTORS.temperatureInput).first();
    if (!(await input.isVisible().catch(() => false))) {
      const toggle = page.locator(SPEECH_SELECTORS.modelSettingsToggle).first();
      if (await toggle.isVisible().catch(() => false)) {
        await this.humanPause(page, 250, 450);
        await this.clickResilient(toggle, 2_000).catch(() => {});
        await input.waitFor({ state: "visible", timeout: 3_000 }).catch(() => {});
        await this.humanPause(page, 250, 450);
      }
    }
    if (await input.isVisible().catch(() => false)) {
      await input.click({ timeout: 2_000 }).catch(() => {});
      await this.humanPause(page, 180, 320);
      await input.fill(String(temperature));
      await page.keyboard.press("Enter").catch(() => {});
      await this.humanPause(page, 250, 450);
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
        `[ai-studio-pw-speech] setCardSpeakerAlias idx=${cardIndex}: input not found in ${cardSelector}`,
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
      await this.humanPause(page, 140, 260);
      await aliasInput.click({ timeout: 2_000 }).catch(() => {});
      await this.humanPause(page, 180, 320);
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

    await this.humanPause(page, 260, 440);
    const afterAlias = ((await aliasInput.inputValue().catch(() => "")) || "").trim();
    console.log(
      `[ai-studio-pw-speech] setCardSpeakerAlias idx=${cardIndex} vis=${isVis} before="${currentAlias}" target="${cleanTarget}" after="${afterAlias}"`,
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
      `[ai-studio-pw-speech] Speaker cards before: selector=${cardSelector} ordered=${JSON.stringify(
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
        await this.humanPause(page, 180, 320);
        await personaInput.fill(personaText);
        await this.humanPause(page, 300, 500);
      }

      const targetVoice = config.voiceName.trim();
      const targetVoiceLower = targetVoice.toLowerCase();

      const snapBeforeVoice = await readSnapshot();
      if (snapBeforeVoice[cardIndex]?.currentVoiceLower === targetVoiceLower) {
        continue;
      }

      const trigger = card.locator(SPEECH_SELECTORS.voiceCardTrigger).first();
      await this.humanPause(page, 280, 480);
      await this.clickResilient(trigger, 3_000);

      const voicesRegion = page.locator(SPEECH_SELECTORS.availableVoicesRegion).first();
      await voicesRegion.waitFor({ state: "visible", timeout: 5_000 });
      await this.humanPause(page, 400, 700);

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
            await this.humanPause(page, 160, 280);
            await searchInput.fill(targetVoice);
            await this.humanPause(page, 500, 750);
            targetBtn = await findVoiceTarget();
          }
        }
        if (!targetBtn) {
          throw new Error(
            `Could not find voice '${targetVoice}' in AI Studio Available voices`,
          );
        }

        await this.clickResilient(targetBtn, 3_000);
        await this.humanPause(page, 350, 550);

        const cardSnap = await readSnapshot();
        if (cardSnap[cardIndex]?.currentVoiceLower === targetVoiceLower) {
          verified = true;
          break;
        }
      }

      const closeBtn = page.locator(SPEECH_SELECTORS.closeDrawerButton).first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await this.humanPause(page, 220, 380);
        await this.clickResilient(closeBtn, 2_000).catch(() => {});
      }
      if (await voicesRegion.isVisible().catch(() => false)) {
        await page.keyboard.press("Escape").catch(() => {});
        await voicesRegion.waitFor({ state: "hidden", timeout: 2_000 }).catch(() => {});
      }
      await this.humanPause(page, 320, 550);

      if (!verified) {
        console.warn(
          `[ai-studio-pw-speech] Could not confirm voice '${targetVoice}' on card #${cardIndex}`,
        );
      }
    }

    const finalCards = await readSnapshot();
    console.log(
      `[ai-studio-pw-speech] Speaker cards configured (ordered): ${JSON.stringify(
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
        throw new Error(`[AI Studio PW Web Error] ${state.detectedError}`);
      }

      if (state.isGenerating || hasNetworkInFlight()) {
        seenRunStart = true;
      }

      const hasNewAudio =
        Boolean(state.audioSrc) && state.audioSrc !== baselineAudioSrc;
      const readyAfterRun =
        hasNewAudio && !state.isGenerating && !hasNetworkInFlight();
      if (
        readyAfterRun ||
        (seenRunStart &&
          !state.isGenerating &&
          !hasNetworkInFlight() &&
          state.audioSrc.startsWith("blob:"))
      ) {
        const extracted = await this.extractAudioPayload(page, state.audioSrc);
        if (extracted) return extracted;
      }

      await page.waitForTimeout(300);
    }

    throw new Error(
      `AI Studio PW speech generation timed out after ${hardTimeoutMs}ms`,
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
}
