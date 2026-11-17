import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ElectronSurfaceClient } from "../src/adapters/web/electron-surface-client";
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

  test("orderSpeakersByTranscript & executeSpeech đồng bộ thứ tự card khớp thứ tự xuất hiện trong transcript", async () => {
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
    let capturedSpeakerArgs: Record<string, unknown> | null = null;
    let generated = false;

    const client = new ElectronSurfaceClient({
      controlEndpoint: "http://127.0.0.1:9223",
      controlToken: "test-token",
      traceId: "trace-speech-speakers",
      helperPid: process.pid,
      fetchFn: (async (_url, init) => {
        const body = JSON.parse(String(init?.body || "{}")) as {
          action: string;
          args: Record<string, unknown>;
        };
        let result: unknown = {};
        if (body.action === "getUrl") {
          result = { url: "https://aistudio.google.com/generate-speech?model=gemini-2.5-pro-preview-tts" };
        } else if (body.action === "aiStudioSpeechConfigureSpeakers") {
          capturedSpeakerArgs = body.args;
          result = { configured: 2 };
        } else if (body.action === "clickSelector") {
          generated = true;
          result = { clicked: true };
        } else if (body.action === "aiStudioSpeechCaptureState") {
          result = {
            detectedError: "",
            audioSrc: generated ? "blob:https://aistudio.google.com/speakers-ok" : "",
            isGenerating: false,
          };
        } else if (body.action === "aiStudioSpeechExtractAudio") {
          result = {
            mimeType: "audio/wav",
            audioBase64: Buffer.from("WAV_SPEAKERS").toString("base64"),
          };
        }
        return new Response(JSON.stringify({ ok: true, result }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    const result = await worker.executeSpeech(client, {
      modelId: "gemini-2.5-pro-preview-tts",
      text: "Speaker 2: Chào bạn\nSpeaker 1: Xin chào!",
      speakers: [
        { speaker: "Speaker 1", voiceName: "Umbriel" },
        { speaker: "Speaker 2", voiceName: "Callirrhoe" },
      ],
    });

    expect((capturedSpeakerArgs as any)?.orderedSpeakers).toEqual([
      { speaker: "Speaker 2", voiceName: "Callirrhoe" },
      { speaker: "Speaker 1", voiceName: "Umbriel" },
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

  function createMockSurfaceClient(
    handler: (action: string, args: Record<string, unknown>) => unknown,
  ): ElectronSurfaceClient {
    return new ElectronSurfaceClient({
      controlEndpoint: "http://127.0.0.1:9223",
      controlToken: "test-token",
      traceId: "trace-speech-unit",
      helperPid: process.pid,
      fetchFn: (async (_url, init) => {
        const body = JSON.parse(String(init?.body || "{}")) as {
          action: string;
          args: Record<string, unknown>;
        };
        const result = await handler(body.action, body.args || {});
        return new Response(JSON.stringify({ ok: true, result }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
  }

  test("executeSpeech điều phối qua ElectronSurfaceClient (không CDP), chuẩn bị Text mode và trích xuất WAV", async () => {
    const worker = new AiStudioSpeechWorker();
    const actions: Array<{ action: string; args: Record<string, unknown> }> = [];
    let generated = false;

    const client = createMockSurfaceClient((action, args) => {
      actions.push({ action, args });
      if (action === "getUrl") {
        return { url: "https://aistudio.google.com/prompts/new_chat" };
      }
      if (action === "navigate") {
        return { url: args.url };
      }
      if (action === "aiStudioSpeechPrepareEditor") {
        return { ready: true };
      }
      if (action === "aiStudioSpeechGetBaselineAudioSrc") {
        return { audioSrc: "https://www.gstatic.com/aistudio/tts/enthusiastic-co-host.wav" };
      }
      if (action === "clickSelector" && String(args.selector).includes("ctrl-enter-submits")) {
        generated = true;
        return { clicked: true };
      }
      if (action === "aiStudioSpeechCaptureState") {
        return {
          detectedError: "",
          audioSrc: generated
            ? "blob:https://aistudio.google.com/new-audio"
            : "https://www.gstatic.com/aistudio/tts/enthusiastic-co-host.wav",
          isGenerating: false,
        };
      }
      if (action === "aiStudioSpeechExtractAudio") {
        return {
          mimeType: "audio/wav",
          audioBase64: Buffer.from("WAV_NEW").toString("base64"),
        };
      }
      return {};
    });

    const result = await worker.executeSpeech(client, {
      modelId: "gemini-2.5-pro-preview-tts",
      text: "Speaker 1: Test Electron control TTS",
      temperature: 0.9,
      speakers: [
        { speaker: "Speaker 1", voiceName: "Charon" },
      ],
    });

    expect(actions.some(a => a.action === "navigate")).toBe(true);
    expect(actions.some(a => a.action === "aiStudioSpeechPrepareEditor")).toBe(true);
    expect(actions.some(a => a.action === "aiStudioSpeechConfigureSpeakers")).toBe(true);
    expect(actions.some(a => a.action === "aiStudioSpeechConfigureTemperature")).toBe(true);
    expect(actions.some(a => a.action === "aiStudioWaitForBotGuardReady")).toBe(true);
    expect(
      actions.find(a => a.action === "fillTextarea" && String(a.args.selector).includes("Enter a prompt"))?.args.value,
    ).toBe("Speaker 1: Test Electron control TTS");
    expect(result.mimeType).toBe("audio/wav");
    expect(Buffer.from(result.audioBase64, "base64").toString()).toBe("WAV_NEW");
  });

  test("waitForGeneratedAudio fail-fast ngay khi AI Studio hiện banner lỗi HTTP 403 / 400-500", async () => {
    const worker = new AiStudioSpeechWorker();
    const client = createMockSurfaceClient((action) => {
      if (action === "aiStudioSpeechCaptureState") {
        return {
          detectedError: "Http response at 400 or 500 level, error: , http status code: 403",
          audioSrc: "",
          isGenerating: false,
        };
      }
      return {};
    });

    await expect(
      (worker as any).waitForGeneratedAudio(client, "", {
        modelId: "gemini-2.5-pro-preview-tts",
        text: "hi",
        speakers: [],
      }),
    ).rejects.toThrow("http status code: 403");
  });

  test("executeSpeech bỏ qua navigate nếu tab Launcher đã mở sẵn đúng URL /generate-speech?model=...", async () => {
    const worker = new AiStudioSpeechWorker();
    let navigateCalls = 0;
    let generated = false;

    const client = createMockSurfaceClient((action) => {
      if (action === "getUrl") {
        return { url: "https://aistudio.google.com/generate-speech?model=gemini-2.5-pro-preview-tts" };
      }
      if (action === "navigate") {
        navigateCalls += 1;
        return { url: "https://aistudio.google.com/generate-speech?model=gemini-2.5-pro-preview-tts" };
      }
      if (action === "clickSelector") {
        generated = true;
        return { clicked: true };
      }
      if (action === "aiStudioSpeechCaptureState") {
        return {
          detectedError: "",
          audioSrc: generated ? "blob:https://aistudio.google.com/preloaded" : "",
          isGenerating: false,
        };
      }
      if (action === "aiStudioSpeechExtractAudio") {
        return {
          mimeType: "audio/wav",
          audioBase64: Buffer.from("WAV_PRELOADED").toString("base64"),
        };
      }
      return {};
    });

    const result = await worker.executeSpeech(client, {
      modelId: "gemini-2.5-pro-preview-tts",
      text: "Speaker 1: Preloaded tab test",
      speakers: [],
    });

    expect(navigateCalls).toBe(0);
    expect(Buffer.from(result.audioBase64, "base64").toString()).toBe("WAV_PRELOADED");
  });

  test("executeSpeech tái sử dụng tab không bốc nhầm audio blob cũ của lượt trước và bỏ qua BotGuard wait", async () => {
    const worker = new AiStudioSpeechWorker();
    const actions: Array<{ action: string; args: Record<string, unknown> }> = [];
    let capturePoll = 0;

    const client = createMockSurfaceClient((action, args) => {
      actions.push({ action, args });
      if (action === "getUrl") {
        return { url: "https://aistudio.google.com/generate-speech?model=gemini-2.5-pro-preview-tts" };
      }
      if (action === "aiStudioSpeechGetBaselineAudioSrc") {
        return { audioSrc: "blob:https://aistudio.google.com/chunk-1-old" };
      }
      if (action === "aiStudioSpeechCaptureState") {
        capturePoll += 1;
        // Lượt poll 1 đang sinh (isGenerating=true) và vẫn còn blob cũ;
        // lượt poll 2 vừa nhả isGenerating nhưng blob VẪN là của chunk 1 -> tuyệt đối không được lấy!
        // lượt poll 3 mới ra blob của chunk 2.
        if (capturePoll === 1) {
          return {
            detectedError: "",
            audioSrc: "blob:https://aistudio.google.com/chunk-1-old",
            isGenerating: true,
          };
        }
        if (capturePoll === 2) {
          return {
            detectedError: "",
            audioSrc: "blob:https://aistudio.google.com/chunk-1-old",
            isGenerating: false,
          };
        }
        return {
          detectedError: "",
          audioSrc: "blob:https://aistudio.google.com/chunk-2-new",
          isGenerating: false,
        };
      }
      if (action === "aiStudioSpeechExtractAudio") {
        return {
          mimeType: "audio/wav",
          audioBase64: Buffer.from(`WAV_FROM_${String(args.audioSrc)}`).toString("base64"),
        };
      }
      return {};
    });

    const result = await worker.executeSpeech(client, {
      modelId: "gemini-2.5-pro-preview-tts",
      text: "Linh: Chunk 2\nMinh: Ok",
      speakers: [
        { speaker: "Minh", voiceName: "Charon" },
        { speaker: "Linh", voiceName: "Aoede" },
      ],
      reusedSurface: true,
    });

    expect(actions.some(a => a.action === "aiStudioWaitForBotGuardReady")).toBe(false);
    expect(
      actions.find(a => a.action === "aiStudioSpeechConfigureSpeakers")?.args.resetOptionalProfiles,
    ).toBe(true);
    expect(Buffer.from(result.audioBase64, "base64").toString()).toBe(
      "WAV_FROM_blob:https://aistudio.google.com/chunk-2-new",
    );
  });
});

