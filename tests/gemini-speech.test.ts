import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import {
  AiStudioSpeechWorker,
  buildAiStudioSpeechUrl,
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

describe("Gemini Speech (TTS / Podcast) via AI Studio UI", () => {
  test("parseGeminiSpeechScript tách đúng Scene, Sample Context, Transcript, Audio Profile và Director's note", () => {
    const parsed = parseGeminiSpeechScript(SAMPLE_PODCAST_PROMPT);
    expect(parsed.scene).toBe("A high-quality recording studio, two friends talking casually into dynamic mics.");
    expect(parsed.sampleContext).toBe("Podcast style. Fast, slightly overlapping pacing. Tone is energetic, conversational, and warm.");
    expect(parsed.transcript).toBe("Speaker 1: [enthusiastic] Welcome back to the show!\nSpeaker 2: [agreement] Exactly.");
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
  });

  test("configureSpeakers khớp đúng theo tên speaker ngay cả khi UI đảo Speaker 2 lên card đầu tiên", async () => {
    class TestSpeechWorker extends AiStudioSpeechWorker {
      public async testConfigureSpeakers(
        page: Page,
        speakers: Array<{ speaker: string; voiceName: string }>,
        rawText: string,
      ): Promise<void> {
        await (this as any).configureSpeakers(page, speakers, parseGeminiSpeechScript(rawText));
      }
    }

    const worker = new TestSpeechWorker();
    const selectedByCard: Array<{ cardAlias: string; voice: string }> = [];
    let openCardAlias = "";

    const makeCard = (alias: string) => ({
      locator: (selector: string) => {
        if (selector.includes("speaker-alias-input")) {
          return {
            first: () => ({
              inputValue: async () => alias,
              isVisible: async () => true,
              fill: async () => {},
              press: async () => {},
            }),
          };
        }
        if (selector.includes("active-voice-card-trigger")) {
          return {
            first: () => ({
              waitFor: async () => {},
              click: async () => {
                openCardAlias = alias;
              },
            }),
          };
        }
        return { first: () => ({ textContent: async () => alias }) };
      },
    });

    // Mô phỏng UI xếp Speaker 2 ở card 0 và Speaker 1 ở card 1 (trường hợp script bắt đầu bằng Speaker 2)
    const cards = [makeCard("Speaker 2"), makeCard("Speaker 1")];
    const voices = ["Puck", "Zephyr"];

    const fakePage = {
      waitForTimeout: async () => {},
      keyboard: { press: async () => {} },
      locator: (selector: string) => {
        if (selector === ".active-voice-card") {
          return {
            count: async () => cards.length,
            nth: (index: number) => cards[index],
          };
        }
        if (selector.includes("Available voices")) {
          return {
            first: () => ({
              waitFor: async () => {},
              locator: () => ({
                count: async () => voices.length,
                nth: (i: number) => ({
                  textContent: async () => voices[i],
                  click: async () => {
                    selectedByCard.push({ cardAlias: openCardAlias, voice: voices[i] });
                  },
                }),
              }),
            }),
          };
        }
        if (selector.includes("Close panel")) {
          return {
            first: () => ({
              isVisible: async () => true,
              click: async () => {},
            }),
          };
        }
        return {
          first: () => ({
            isVisible: async () => false,
            waitFor: async () => {},
          }),
        };
      },
    } as unknown as Page;

    await worker.testConfigureSpeakers(
      fakePage,
      [
        { speaker: "Speaker 1", voiceName: "Puck" },
        { speaker: "Speaker 2", voiceName: "Zephyr" },
      ],
      "Speaker 2: Chào bạn\nSpeaker 1: Xin chào!",
    );

    expect(selectedByCard).toEqual([
      { cardAlias: "Speaker 1", voice: "Puck" },
      { cardAlias: "Speaker 2", voice: "Zephyr" },
    ]);
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
      req: new Request("http://127.0.0.1/v1beta/models/gemini-2.5-pro-preview-tts:streamGenerateContent?key=fake", {
        method: "POST",
      }),
      modelId: "gemini-2.5-pro-preview-tts",
      method: "streamGenerateContent",
      raw: payload,
      adapterFactory,
    });
    expect(streamRes.status).toBe(200);
    const streamJson = await streamRes.json() as Array<any>;
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
      req: new Request("http://127.0.0.1/v1beta/models/gemini-2.5-pro-preview-tts:streamGenerateContent?alt=sse", {
        method: "POST",
      }),
      modelId: "gemini-2.5-pro-preview-tts",
      method: "streamGenerateContent",
      raw: payload,
      adapterFactory,
    });
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
    expect(await sseRes.text()).toContain(audioSampleBase64);

    const invalidTempRes = await service.executeSpeech({
      req: new Request("http://127.0.0.1/v1beta/models/gemini-2.5-pro-preview-tts:generateContent", {
        method: "POST",
      }),
      modelId: "gemini-2.5-pro-preview-tts",
      method: "generateContent",
      raw: { ...payload, generationConfig: { temperature: 99 } },
      adapterFactory,
    });
    expect(invalidTempRes.status).toBe(400);
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
      const body = await res.json() as Array<any>;
      expect(body[0].candidates[0].content.parts[0].inlineData.data).toBe(mockBase64);

      const swaggerHtml = readFileSync(join(process.cwd(), "docs", "swagger.html"), "utf8");
      expect(swaggerHtml).toContain("gemini-2.5-pro-preview-tts:streamGenerateContent");
    } finally {
      await server.stop(true);
    }
  });

  test("executeSpeech chuyển từ Composer sang Text trước khi chờ textarea Enter a prompt", async () => {
    const worker = new AiStudioSpeechWorker();
    let mode: "landing" | "composer" | "text" = "landing";
    let generated = false;
    const promptValues: string[] = [];

    const fakePage = {
      goto: async () => {},
      waitForTimeout: async () => {},
      evaluate: async (fn: any) => {
        const src = String(fn);
        if (src.includes("fetch(src)")) {
          return {
            mimeType: "audio/wav",
            audioBase64: Buffer.from("WAV_NEW").toString("base64"),
            byteLength: 7,
          };
        }
        if (src.includes("errorSelector")) {
          return {
            detectedError: "",
            audioSrc: generated ? "blob:https://aistudio.google.com/new-audio" : "https://www.gstatic.com/aistudio/tts/enthusiastic-co-host.wav",
            isGenerating: false,
          };
        }
        return "https://www.gstatic.com/aistudio/tts/enthusiastic-co-host.wav";
      },
      locator: (selector: string) => {
        if (selector.includes("The Energetic Co-Host")) {
          return {
            first: () => ({
              isVisible: async () => mode === "landing",
              click: async () => {
                mode = "composer";
              },
            }),
          };
        }
        if (selector.includes("toggle-button")) {
          return {
            first: () => ({
              isVisible: async () => mode !== "landing",
              waitFor: async () => {
                if (mode === "landing") throw new Error("not visible");
              },
              getAttribute: async () => (mode === "text" ? "true" : "false"),
              click: async () => {
                mode = "text";
              },
            }),
          };
        }
        if (selector.includes("Enter a prompt")) {
          return {
            first: () => ({
              isVisible: async () => mode === "text",
              waitFor: async () => {
                if (mode !== "text") throw new Error("Enter a prompt requires Text mode");
              },
              click: async () => {},
              fill: async (val: string) => {
                promptValues.push(val);
              },
            }),
          };
        }
        if (selector.includes("ctrl-enter-submits")) {
          return {
            first: () => ({
              waitFor: async () => {},
              click: async () => {
                generated = true;
              },
            }),
          };
        }
        if (selector === ".active-voice-card") {
          return { count: async () => 0 };
        }
        return {
          first: () => ({
            isVisible: async () => false,
            fill: async () => {},
          }),
        };
      },
    } as unknown as Page;

    const result = await worker.executeSpeech(fakePage, {
      modelId: "gemini-2.5-pro-preview-tts",
      text: "Speaker 1: Test Composer -> Text",
      speakers: [],
    });

    expect(mode as string).toBe("text");
    expect(promptValues).toEqual(["Speaker 1: Test Composer -> Text"]);
    expect(result.mimeType).toBe("audio/wav");
    expect(Buffer.from(result.audioBase64, "base64").toString()).toBe("WAV_NEW");
  });
});

