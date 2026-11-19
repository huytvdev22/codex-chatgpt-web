import { describe, expect, test } from "bun:test";
import { AdapterRegistry } from "../src/adapters/adapter-registry";
import { WebProviderAdapter } from "../src/adapters/web/web-provider-adapter";
import {
  AI_STUDIO_NEW_CHAT_URL,
  AiStudioAdapter,
  AiStudioBrowserWorker,
  AiStudioModelProvider,
  aiStudioConversationKey,
  buildAiStudioConversationUrl,
  buildAiStudioNewChatUrl,
  buildAiStudioSpeechUrl,
  isAiStudioGenerationRequest,
  normalizeAiStudioConversationId,
  parseAiStudioConversationId,
  selectPreferredAiStudioResponse,
} from "../src/adapters/ai-studio";
import {
  AI_STUDIO_DOM_SELECTORS,
  AiStudioDomObserver,
} from "../src/adapters/ai-studio/ai-studio-dom-observer";
import {
  normalizeCopiedAiStudioCodeSnippet,
  resolveClipboardMenuItemIndex,
} from "../src/adapters/ai-studio/ai-studio-clipboard-salvage";
import { parseStrictWebResponse } from "../src/adapters/web/protocol/strict-response-parser";
import { ModelRegistry } from "../src/models/model-registry";
import type { CodexParsedRequest } from "../src/types";

class TestAiStudioWorker extends AiStudioBrowserWorker {
  public checkShouldEnforceIdleTimeout(
    observation: Parameters<AiStudioBrowserWorker["shouldEnforceIdleTimeout"]>[0],
  ): boolean {
    return this.shouldEnforceIdleTimeout(observation);
  }

  public getPollDelay(
    observation: Parameters<AiStudioBrowserWorker["resolveNextPollDelayMs"]>[0],
    defaultDelayMs: number,
    options: Parameters<AiStudioBrowserWorker["resolveNextPollDelayMs"]>[2],
  ): number {
    return this.resolveNextPollDelayMs(observation, defaultDelayMs, options);
  }
}

function makeParsedRequest(overrides: Partial<CodexParsedRequest> = {}): CodexParsedRequest {
  return {
    modelId: "ai-studio/gemini-4-hydrogen",
    stream: true,
    options: {},
    context: {
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1_700_000_000_000 },
      ],
      tools: [],
    },
    ...overrides,
  };
}

