import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import {
  AiStudioSpeechWorker,
  buildAiStudioSpeechUrl,
  orderSpeakersByTranscript,
  parseGeminiSpeechScript,
} from "../src/adapters/ai-studio";
import type { SpeechTurnRequest } from "../src/adapters/base";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";
import { GeminiSpeechService } from "../src/services/gemini-speech-service";

const SAMPLE_PODCAST_PROMPT = [
  "Read the following transcript based on the audio profile and director's note.",
  "",
  "# Audio Profile",
  "For Speaker 1: An authoritative main news anchor.",
  "For Speaker 2: A professional field correspondent.",
  "",
  "# Director's note",
  "For Speaker 1: Style: Vocal Smile. Pace: Rapid Fire. Accent: American (Gen).",
  "For Speaker 2: Style: Newscaster. Pace: Rapid Fire. Accent: American (Gen).",
  "",
  "## Scene:",
  "A high-quality recording studio, two friends talking casually into dynamic mics.",
  "",
  "## Sample Context:",
  "Podcast style. Fast, slightly overlapping pacing. Tone is energetic, conversational, and warm.",
  "",
  "## Transcript:",
  "Speaker 1: [enthusiastic] Welcome back to the show!",
  "Speaker 2: [agreement] Exactly.",
].join("\n");

interface MockSpeechPageOptions {
  initialUrl?: string;
  baselineAudioSrc?: string;
  cards?: Array<{ alias: string; voice: string }>;
  availableVoices?: string[];
  pollStates?: Array<{ detectedError: string; audioSrc: string; isGenerating: boolean }>;
  onBotGuardProbe?: () => void;
  audioBytesText?: string;
  autoPlayOnGenerate?: boolean;
  hasPauseButton?: boolean;
}

