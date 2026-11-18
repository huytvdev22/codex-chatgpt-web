import { describe, expect, test } from "bun:test";
import { AdapterRegistry } from "../src/adapters/adapter-registry";
import { WebProviderAdapter } from "../src/adapters/web/web-provider-adapter";
import {
  AiStudioPlaywrightAdapter,
  AiStudioPlaywrightModelProvider,
  AiStudioPlaywrightWorker,
  buildAiStudioPlaywrightSpeechUrl,
  isAiStudioGenerationRequest,
} from "../src/adapters/ai-studio-pw";
import { AiStudioPlaywrightDomObserver } from "../src/adapters/ai-studio-pw/ai-studio-pw-dom-observer";
import type { ProviderAdapter } from "../src/adapters/base";
import { ModelRegistry } from "../src/models/model-registry";
import { GeminiSpeechService } from "../src/services/gemini-speech-service";

class TestPlaywrightWorker extends AiStudioPlaywrightWorker {
  public checkShouldEnforceIdleTimeout(
    observation: Parameters<AiStudioPlaywrightWorker["shouldEnforceIdleTimeout"]>[0],
  ): boolean {
    return this.shouldEnforceIdleTimeout(observation);
  }
}

describe("Google AI Studio Playwright Adapter (ai-studio-pw)", () => {
  test("ModelRegistry & AdapterRegistry đăng ký model ai-studio-pw/gemini-4-hydrogen song song với ai-studio", () => {
    const pwProvider = AiStudioPlaywrightModelProvider.getInstance();
    expect(pwProvider.id).toBe("ai-studio-pw");
    expect(pwProvider.routes.map((r) => r.slug)).toEqual([
      "ai-studio-pw/gemini-4-hydrogen",
    ]);
    expect(pwProvider.matchModelSlug("ai-studio-pw/gemini-4-hydrogen")).toBe(true);
    expect(pwProvider.matchModelSlug("ai-studio/gemini-4-hydrogen")).toBe(false);

    expect(
      ModelRegistry.getInstance().findProvider("ai-studio-pw/gemini-4-hydrogen")?.id,
    ).toBe("ai-studio-pw");
    expect(
      ModelRegistry.getInstance().findProvider("ai-studio/gemini-4-hydrogen")?.id,
    ).toBe("ai-studio");

    const adapter = AdapterRegistry.getInstance().createAdapter("ai-studio-pw");
    expect(adapter).toBeInstanceOf(AiStudioPlaywrightAdapter);
    expect(adapter).toBeInstanceOf(WebProviderAdapter);
    expect(adapter.name).toBe("ai-studio-pw");
  });

  test("AiStudioPlaywrightDomObserver cập nhật activityKey khi thoughtTextLength tăng và giữ generating khi networkInFlight=true", () => {
    const observer = new AiStudioPlaywrightDomObserver();
    const state = observer.createRuntimeState();

    const step1 = observer.applyStatus(
      state,
      {
        isGenerating: true,
        responseReadyLive: false,
        hasNewAnswerTurn: false,
        hasTurnFooter: false,
        thoughtsCount: 1,
        thoughtTextLength: 120,
        rawHtml: "",
        rawText: "",
        hasContent: false,
      },
      true,
    );

    const step2 = observer.applyStatus(
      state,
      {
        isGenerating: true,
        responseReadyLive: false,
        hasNewAnswerTurn: false,
        hasTurnFooter: false,
        thoughtsCount: 1,
        thoughtTextLength: 480,
        rawHtml: "",
        rawText: "",
        hasContent: false,
      },
      true,
    );

    expect(step1.isGenerating).toBe(true);
    expect(step1.isCompleted).toBe(false);
    expect(step1.networkInFlight).toBe(true);
    expect(step2.activityKey).not.toBe(step1.activityKey);

    const networkStillBusy = observer.applyStatus(
      state,
      {
        isGenerating: false,
        responseReadyLive: false,
        hasNewAnswerTurn: true,
        hasTurnFooter: true,
        thoughtsCount: 1,
        thoughtTextLength: 480,
        rawHtml: "<p>Xin chào</p>",
        rawText: "Xin chào",
        hasContent: true,
      },
      true,
    );
    expect(networkStillBusy.isGenerating).toBe(true);
    expect(networkStillBusy.isCompleted).toBe(false);
  });

  test("shouldEnforceIdleTimeout miễn trừ khi networkInFlight hoặc isGenerating đang bật", () => {
    const worker = new TestPlaywrightWorker();
    const observer = new AiStudioPlaywrightDomObserver();
    const state = observer.createRuntimeState();

    const busyByNetwork = observer.applyStatus(
      state,
      {
        isGenerating: false,
        responseReadyLive: false,
        hasNewAnswerTurn: false,
        hasTurnFooter: false,
        thoughtsCount: 1,
        thoughtTextLength: 50,
        rawHtml: "",
        rawText: "",
        hasContent: false,
      },
      true,
    );
    expect(worker.checkShouldEnforceIdleTimeout(busyByNetwork)).toBe(false);

    const busyByDom = observer.applyStatus(
      state,
      {
        isGenerating: true,
        responseReadyLive: false,
        hasNewAnswerTurn: false,
        hasTurnFooter: false,
        thoughtsCount: 1,
        thoughtTextLength: 50,
        rawHtml: "",
        rawText: "",
        hasContent: false,
      },
      false,
    );
    expect(worker.checkShouldEnforceIdleTimeout(busyByDom)).toBe(false);

    const trulyIdle = observer.applyStatus(
      state,
      {
        isGenerating: false,
        responseReadyLive: false,
        hasNewAnswerTurn: false,
        hasTurnFooter: false,
        thoughtsCount: 0,
        thoughtTextLength: 0,
        rawHtml: "",
        rawText: "",
        hasContent: false,
      },
      false,
    );
    expect(worker.checkShouldEnforceIdleTimeout(trulyIdle)).toBe(true);
  });

  test("isAiStudioGenerationRequest chỉ nhận diện POST GenerateContent/StreamGenerate, bỏ qua CountTokens và RPC phụ trợ", () => {
    expect(
      isAiStudioGenerationRequest(
        "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent",
        "POST",
      ),
    ).toBe(true);
    expect(
      isAiStudioGenerationRequest(
        "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/CountTokens",
        "POST",
      ),
    ).toBe(false);
    expect(
      isAiStudioGenerationRequest(
        "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateTitle",
        "POST",
      ),
    ).toBe(false);
    expect(
      isAiStudioGenerationRequest(
        "https://aistudio.google.com/prompts/new_chat",
        "GET",
      ),
    ).toBe(false);
  });

  test("buildAiStudioPlaywrightSpeechUrl strip tiền tố ai-studio-pw/ và ai-studio/", () => {
    expect(buildAiStudioPlaywrightSpeechUrl("ai-studio-pw/gemini-2.5-pro-preview-tts")).toBe(
      "https://aistudio.google.com/generate-speech?model=gemini-2.5-pro-preview-tts",
    );
    expect(buildAiStudioPlaywrightSpeechUrl("ai-studio/gemini-2.5-flash-preview-tts")).toBe(
      "https://aistudio.google.com/generate-speech?model=gemini-2.5-flash-preview-tts",
    );
  });

  test("GeminiSpeechService route ai-studio-pw/gemini-2.5-pro-preview-tts sang adapter ai-studio-pw và giữ mặc định sang ai-studio", async () => {
    const dispatchedProviders: string[] = [];
    const makeStub = (providerId: string): ProviderAdapter => ({
      name: providerId,
      async runTurn(_parsed, _incoming, emit) {
        emit({ type: "done" });
      },
      async runSpeechTurn(request) {
        dispatchedProviders.push(`${providerId}:${request.modelId}`);
        return {
          mimeType: "audio/wav",
          audioBase64: "UklGRg==",
        };
      },
    });

    const registry = new AdapterRegistry([
      ["ai-studio", () => makeStub("ai-studio")],
      ["ai-studio-pw", () => makeStub("ai-studio-pw")],
    ]);
    const service = new GeminiSpeechService(registry);

    const body = {
      contents: [{ parts: [{ text: "Speaker 1: Hello" }] }],
      generationConfig: {
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Umbriel" } },
        },
      },
    };

    const resPw = await service.executeSpeech({
      req: new Request("http://127.0.0.1:4317/v1beta/models/ai-studio-pw/gemini-2.5-pro-preview-tts:generateContent"),
      modelId: "ai-studio-pw/gemini-2.5-pro-preview-tts",
      method: "generateContent",
      raw: body,
    });
    expect(resPw.status).toBe(200);

    const resDefault = await service.executeSpeech({
      req: new Request("http://127.0.0.1:4317/v1beta/models/gemini-2.5-pro-preview-tts:generateContent"),
      modelId: "gemini-2.5-pro-preview-tts",
      method: "generateContent",
      raw: body,
    });
    expect(resDefault.status).toBe(200);

    expect(dispatchedProviders).toEqual([
      "ai-studio-pw:ai-studio-pw/gemini-2.5-pro-preview-tts",
      "ai-studio:gemini-2.5-pro-preview-tts",
    ]);
  });
});
