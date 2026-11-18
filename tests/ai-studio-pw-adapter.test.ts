import { describe, expect, test } from "bun:test";
import { AdapterRegistry } from "../src/adapters/adapter-registry";
import { WebProviderAdapter } from "../src/adapters/web/web-provider-adapter";
import {
  AiStudioPlaywrightAdapter,
  AiStudioPlaywrightModelProvider,
  AiStudioPlaywrightSpeechWorker,
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

  test("AiStudioPlaywrightSpeechWorker đảo thứ tự Card 0 ⇄ Card 1 theo speaker mở đầu kể cả khi input alias ẩn (vis=false)", async () => {
    const worker = new AiStudioPlaywrightSpeechWorker();
    const cards = [
      { alias: "Speaker 1", voice: "Puck" },
      { alias: "Speaker 2", voice: "Zephyr" },
    ];
    let drawerOpen = false;
    let openedCardIdx = -1;

    const makeAliasLocator = (cardIdx: number) => ({
      first: () => makeAliasLocator(cardIdx),
      count: async () => 1,
      isVisible: async () => false,
      inputValue: async () => cards[cardIdx].alias,
      evaluate: async (fn: (el: HTMLInputElement, val?: string) => unknown, arg?: string) => {
        if (typeof arg === "string") {
          cards[cardIdx].alias = arg;
          return undefined;
        }
        return fn({ focus() {}, blur() {}, dispatchEvent() { return true; } } as unknown as HTMLInputElement);
      },
    });

    const makeCardLocator = (cardIdx: number) => ({
      locator: (sel: string) => {
        if (sel.includes("speaker-alias-input")) return makeAliasLocator(cardIdx);
        if (sel.includes("voice-persona")) {
          return { first: () => ({ isVisible: async () => false }) };
        }
        if (sel.includes("active-voice-card-trigger")) {
          return {
            first: () => ({
              page: () => fakePage,
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
      scrollIntoViewIfNeeded: async () => {},
      hover: async () => {},
    });

    const voiceOptions = ["Callirrhoe", "Umbriel"];
    const voicesRegion = {
      first: () => voicesRegion,
      waitFor: async () => {},
      isVisible: async () => drawerOpen,
      locator: (sel: string) => {
        if (sel === ".voice-card") {
          return {
            count: async () => voiceOptions.length,
            nth: (vIdx: number) => ({
              getAttribute: async () => voiceOptions[vIdx],
              locator: () => ({ first: () => ({ innerText: async () => voiceOptions[vIdx] }) }),
              click: async () => {
                if (openedCardIdx >= 0) cards[openedCardIdx].voice = voiceOptions[vIdx];
              },
              scrollIntoViewIfNeeded: async () => {},
              hover: async () => {},
              evaluate: async () => false,
            }),
          };
        }
        return { count: async () => 0 };
      },
    };
    // Fix child button.voice-card-content inside .voice-card
    const origVoicesLoc = voicesRegion.locator;
    voicesRegion.locator = (sel: string) => {
      if (sel === ".voice-card") {
        return {
          count: async () => voiceOptions.length,
          nth: (vIdx: number) => ({
            getAttribute: async () => voiceOptions[vIdx],
            locator: () => ({
              first: () => ({
                innerText: async () => voiceOptions[vIdx],
                count: async () => 1,
                page: () => fakePage,
                scrollIntoViewIfNeeded: async () => {},
                hover: async () => {},
                click: async () => {
                  if (openedCardIdx >= 0) cards[openedCardIdx].voice = voiceOptions[vIdx];
                },
              }),
            }),
          }),
        } as never;
      }
      return origVoicesLoc(sel) as never;
    };

    const fakePage = {
      waitForTimeout: async () => {},
      keyboard: { press: async () => { drawerOpen = false; } },
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
              page: () => fakePage,
              isVisible: async () => drawerOpen,
              scrollIntoViewIfNeeded: async () => {},
              hover: async () => {},
              click: async () => { drawerOpen = false; },
            }),
          };
        }
        return { first: () => ({ isVisible: async () => false, count: async () => 0 }) };
      },
      evaluate: async (_fn: unknown, arg?: { cardSel?: string }) => {
        if (arg?.cardSel === "ms-voice-settings") {
          return cards.map((c, idx) => ({
            index: idx,
            alias: c.alias,
            aliasLower: c.alias.toLowerCase(),
            hasAliasInput: true,
            currentVoice: c.voice,
            currentVoiceLower: c.voice.toLowerCase(),
          }));
        }
        return [];
      },
    } as never;

    await (
      worker as unknown as {
        configureSpeakers: (
          p: unknown,
          s: Array<{ speaker: string; voiceName: string }>,
          a: Record<string, string>,
          d: Record<string, unknown>,
          r: boolean,
        ) => Promise<void>;
      }
    ).configureSpeakers(
      fakePage,
      [
        { speaker: "Speaker 2", voiceName: "Callirrhoe" },
        { speaker: "Speaker 1", voiceName: "Umbriel" },
      ],
      {},
      {},
      false,
    );

    expect(cards).toEqual([
      { alias: "Speaker 2", voice: "Callirrhoe" },
      { alias: "Speaker 1", voice: "Umbriel" },
    ]);
  });

  test("AiStudioPlaywrightWorker chờ BotGuard lại sau page.goto (kể cả khi launcherReused) và hover trước khi fill/click Run", async () => {
    const worker = new AiStudioPlaywrightWorker();
    const events: string[] = [];
    let currentUrl = "https://aistudio.google.com/prompts/new_chat?model=gemini-2.5-flash";
    let isComposerFilled = false;
    let runClicked = false;

    const fakePage = {
      url: () => currentUrl,
      goto: async (url: string) => {
        currentUrl = url;
        events.push(`goto:${url}`);
      },
      waitForSelector: async () => {},
      waitForTimeout: async (ms: number) => {
        events.push(`wait:${ms}`);
      },
      keyboard: { press: async () => {} },
      on: () => {},
      off: () => {},
      locator: (sel: string) => {
        const makeLoc = (name: string) => ({
          page: () => fakePage,
          first: () => makeLoc(name),
          waitFor: async () => {},
          isVisible: async () => name === "composer",
          scrollIntoViewIfNeeded: async () => {
            events.push(`scroll:${name}`);
          },
          hover: async () => {
            events.push(`hover:${name}`);
          },
          click: async () => {
            events.push(`click:${name}`);
            if (name === "runBtn") runClicked = true;
          },
          fill: async (val: string) => {
            events.push(`fill:${name}:${val.length}`);
            if (name === "composer") isComposerFilled = true;
          },
          inputValue: async () => (isComposerFilled ? "hello" : ""),
          innerText: async () => "",
          count: async () => 0,
          press: async () => {},
        });
        if (sel.includes("Enter a prompt")) return makeLoc("composer");
        if (sel.includes("Thinking Level")) return makeLoc("thinking");
        return makeLoc("runBtn");
      },
      evaluate: async (_fn: unknown, arg?: Record<string, unknown>) => {
        if (arg && "expectedModel" in arg) return false;
        if (arg && "btnSelector" in arg) {
          return {
            isStop: runClicked,
            isRunningLive: false,
            isDisabled: false,
            hasPrimaryBtn: true,
            editorLength: isComposerFilled ? 5 : 0,
          };
        }
        if (arg === undefined) {
          events.push("botguard_probe");
          return { waaReady: true, pageAgeMs: 2_500 };
        }
        return false;
      },
    } as never;

    const runHelper = worker as unknown as {
      navigate: (p: unknown, o: Record<string, unknown>) => Promise<void>;
      prepareProvider: (p: unknown, o: Record<string, unknown>) => Promise<void>;
      insertPrompt: (p: unknown, t: string, o: Record<string, unknown>) => Promise<void>;
      submitPrompt: (p: unknown, o: Record<string, unknown>) => Promise<void>;
      botGuardSettledPages: WeakSet<object>;
    };

    // Giả lập page đã settle trước đó ở cuộc chat cũ và đang được launcherReused
    runHelper.botGuardSettledPages.add(fakePage);
    await runHelper.navigate(fakePage, { launcherReused: true, modelSlug: "ai-studio-pw/gemini-4-hydrogen" });
    await runHelper.prepareProvider(fakePage, { launcherReused: true, modelSlug: "ai-studio-pw/gemini-4-hydrogen" });
    await runHelper.insertPrompt(fakePage, "hello", {});
    await runHelper.submitPrompt(fakePage, {});

    expect(events.some((e) => e.startsWith("goto:https://aistudio.google.com/prompts/new_chat"))).toBe(true);
    expect(events).toContain("botguard_probe");
    expect(events.indexOf("hover:composer")).toBeLessThan(events.indexOf("fill:composer:5"));
    expect(events.indexOf("hover:runBtn")).toBeLessThan(events.indexOf("click:runBtn"));
  });
});