function createMockSpeechPage(opts: MockSpeechPageOptions = {}) {
  let currentUrl =
    opts.initialUrl ??
    "https://aistudio.google.com/generate-speech?model=gemini-2.5-pro-preview-tts";
  const cards = opts.cards ?? [];
  const availableVoices = opts.availableVoices ?? ["Callirrhoe", "Umbriel", "Charon", "Aoede"];
  const filledFields: Record<string, string> = {};
  const gotoUrls: string[] = [];
  let drawerOpen = false;
  let openedCardIdx = -1;
  let runClicked = false;
  let audioPlaying = false;
  let pauseClickedCount = 0;
  let lateGuardInstalled = false;
  let pollIdx = 0;
  let botGuardProbeCount = 0;

  const makeSimpleLoc = (sel: string, visible = true) => {
    const isPauseSel = sel.includes('aria-label="Pause"');
    const loc: Record<string, unknown> = {
      page: () => page,
      first: () => loc,
      waitFor: async () => {},
      isVisible: async () =>
        isPauseSel ? audioPlaying && opts.hasPauseButton !== false : visible,
      count: async () => (visible ? 1 : 0),
      getAttribute: async () => (sel.includes("TEXT") ? "true" : null),
      scrollIntoViewIfNeeded: async () => {},
      hover: async () => {},
      click: async () => {
        if (isPauseSel) {
          pauseClickedCount += 1;
          audioPlaying = false;
          return;
        }
        if (sel.includes("ctrl-enter-submits")) {
          runClicked = true;
          if (opts.autoPlayOnGenerate) audioPlaying = true;
        }
      },
      fill: async (val: string) => {
        filledFields[sel] = val;
      },
    };
    return loc;
  };

  const voicesRegion = {
    first: () => voicesRegion,
    waitFor: async () => {},
    isVisible: async () => drawerOpen,
    locator: (sel: string) => {
      if (sel === ".voice-card") {
        return {
          count: async () => availableVoices.length,
          nth: (vIdx: number) => ({
            getAttribute: async () => availableVoices[vIdx],
            locator: () => ({
              first: () => ({
                innerText: async () => availableVoices[vIdx],
                count: async () => 1,
                page: () => page,
                scrollIntoViewIfNeeded: async () => {},
                hover: async () => {},
                click: async () => {
                  if (openedCardIdx >= 0) cards[openedCardIdx].voice = availableVoices[vIdx];
                },
              }),
            }),
          }),
        };
      }
      return { count: async () => 0, first: () => ({ isVisible: async () => false }) };
    },
  };

  const makeCardLocator = (cardIdx: number) => ({
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    locator: (sel: string) => {
      if (sel.includes("speaker-alias-input")) {
        const aliasLoc = {
          first: () => aliasLoc,
          count: async () => 1,
          isVisible: async () => false,
          inputValue: async () => cards[cardIdx].alias,
          evaluate: async (_fn: unknown, arg?: string) => {
            if (typeof arg === "string") cards[cardIdx].alias = arg;
          },
        };
        return aliasLoc;
      }
      if (sel.includes("voice-persona")) {
        return { first: () => ({ isVisible: async () => false }) };
      }
      if (sel.includes("active-voice-card-trigger")) {
        return {
          first: () => ({
            page: () => page,
            scrollIntoViewIfNeeded: async () => {},
            hover: async () => {},
            click: async () => {
              openedCardIdx = cardIdx;
              drawerOpen = true;
            },
          }),
        };
      }
      return { first: () => ({ isVisible: async () => false, count: async () => 0 }) };
    },
  });

  const page = {
    url: () => currentUrl,
    goto: async (url: string) => {
      currentUrl = url;
      gotoUrls.push(url);
    },
    waitForTimeout: async () => {},
    keyboard: {
      press: async () => {
        drawerOpen = false;
      },
    },
    on: () => {},
    off: () => {},
    locator: (sel: string) => {
      if (sel === "ms-voice-settings") {
        return {
          count: async () => cards.length,
          nth: (idx: number) => makeCardLocator(idx),
        };
      }
      if (sel.includes("Available voices") || sel.includes("mat-dialog-container")) {
        return voicesRegion;
      }
      if (sel.includes("Close panel")) {
        return {
          first: () => ({
            page: () => page,
            isVisible: async () => drawerOpen,
            scrollIntoViewIfNeeded: async () => {},
            hover: async () => {},
            click: async () => {
              drawerOpen = false;
            },
          }),
        };
      }
      if (sel.includes("Scene") || sel.includes("Sample Context")) {
        return makeSimpleLoc(sel, false);
      }
      return makeSimpleLoc(sel, true);
    },
    evaluate: async (fn: unknown, arg?: unknown) => {
      if (typeof arg === "string") {
        const text = opts.audioBytesText ?? `WAV_FROM_${arg}`;
        return {
          mimeType: "audio/wav",
          audioBase64: Buffer.from(text).toString("base64"),
          byteLength: text.length,
        };
      }
      if (arg && typeof arg === "object" && "cardSel" in (arg as Record<string, unknown>)) {
        return cards.map((c, idx) => ({
          index: idx,
          alias: c.alias,
          aliasLower: c.alias.toLowerCase(),
          hasAliasInput: true,
          currentVoice: c.voice,
          currentVoiceLower: c.voice.toLowerCase(),
        }));
      }
      if (arg && typeof arg === "object" && "action" in (arg as Record<string, unknown>)) {
        const typedArg = arg as { action: string; allowDomPause?: boolean };
        if (typedArg.action === "checkAudioPlaybackState") {
          if (audioPlaying && typedArg.allowDomPause) {
            audioPlaying = false;
          }
          return { audioCount: 1, playingCount: audioPlaying ? 1 : 0 };
        }
        if (typedArg.action === "installLateAutoPauseGuard") {
          lateGuardInstalled = true;
          audioPlaying = false;
          return true;
        }
      }
      if (arg && typeof arg === "object" && "errorSelector" in (arg as Record<string, unknown>)) {
        if (opts.pollStates && opts.pollStates.length > 0) {
          const idx = Math.min(pollIdx, opts.pollStates.length - 1);
          pollIdx += 1;
          return opts.pollStates[idx];
        }
        return {
          detectedError: "",
          audioSrc: runClicked ? "blob:https://aistudio.google.com/new-audio" : opts.baselineAudioSrc ?? "",
          isGenerating: false,
        };
      }
      const fnSrc = String(fn);
      if (fnSrc.includes("querySelector(\"audio\")")) {
        return opts.baselineAudioSrc ?? "";
      }
      if (fnSrc.includes("waa-pa")) {
        botGuardProbeCount += 1;
        opts.onBotGuardProbe?.();
        return { waaReady: true, pageAgeMs: 2_500 };
      }
      return null;
    },
  };

  return {
    page: page as unknown as Page,
    cards,
    filledFields,
    gotoUrls,
    getBotGuardProbeCount: () => botGuardProbeCount,
    getPauseClickedCount: () => pauseClickedCount,
    isAudioPlaying: () => audioPlaying,
    isLateGuardInstalled: () => lateGuardInstalled,
  };
}