describe("Google AI Studio Web Adapter (Playwright CDP)", () => {
  test("ModelRegistry & AdapterRegistry đăng ký duy nhất model ai-studio/gemini-4-hydrogen", () => {
    const modelProvider = AiStudioModelProvider.getInstance();
    expect(modelProvider.id).toBe("ai-studio");
    expect(modelProvider.routes.map((route) => route.slug)).toEqual([
      "ai-studio/gemini-4-hydrogen",
    ]);
    expect(modelProvider.matchModelSlug("ai-studio/gemini-4-hydrogen")).toBe(true);
    expect(modelProvider.matchModelSlug("ai-studio-pw/gemini-4-hydrogen")).toBe(false);
    expect(modelProvider.matchModelSlug("ai-studio/gemini-4-carbon")).toBe(false);

    expect(ModelRegistry.getInstance().findProvider("ai-studio/gemini-4-hydrogen")?.id).toBe(
      "ai-studio",
    );
    expect(ModelRegistry.getInstance().findProvider("ai-studio-pw/gemini-4-hydrogen")).toBeUndefined();
    expect(ModelRegistry.getInstance().findProvider("ai-studio/gemini-4-carbon")).toBeUndefined();

    expect(modelProvider.resolveThinkingLevel("ai-studio/gemini-4-hydrogen", "low")).toBe("Low");
    expect(modelProvider.resolveThinkingLevel("ai-studio/gemini-4-hydrogen", "medium")).toBe("Medium");
    expect(modelProvider.resolveThinkingLevel("ai-studio/gemini-4-hydrogen", "high")).toBe("High");

    const adapter = AdapterRegistry.getInstance().createAdapter("ai-studio");
    expect(adapter).toBeInstanceOf(AiStudioAdapter);
    expect(adapter).toBeInstanceOf(WebProviderAdapter);
    expect(adapter.name).toBe("ai-studio");
    expect(AdapterRegistry.getInstance().has("ai-studio-pw")).toBe(false);
  });

  test("parse/normalize AI Studio conversation URL bảo toàn chữ hoa/thường và từ chối new_chat", () => {
    const sampleId = "1f4VKkbKG5PxctRMKVZN4bR3TRBcc1ROb";
    expect(AI_STUDIO_NEW_CHAT_URL).toBe(
      "https://aistudio.google.com/prompts/new_chat?model=gemini-4-hydrogen",
    );
    expect(buildAiStudioNewChatUrl("gemini-4-hydrogen")).toBe(AI_STUDIO_NEW_CHAT_URL);
    expect(normalizeAiStudioConversationId(sampleId)).toBe(sampleId);
    expect(normalizeAiStudioConversationId("new_chat")).toBeUndefined();
    expect(parseAiStudioConversationId(`https://aistudio.google.com/prompts/${sampleId}`)).toBe(
      sampleId,
    );
    expect(
      parseAiStudioConversationId("https://aistudio.google.com/prompts/new_chat?model=gemini-4-hydrogen"),
    ).toBeUndefined();
    expect(
      parseAiStudioConversationId("https://evil.example.com/prompts/1f4VKkbKG5PxctRMKVZN4bR3TRBcc1ROb"),
    ).toBeUndefined();
    expect(buildAiStudioConversationUrl(sampleId)).toBe(
      `https://aistudio.google.com/prompts/${sampleId}`,
    );
    expect(buildAiStudioSpeechUrl("ai-studio/gemini-2.5-flash-preview-tts")).toBe(
      "https://aistudio.google.com/generate-speech?model=gemini-2.5-flash-preview-tts",
    );
  });

  test("aiStudioConversationKey tạo SHA-256 ổn định và không lộ threadId gốc", () => {
    const parsed = makeParsedRequest();
    const key1 = aiStudioConversationKey(parsed, "thread_secret_abc");
    const key2 = aiStudioConversationKey(parsed, "thread_secret_abc");
    expect(key1).toMatch(/^[a-f0-9]{64}$/);
    expect(key1).toBe(key2);
    expect(key1).not.toContain("thread_secret_abc");
  });

  test("AiStudioDomObserver giữ trạng thái generating khi mới có Thoughts và hoàn tất khi Answer turn có nội dung + turn-footer", () => {
    const observer = new AiStudioDomObserver();
    const state = observer.createRuntimeState();

    const thinkingOnly = observer.applyStatus(state, {
      isGenerating: true,
      responseReadyLive: false,
      hasNewAnswerTurn: false,
      hasTurnFooter: false,
      thoughtsCount: 1,
      thoughtTextLength: 120,
      rawHtml: "",
      rawText: "",
      hasContent: false,
    });
    expect(thinkingOnly.isGenerating).toBe(true);
    expect(thinkingOnly.isCompleted).toBe(false);
    expect(thinkingOnly.activityKey).toContain("thinking:1");

    const firstFooterPoll = observer.applyStatus(state, {
      isGenerating: false,
      responseReadyLive: true,
      hasNewAnswerTurn: true,
      hasTurnFooter: true,
      thoughtsCount: 1,
      thoughtTextLength: 120,
      rawHtml: "<p>78</p>",
      rawText: "78",
      hasContent: true,
    });
    expect(firstFooterPoll.isGenerating).toBe(false);
    expect(firstFooterPoll.isCompleted).toBe(false);

    const completedAnswer = observer.applyStatus(state, {
      isGenerating: false,
      responseReadyLive: true,
      hasNewAnswerTurn: true,
      hasTurnFooter: true,
      thoughtsCount: 1,
      thoughtTextLength: 120,
      rawHtml: "<p>78</p>",
      rawText: "78",
      hasContent: true,
    });
    expect(completedAnswer.isGenerating).toBe(false);
    expect(completedAnswer.isCompleted).toBe(true);
    expect(completedAnswer.text).toBe("78");

    expect(() =>
      observer.applyStatus(state, {
        isGenerating: false,
        responseReadyLive: false,
        hasNewAnswerTurn: true,
        hasTurnFooter: false,
        thoughtsCount: 0,
        thoughtTextLength: 0,
        rawHtml: "",
        rawText: "Permission denied. Please check your account permissions and project settings.",
        hasContent: true,
        detectedWebError:
          "Permission denied. Please check your account permissions and project settings.",
      }),
    ).toThrow("[AI Studio Web Error] Permission denied.");
  });

  test("AiStudioDomObserver cập nhật activityKey khi thoughtTextLength tăng và giữ generating khi networkInFlight=true", () => {
    const observer = new AiStudioDomObserver();
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

  test("AiStudioDomObserver không hoàn tất sớm khi <webResponse> chưa đóng và bọc đúng single Markdown code block", () => {
    const observer = new AiStudioDomObserver();
    const state = observer.createRuntimeState();

    const unclosedRaw = "<webResponse>\nChào bạn!";
    for (let i = 0; i < 4; i += 1) {
      const obs = observer.applyStatus(state, {
        isGenerating: false,
        responseReadyLive: true,
        hasNewAnswerTurn: true,
        hasTurnFooter: false,
        thoughtsCount: 1,
        thoughtTextLength: 80,
        rawHtml: `<pre><code>&lt;webResponse&gt;\nChào bạn!</code></pre>`,
        rawText: unclosedRaw,
        singleMarkdownCodeBlockText: unclosedRaw,
        hasContent: true,
      });
      expect(obs.isCompleted).toBe(false);
    }

    const completeCodeText = "<webResponse>\nChào bạn!\n</webResponse>";
    const settle1 = observer.applyStatus(state, {
      isGenerating: false,
      responseReadyLive: true,
      hasNewAnswerTurn: true,
      hasTurnFooter: true,
      thoughtsCount: 1,
      thoughtTextLength: 80,
      rawHtml: "<ms-code-block><pre><code>...</code></pre></ms-code-block>",
      rawText: completeCodeText,
      singleMarkdownCodeBlockText: completeCodeText,
      hasContent: true,
    });
    expect(settle1.isCompleted).toBe(false);

    const settle2 = observer.applyStatus(state, {
      isGenerating: false,
      responseReadyLive: true,
      hasNewAnswerTurn: true,
      hasTurnFooter: true,
      thoughtsCount: 1,
      thoughtTextLength: 80,
      rawHtml: "<ms-code-block><pre><code>...</code></pre></ms-code-block>",
      rawText: completeCodeText,
      singleMarkdownCodeBlockText: completeCodeText,
      hasContent: true,
    });
    expect(settle2.isCompleted).toBe(true);
    expect(parseStrictWebResponse(settle2.text)).toEqual({
      kind: "final_answer",
      content: "Chào bạn!",
      rawResponse: "````markdown\n<webResponse>\nChào bạn!\n</webResponse>\n````",
    });
  });

  test("AiStudioDomObserver tái sử dụng cache khi rawHtml không đổi và Worker giãn nhịp poll khi generating", () => {
    const observer = new AiStudioDomObserver();
    const state = observer.createRuntimeState();
    const sameHtml = "<p><strong>Hello</strong> world</p>";

    const first = observer.applyStatus(
      state,
      {
        isGenerating: true,
        responseReadyLive: false,
        hasNewAnswerTurn: true,
        hasTurnFooter: false,
        thoughtsCount: 0,
        thoughtTextLength: 0,
        rawHtml: sameHtml,
        rawText: "Hello world",
        hasContent: true,
      },
      true,
    );
    state.lastObservedText = "CACHED_MARKDOWN";

    const second = observer.applyStatus(
      state,
      {
        isGenerating: true,
        responseReadyLive: false,
        hasNewAnswerTurn: true,
        hasTurnFooter: false,
        thoughtsCount: 0,
        thoughtTextLength: 0,
        rawHtml: sameHtml,
        rawText: "Hello world",
        hasContent: true,
      },
      true,
    );

    expect(first.text).toBe("**Hello** world");
    expect(second.text).toBe("CACHED_MARKDOWN");

    const worker = new TestAiStudioWorker();
    expect(
      worker.getPollDelay(
        {
          text: "",
          isGenerating: true,
          isCompleted: false,
          networkInFlight: true,
          activityKey: "thinking:0",
          timedOut: false,
          status: {
            isGenerating: true,
            responseReadyLive: false,
            hasNewAnswerTurn: false,
            hasTurnFooter: false,
            thoughtsCount: 0,
            thoughtTextLength: 0,
            rawHtml: "",
            rawText: "",
            hasContent: false,
          },
        },
        250,
        { prompt: "hi" },
      ),
    ).toBe(450);
    expect(
      worker.getPollDelay(
        {
          text: "done",
          isGenerating: false,
          isCompleted: true,
          networkInFlight: false,
          activityKey: "idle",
          timedOut: false,
          status: {
            isGenerating: false,
            responseReadyLive: true,
            hasNewAnswerTurn: true,
            hasTurnFooter: true,
            thoughtsCount: 0,
            thoughtTextLength: 0,
            rawHtml: "<p>done</p>",
            rawText: "done",
            hasContent: true,
          },
        },
        250,
        { prompt: "hi" },
      ),
    ).toBe(250);
  });

  test("shouldEnforceIdleTimeout miễn trừ khi networkInFlight hoặc isGenerating đang bật", () => {
    const worker = new TestAiStudioWorker();
    const observer = new AiStudioDomObserver();
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
      isAiStudioGenerationRequest("https://aistudio.google.com/prompts/new_chat", "GET"),
    ).toBe(false);
  });

  test("Clipboard helpers khớp menu item kèm icon ligature và ưu tiên bản extraction đầy đủ", () => {
    expect(AI_STUDIO_DOM_SELECTORS.runOrStopButton).toBe(
      "button[ms-button].ctrl-enter-submits.ms-button-primary",
    );

    expect(
      resolveClipboardMenuItemIndex([
        "delete\nDelete",
        "call_split\nBranch from here",
        "content_copy\nCopy as text",
        "markdown_copy\nCopy as markdown",
      ]),
    ).toBe(3);

    expect(
      resolveClipboardMenuItemIndex(["content_copy\nCopy as text", "Delete"]),
    ).toBe(0);

    expect(
      normalizeCopiedAiStudioCodeSnippet("<webResponse>\nXin chào\n</webResponse>"),
    ).toBe("````markdown\n<webResponse>\nXin chào\n</webResponse>\n````");

    const domFull = "````markdown\n<webResponse>\nĐầy đủ\n</webResponse>\n````";
    expect(selectPreferredAiStudioResponse("<webResponse>\nĐầy đủ", domFull)).toEqual({
      rawResponse: domFull,
      source: "dom",
    });
    expect(selectPreferredAiStudioResponse(domFull, "<webResponse>\nĐầy đủ")).toEqual({
      rawResponse: domFull,
      source: "clipboard",
    });
  });

  test("AiStudioAdapter resolveEndTurnBinding giữ tab sống khi hoàn tất dù chưa có conversationId, chỉ đóng tab ephemeral/lỗi", () => {
    const adapter = new AiStudioAdapter();
    const resolveEndTurnBinding = (
      adapter as unknown as {
        definition: {
          conversation: {
            resolveEndTurnBinding?: (ctx: {
              finalStatus: "completed" | "failed" | "aborted";
              activeConversationId?: string;
              parsed?: CodexParsedRequest;
              hasPriorAssistantReply?: boolean;
              hasToolResults?: boolean;
            }) => { connectorBound: boolean; conversationId?: string; retain?: boolean };
          };
        };
      }
    ).definition.conversation.resolveEndTurnBinding;
    expect(resolveEndTurnBinding).toBeDefined();

    expect(
      resolveEndTurnBinding!({
        finalStatus: "completed",
        activeConversationId: undefined,
        hasPriorAssistantReply: false,
        hasToolResults: false,
      }),
    ).toEqual({
      connectorBound: false,
      retain: true,
    });

    expect(
      resolveEndTurnBinding!({
        finalStatus: "failed",
        activeConversationId: undefined,
        hasPriorAssistantReply: false,
        hasToolResults: false,
      }),
    ).toEqual({
      connectorBound: false,
      retain: false,
    });

    expect(
      resolveEndTurnBinding!({
        finalStatus: "completed",
        activeConversationId: undefined,
        parsed: makeParsedRequest({
          options: {
            outputFormat: {
              type: "json_schema",
              name: "codex_output_schema",
              strict: true,
              schema: { type: "object" },
            },
          },
        }),
        hasPriorAssistantReply: false,
        hasToolResults: false,
      }),
    ).toEqual({
      connectorBound: false,
      retain: false,
    });

    expect(
      resolveEndTurnBinding!({
        finalStatus: "completed",
        activeConversationId: "1f4VKkbKG5PxctRMKVZN4bR3TRBcc1ROb",
        hasPriorAssistantReply: false,
        hasToolResults: false,
      }),
    ).toEqual({
      connectorBound: true,
      conversationId: "1f4VKkbKG5PxctRMKVZN4bR3TRBcc1ROb",
      retain: true,
    });
  });

  test("AiStudioBrowserWorker.navigate giữ nguyên hội thoại trên tab tái sử dụng ở /prompts/new_chat hoặc vừa đổi sang /prompts/{id}", async () => {
    const worker = new AiStudioBrowserWorker();
    let gotoCount = 0;

    const fakePageOnNewChat = {
      url: () => "https://aistudio.google.com/prompts/new_chat?model=gemini-4-hydrogen",
      goto: async () => {
        gotoCount += 1;
      },
      waitForSelector: async () => {},
      evaluate: async () => false,
    } as never;

    const nav = worker as unknown as {
      navigate: (p: unknown, o: Record<string, unknown>) => Promise<void>;
      retainedConversationIds: WeakMap<object, string>;
    };

    await nav.navigate(fakePageOnNewChat, {
      launcherReused: true,
      isNewConversation: false,
      modelSlug: "ai-studio/gemini-4-hydrogen",
    });
    expect(gotoCount).toBe(0);

    const sampleId = "1f4VKkbKG5PxctRMKVZN4bR3TRBcc1ROb";
    const fakePageSavedLater = {
      url: () => `https://aistudio.google.com/prompts/${sampleId}`,
      goto: async () => {
        gotoCount += 1;
      },
      waitForSelector: async () => {},
    } as never;

    await nav.navigate(fakePageSavedLater, {
      launcherReused: true,
      isNewConversation: false,
      modelSlug: "ai-studio/gemini-4-hydrogen",
    });
    expect(gotoCount).toBe(0);
    expect(nav.retainedConversationIds.get(fakePageSavedLater)).toBe(sampleId);
  });

  test("AiStudioBrowserWorker chờ BotGuard lại sau page.goto (kể cả khi launcherReused) và hover trước khi fill/click Run", async () => {
    const worker = new AiStudioBrowserWorker();
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
    await runHelper.navigate(fakePage, {
      launcherReused: true,
      modelSlug: "ai-studio/gemini-4-hydrogen",
    });
    await runHelper.prepareProvider(fakePage, {
      launcherReused: true,
      modelSlug: "ai-studio/gemini-4-hydrogen",
    });
    await runHelper.insertPrompt(fakePage, "hello", {});
    await runHelper.submitPrompt(fakePage, {});

    expect(
      events.some((e) => e.startsWith("goto:https://aistudio.google.com/prompts/new_chat")),
    ).toBe(true);
    expect(events).toContain("botguard_probe");
    expect(events.indexOf("hover:composer")).toBeLessThan(events.indexOf("fill:composer:5"));
    expect(events.indexOf("hover:runBtn")).toBeLessThan(events.indexOf("click:runBtn"));
  });

  test("AiStudioBrowserWorker.insertPrompt rơi xuống DOM setter khi composer.fill timeout/lỗi", async () => {
    const worker = new AiStudioBrowserWorker();
    let domFallbackValue = "";

    const fakePage = {
      waitForTimeout: async () => {},
      locator: () => {
        const loc = {
          page: () => fakePage,
          first: () => loc,
          waitFor: async () => {},
          scrollIntoViewIfNeeded: async () => {},
          hover: async () => {},
          click: async () => {},
          fill: async () => {
            throw new Error("fill: Timeout 4000ms exceeded");
          },
          inputValue: async () => domFallbackValue,
        };
        return loc;
      },
      evaluate: async (_fn: unknown, arg?: { value?: string }) => {
        if (typeof arg?.value === "string") {
          domFallbackValue = arg.value;
        }
        return undefined;
      },
    } as never;

    const helper = worker as unknown as {
      insertPrompt: (p: unknown, text: string, o: Record<string, unknown>) => Promise<void>;
    };
    const bigPrompt = "x".repeat(12_000);
    await helper.insertPrompt(fakePage, bigPrompt, {});
    expect(domFallbackValue).toBe(bigPrompt);
  });

  test("AiStudioBrowserWorker.insertPrompt tự bấm Dismiss card Enable URL Context trước khi điền prompt", async () => {
    const worker = new AiStudioBrowserWorker();
    const events: string[] = [];
    let nudgeVisible = true;
    let filledValue = "";

    const fakePage = {
      waitForTimeout: async () => {},
      locator: (sel: string) => {
        const isDismiss = sel.includes("urlcontext-nudge");
        const loc = {
          page: () => fakePage,
          first: () => loc,
          waitFor: async () => {},
          isVisible: async () => (isDismiss ? nudgeVisible : true),
          scrollIntoViewIfNeeded: async () => {},
          hover: async () => {
            events.push(isDismiss ? "hover:nudge" : "hover:composer");
          },
          click: async () => {
            events.push(isDismiss ? "click:dismiss_nudge" : "click:composer");
            if (isDismiss) nudgeVisible = false;
          },
          fill: async (val: string) => {
            events.push(`fill:composer:${val.length}`);
            filledValue = val;
          },
          inputValue: async () => filledValue,
        };
        return loc;
      },
    } as never;

    const helper = worker as unknown as {
      insertPrompt: (p: unknown, text: string, o: Record<string, unknown>) => Promise<void>;
    };
    await helper.insertPrompt(fakePage, "xin chao", {});

    expect(nudgeVisible).toBe(false);
    expect(filledValue).toBe("xin chao");
    expect(events.indexOf("click:dismiss_nudge")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("click:dismiss_nudge")).toBeLessThan(
      events.indexOf("fill:composer:8"),
    );
  });

  test("runEphemeralSurfaceTask hỗ trợ retainOnCompleted & omitConnectorIdentity để giữ tab speech khi thành công và đóng khi lỗi", async () => {
    const adapter = new AiStudioAdapter();
    const engine = (adapter as any).engine;
    const lifecycleCalls: Array<{ phase: string; body: Record<string, unknown> }> = [];
    const fakePage = { url: () => "https://aistudio.google.com/generate-speech" } as never;

    engine.lifecycleOps = {
      resolveDescriptorPath: () => "/tmp/fake-launcher.json",
      startTurn: async ({ activity }: { activity: Record<string, unknown> }) => {
        lifecycleCalls.push({ phase: "start", body: activity });
        return {
          surfaceId: "speech-surface-1",
          conversationId: undefined,
          reused: lifecycleCalls.filter((c) => c.phase === "start").length > 1,
          connection: {
            browser: { close: async () => {} },
            page: fakePage,
          },
        };
      },
      endTurn: async ({ activity }: { activity: Record<string, unknown> }) => {
        lifecycleCalls.push({ phase: "end", body: activity });
      },
      heartbeatTurn: async () => {},
      closeTurn: async () => {},
    };

    const opts = {
      initialUrl: "https://aistudio.google.com/generate-speech?model=gemini-2.5-pro-preview-tts",
      conversationKeySource: "speech:gemini-2.5-pro-preview-tts",
      retainOnCompleted: true,
      omitConnectorIdentity: true,
    };

    await engine.runEphemeralSurfaceTask(
      { headers: new Headers() },
      async ({ launcherReused }: { launcherReused: boolean }) => ({ ok: true, launcherReused }),
      opts,
    );
    await expect(
      engine.runEphemeralSurfaceTask(
        { headers: new Headers() },
        async () => {
          throw new Error("403 permission denied");
        },
        opts,
      ),
    ).rejects.toThrow("403 permission denied");

    expect(lifecycleCalls[0]?.body.connectorIdentity).toBeUndefined();
    expect(lifecycleCalls[0]?.body.conversationKey).toBe(lifecycleCalls[2]?.body.conversationKey);
    expect(lifecycleCalls[1]?.body.retain).toBe(true);
    expect(lifecycleCalls[1]?.body.status).toBe("completed");
    expect(lifecycleCalls[3]?.body.retain).toBe(false);
    expect(lifecycleCalls[3]?.body.status).toBe("failed");
  });
});