describe("Gemini Speech (TTS / Podcast) via AI Studio UI", () => {
  test("parseGeminiSpeechScript tách đúng Scene, Sample Context, Transcript, Audio Profile và Director's note", () => {
    const parsed = parseGeminiSpeechScript(SAMPLE_PODCAST_PROMPT);
    expect(parsed.scene).toBe(
      "A high-quality recording studio, two friends talking casually into dynamic mics.",
    );
    expect(parsed.sampleContext).toBe(
      "Podcast style. Fast, slightly overlapping pacing. Tone is energetic, conversational, and warm.",
    );
    expect(parsed.transcript).toBe(
      "Speaker 1: [enthusiastic] Welcome back to the show!\nSpeaker 2: [agreement] Exactly.",
    );
    expect(parsed.audioProfiles["speaker 1"]).toBe("An authoritative main news anchor.");
    expect(parsed.audioProfiles["speaker 2"]).toBe("A professional field correspondent.");
    expect(parsed.directorNotes["speaker 1"]).toEqual({
      style: "Vocal Smile",
      pace: "Rapid Fire",
      accent: "American (Gen)",
    });

    const plain = parseGeminiSpeechScript("Speaker 2: Hello!\nSpeaker 1: Hi!");
    expect(plain.scene).toBe("");
    expect(plain.sampleContext).toBe("");
    expect(plain.transcript).toBe("Speaker 2: Hello!\nSpeaker 1: Hi!");

    expect(buildAiStudioSpeechUrl("gemini-2.5-pro-preview-tts")).toBe(
      "https://aistudio.google.com/generate-speech?model=gemini-2.5-pro-preview-tts",
    );
    expect(buildAiStudioSpeechUrl("ai-studio/gemini-2.5-flash-preview-tts")).toBe(
      "https://aistudio.google.com/generate-speech?model=gemini-2.5-flash-preview-tts",
    );
  });

  test("orderSpeakersByTranscript & AiStudioSpeechWorker đảo thứ tự Card 0 ⇄ Card 1 theo speaker mở đầu", async () => {
    const ordered = orderSpeakersByTranscript(
      [
        { speaker: "Speaker 1", voiceName: "Umbriel" },
        { speaker: "Speaker 2", voiceName: "Callirrhoe" },
      ],
      "Speaker 2: [agreement] Exactly.\nSpeaker 1: [enthusiastic] Welcome back!",
    );
    expect(ordered).toEqual([
      { speaker: "Speaker 2", voiceName: "Callirrhoe" },
      { speaker: "Speaker 1", voiceName: "Umbriel" },
    ]);

    const worker = new AiStudioSpeechWorker();
    const mock = createMockSpeechPage({
      cards: [
        { alias: "Speaker 1", voice: "Puck" },
        { alias: "Speaker 2", voice: "Zephyr" },
      ],
      audioBytesText: "WAV_SPEAKERS",
    });

    const result = await worker.executeSpeech(mock.page, {
      modelId: "gemini-2.5-pro-preview-tts",
      text: "Speaker 2: Chào bạn\nSpeaker 1: Xin chào!",
      speakers: [
        { speaker: "Speaker 1", voiceName: "Umbriel" },
        { speaker: "Speaker 2", voiceName: "Callirrhoe" },
      ],
    });

    expect(mock.cards).toEqual([
      { alias: "Speaker 2", voice: "Callirrhoe" },
      { alias: "Speaker 1", voice: "Umbriel" },
    ]);
    expect(Buffer.from(result.audioBase64, "base64").toString()).toBe("WAV_SPEAKERS");
  });

  test("GeminiSpeechService hỗ trợ generateContent, streamGenerateContent (JSON array & SSE) và validate payload", async () => {
    const service = new GeminiSpeechService();
    const seenRequests: SpeechTurnRequest[] = [];
    const audioSampleBase64 = Buffer.from("RIFF_MOCK_WAV_BYTES").toString("base64");

    const adapterFactory = () => ({
      name: "ai-studio",
      runTurn: async () => {},
      runSpeechTurn: async (req: SpeechTurnRequest) => {
        seenRequests.push(req);
        return { audioBase64: audioSampleBase64, mimeType: "audio/wav" };
      },
    });

    const payload = {
      contents: [{ role: "user", parts: [{ text: SAMPLE_PODCAST_PROMPT }] }],
      generationConfig: {
        responseModalities: ["audio"],
        temperature: 1,
        speech_config: {
          multi_speaker_voice_config: {
            speaker_voice_configs: [
              { speaker: "Speaker 1", voice_config: { prebuilt_voice_config: { voice_name: "Puck" } } },
              { speaker: "Speaker 2", voice_config: { prebuilt_voice_config: { voice_name: "Zephyr" } } },
            ],
          },
        },
      },
    };

    const streamRes = await service.executeSpeech({
      req: new Request(
        "http://127.0.0.1/v1beta/models/gemini-2.5-pro-preview-tts:streamGenerateContent?key=fake",
        { method: "POST" },
      ),
      modelId: "gemini-2.5-pro-preview-tts",
      method: "streamGenerateContent",
      raw: payload,
      adapterFactory,
    });
    expect(streamRes.status).toBe(200);
    const streamJson = (await streamRes.json()) as Array<any>;
    expect(Array.isArray(streamJson)).toBe(true);
    expect(streamJson[0].candidates[0].content.parts[0].inlineData).toEqual({
      mimeType: "audio/wav",
      data: audioSampleBase64,
    });
    expect(seenRequests[0].speakers).toEqual([
      { speaker: "Speaker 1", voiceName: "Puck" },
      { speaker: "Speaker 2", voiceName: "Zephyr" },
    ]);

    const sseRes = await service.executeSpeech({
      req: new Request(
        "http://127.0.0.1/v1beta/models/gemini-2.5-pro-preview-tts:streamGenerateContent?alt=sse",
        { method: "POST" },
      ),
      modelId: "gemini-2.5-pro-preview-tts",
      method: "streamGenerateContent",
      raw: payload,
      adapterFactory,
    });
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
    expect(await sseRes.text()).toContain(audioSampleBase64);

    const invalidTempRes = await service.executeSpeech({
      req: new Request(
        "http://127.0.0.1/v1beta/models/gemini-2.5-pro-preview-tts:generateContent",
        { method: "POST" },
      ),
      modelId: "gemini-2.5-pro-preview-tts",
      method: "generateContent",
      raw: { ...payload, generationConfig: { temperature: 99 } },
      adapterFactory,
    });
    expect(invalidTempRes.status).toBe(400);

    const profiledRes = await service.executeSpeech({
      req: new Request(
        "http://127.0.0.1/v1beta/models/gemini-2.5-pro-preview-tts:generateContent",
        { method: "POST", headers: { "x-gateway-profile-id": "Account-2" } },
      ),
      modelId: "gemini-2.5-pro-preview-tts",
      method: "generateContent",
      raw: payload,
      adapterFactory,
    });
    expect(profiledRes.status).toBe(200);
    expect(seenRequests.at(-1)?.profileId).toBe("account-2");
  });

  test("HTTP server định tuyến POST /v1beta/models/:model:streamGenerateContent và Swagger có tài liệu TTS", async () => {
    const cfg = defaultConfig("browser-only");
    cfg.port = 0;
    const mockBase64 = Buffer.from("WAV_OK").toString("base64");

    const server = startServer(cfg, {
      adapterFactory: () => ({
        name: "ai-studio",
        runTurn: async () => {},
        runSpeechTurn: async () => ({ audioBase64: mockBase64, mimeType: "audio/wav" }),
      }),
    });

    try {
      const res = await fetch(
        `http://127.0.0.1:${server.port}/v1beta/models/gemini-2.5-pro-preview-tts:streamGenerateContent?key=dummy`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "Speaker 1: Hello!" }] }],
            generationConfig: { responseModalities: ["audio"], temperature: 1 },
          }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<any>;
      expect(body[0].candidates[0].content.parts[0].inlineData.data).toBe(mockBase64);

      const swaggerHtml = readFileSync(join(process.cwd(), "docs", "swagger.html"), "utf8");
      expect(swaggerHtml).toContain("gemini-2.5-pro-preview-tts:streamGenerateContent");
    } finally {
      await server.stop(true);
    }
  });

  test("executeSpeech điều phối qua Playwright Page, điền transcript, cấu hình temperature và trích xuất WAV", async () => {
    const worker = new AiStudioSpeechWorker();
    const mock = createMockSpeechPage({
      initialUrl: "https://aistudio.google.com/prompts/new_chat",
      baselineAudioSrc: "https://www.gstatic.com/aistudio/tts/enthusiastic-co-host.wav",
      cards: [{ alias: "Speaker 1", voice: "Puck" }],
      audioBytesText: "WAV_NEW",
    });

    const result = await worker.executeSpeech(mock.page, {
      modelId: "gemini-2.5-pro-preview-tts",
      text: "Speaker 1: Test Playwright TTS",
      temperature: 0.9,
      speakers: [{ speaker: "Speaker 1", voiceName: "Charon" }],
    });

    expect(mock.gotoUrls).toEqual([
      "https://aistudio.google.com/generate-speech?model=gemini-2.5-pro-preview-tts",
    ]);
    expect(mock.filledFields['textarea[aria-label="Enter a prompt"]']).toBe(
      "Speaker 1: Test Playwright TTS",
    );
    expect(mock.filledFields['input.slider-number-input[role="spinbutton"]']).toBe("0.9");
    expect(mock.cards[0]?.voice).toBe("Charon");
    expect(mock.getBotGuardProbeCount()).toBeGreaterThan(0);
    expect(result.mimeType).toBe("audio/wav");
    expect(Buffer.from(result.audioBase64, "base64").toString()).toBe("WAV_NEW");
  });

  test("waitForGeneratedAudio fail-fast ngay khi AI Studio hiện banner lỗi HTTP 403 / 400-500", async () => {
    const worker = new AiStudioSpeechWorker();
    const mock = createMockSpeechPage({
      pollStates: [
        {
          detectedError: "Http response at 400 or 500 level, error: , http status code: 403",
          audioSrc: "",
          isGenerating: false,
        },
      ],
    });

    await expect(
      (worker as any).waitForGeneratedAudio(
        mock.page,
        "",
        {
          modelId: "gemini-2.5-pro-preview-tts",
          text: "hi",
          speakers: [],
        },
        () => false,
      ),
    ).rejects.toThrow("http status code: 403");
  });

  test("executeSpeech bỏ qua page.goto nếu tab Launcher đã mở sẵn đúng URL /generate-speech?model=...", async () => {
    const worker = new AiStudioSpeechWorker();
    const mock = createMockSpeechPage({
      initialUrl: "https://aistudio.google.com/generate-speech?model=gemini-2.5-pro-preview-tts",
      audioBytesText: "WAV_PRELOADED",
    });

    const result = await worker.executeSpeech(mock.page, {
      modelId: "gemini-2.5-pro-preview-tts",
      text: "Speaker 1: Preloaded tab test",
      speakers: [],
    });

    expect(mock.gotoUrls).toEqual([]);
    expect(Buffer.from(result.audioBase64, "base64").toString()).toBe("WAV_PRELOADED");
  });

  test("executeSpeech tái sử dụng tab không bốc nhầm audio blob cũ của lượt trước và bỏ qua BotGuard wait", async () => {
    const worker = new AiStudioSpeechWorker();
    const mock = createMockSpeechPage({
      initialUrl: "https://aistudio.google.com/generate-speech?model=gemini-2.5-pro-preview-tts",
      baselineAudioSrc: "blob:https://aistudio.google.com/chunk-1-old",
      cards: [
        { alias: "Minh", voice: "Charon" },
        { alias: "Linh", voice: "Aoede" },
      ],
      pollStates: [
        {
          detectedError: "",
          audioSrc: "blob:https://aistudio.google.com/chunk-1-old",
          isGenerating: true,
        },
        {
          detectedError: "",
          audioSrc: "blob:https://aistudio.google.com/chunk-1-old",
          isGenerating: false,
        },
        {
          detectedError: "",
          audioSrc: "blob:https://aistudio.google.com/chunk-2-new",
          isGenerating: false,
        },
      ],
    });

    const result = await worker.executeSpeech(mock.page, {
      modelId: "gemini-2.5-pro-preview-tts",
      text: "Linh: Chunk 2\nMinh: Ok",
      speakers: [
        { speaker: "Minh", voiceName: "Charon" },
        { speaker: "Linh", voiceName: "Aoede" },
      ],
      reusedSurface: true,
    });

    expect(mock.getBotGuardProbeCount()).toBe(0);
    expect(mock.cards).toEqual([
      { alias: "Linh", voice: "Aoede" },
      { alias: "Minh", voice: "Charon" },
    ]);
    expect(Buffer.from(result.audioBase64, "base64").toString()).toBe(
      "WAV_FROM_blob:https://aistudio.google.com/chunk-2-new",
    );
  });

  test("executeSpeech tự động click nút Pause UI sau khi tạo voice xong để dừng autoplay", async () => {
    const worker = new AiStudioSpeechWorker();
    const mock = createMockSpeechPage({
      autoPlayOnGenerate: true,
      hasPauseButton: true,
    });

    await worker.executeSpeech(mock.page, {
      modelId: "gemini-2.5-pro-preview-tts",
      text: "Speaker 1: Auto pause test",
      speakers: [],
    });

    expect(mock.getPauseClickedCount()).toBe(1);
    expect(mock.isAudioPlaying()).toBe(false);
    expect(mock.isLateGuardInstalled()).toBe(true);
  });

  test("executeSpeech ép dừng DOM <audio> khi không thấy nút Pause UI mà trình phát vẫn đang chạy", async () => {
    const worker = new AiStudioSpeechWorker();
    const mock = createMockSpeechPage({
      autoPlayOnGenerate: true,
      hasPauseButton: false,
    });

    await worker.executeSpeech(mock.page, {
      modelId: "gemini-2.5-pro-preview-tts",
      text: "Speaker 1: DOM pause fallback test",
      speakers: [],
    });

    expect(mock.getPauseClickedCount()).toBe(0);
    expect(mock.isAudioPlaying()).toBe(false);
    expect(mock.isLateGuardInstalled()).toBe(true);
  });
});
