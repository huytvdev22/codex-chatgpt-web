import { describe, expect, test } from "bun:test";
import { AdapterRegistry } from "../src/adapters/adapter-registry";
import { WebProviderAdapter } from "../src/adapters/web/web-provider-adapter";
import {
  AI_STUDIO_NEW_CHAT_URL,
  AiStudioAdapter,
  AiStudioModelProvider,
  aiStudioConversationKey,
  buildAiStudioConversationUrl,
  buildAiStudioNewChatUrl,
  normalizeAiStudioConversationId,
  parseAiStudioConversationId,
} from "../src/adapters/ai-studio";
import { AI_STUDIO_DOM_SELECTORS, AiStudioDomObserver } from "../src/adapters/ai-studio/ai-studio-dom-observer";
import {
  normalizeCopiedAiStudioCodeSnippet,
  resolveClipboardMenuItemIndex,
} from "../src/adapters/ai-studio/ai-studio-clipboard-salvage";
import { selectPreferredAiStudioResponse } from "../src/adapters/ai-studio/ai-studio-browser-worker";
import { parseStrictWebResponse } from "../src/adapters/web/protocol/strict-response-parser";
import { resolveAiStudioThinkingLevel } from "../src/adapters/ai-studio/capability-picker";
import { ModelRegistry } from "../src/models/model-registry";
import type { CodexParsedRequest } from "../src/types";

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

describe("Google AI Studio Web Adapter", () => {
  test("ModelRegistry & AdapterRegistry đăng ký duy nhất model ai-studio/gemini-4-hydrogen", () => {
    const modelProvider = AiStudioModelProvider.getInstance();
    expect(modelProvider.id).toBe("ai-studio");
    expect(modelProvider.routes.map(route => route.slug)).toEqual(["ai-studio/gemini-4-hydrogen"]);
    expect(modelProvider.matchModelSlug("ai-studio/gemini-4-hydrogen")).toBe(true);
    expect(modelProvider.matchModelSlug("ai-studio/gemini-4-carbon")).toBe(false);

    expect(ModelRegistry.getInstance().findProvider("ai-studio/gemini-4-hydrogen")?.id).toBe("ai-studio");
    expect(ModelRegistry.getInstance().findProvider("ai-studio/gemini-4-carbon")).toBeUndefined();

    expect(resolveAiStudioThinkingLevel("ai-studio/gemini-4-hydrogen", "low")).toBe("Low");
    expect(resolveAiStudioThinkingLevel("ai-studio/gemini-4-hydrogen", "medium")).toBe("Medium");
    expect(resolveAiStudioThinkingLevel("ai-studio/gemini-4-hydrogen", "high")).toBe("High");

    const adapter = AdapterRegistry.getInstance().createAdapter("ai-studio");
    expect(adapter).toBeInstanceOf(AiStudioAdapter);
    expect(adapter).toBeInstanceOf(WebProviderAdapter);
    expect(adapter.name).toBe("ai-studio");
  });

  test("parse/normalize AI Studio conversation URL bảo toàn chữ hoa/thường và từ chối new_chat", () => {
    const sampleId = "1f4VKkbKG5PxctRMKVZN4bR3TRBcc1ROb";
    expect(AI_STUDIO_NEW_CHAT_URL).toBe("https://aistudio.google.com/prompts/new_chat?model=gemini-4-hydrogen");
    expect(buildAiStudioNewChatUrl("gemini-4-hydrogen")).toBe(AI_STUDIO_NEW_CHAT_URL);
    expect(normalizeAiStudioConversationId(sampleId)).toBe(sampleId);
    expect(normalizeAiStudioConversationId("new_chat")).toBeUndefined();
    expect(parseAiStudioConversationId(`https://aistudio.google.com/prompts/${sampleId}`)).toBe(sampleId);
    expect(parseAiStudioConversationId("https://aistudio.google.com/prompts/new_chat?model=gemini-4-hydrogen")).toBeUndefined();
    expect(parseAiStudioConversationId("https://evil.example.com/prompts/1f4VKkbKG5PxctRMKVZN4bR3TRBcc1ROb")).toBeUndefined();
    expect(buildAiStudioConversationUrl(sampleId)).toBe(`https://aistudio.google.com/prompts/${sampleId}`);
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
      rawHtml: "<p>78</p>",
      rawText: "78",
      hasContent: true,
    });
    expect(completedAnswer.isGenerating).toBe(false);
    expect(completedAnswer.isCompleted).toBe(true);
    expect(completedAnswer.text).toBe("78");

    expect(() => observer.applyStatus(state, {
      isGenerating: false,
      responseReadyLive: false,
      hasNewAnswerTurn: true,
      hasTurnFooter: false,
      thoughtsCount: 0,
      rawHtml: "",
      rawText: "Permission denied. Please check your account permissions and project settings.",
      hasContent: true,
      detectedWebError: "Permission denied. Please check your account permissions and project settings.",
    })).toThrow("[AI Studio Web Error] Permission denied.");
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

  test("AiStudioClipboardSalvage khớp menu item kèm icon ligature và ưu tiên bản extraction đầy đủ", () => {
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

  test("AiStudioAdapter resolveEndTurnBinding không retain tab nếu không có conversationId sau khi hoàn tất", () => {
    const adapter = new AiStudioAdapter();
    const resolveEndTurnBinding = (
      adapter as unknown as {
        definition: {
          conversation: {
            resolveEndTurnBinding?: (ctx: {
              finalStatus: "completed" | "failed" | "aborted";
              activeConversationId?: string;
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

  test("AiStudioAdapter dùng browserTransport='electron-control' và AiStudioBrowserWorker thực thi turn qua ElectronSurfaceClient", async () => {
    const { ElectronSurfaceClient } = await import("../src/adapters/web/electron-surface-client");
    const { AiStudioBrowserWorker } = await import("../src/adapters/ai-studio");

    const adapter = new AiStudioAdapter();
    const policies = (
      adapter as unknown as { definition: { policies?: { browserTransport?: string } } }
    ).definition.policies;
    expect(policies?.browserTransport).toBe("electron-control");

    const actions: string[] = [];
    let currentUrl = "https://aistudio.google.com/prompts/new_chat?model=gemini-4-hydrogen";
    let submitted = false;

    const client = new ElectronSurfaceClient({
      controlEndpoint: "http://127.0.0.1:9223",
      controlToken: "test-token",
      traceId: "trace-aistudio-turn",
      helperPid: process.pid,
      fetchFn: (async (_url, init) => {
        const body = JSON.parse(String(init?.body || "{}")) as {
          action: string;
          args: Record<string, unknown>;
        };
        actions.push(body.action);
        let result: unknown = {};
        if (body.action === "getUrl") {
          result = { url: currentUrl };
        } else if (body.action === "aiStudioCheckCleanNewChat") {
          result = { clean: true };
        } else if (body.action === "aiStudioSelectThinkingLevel") {
          result = { changed: false };
        } else if (body.action === "aiStudioCheckComposerIdle") {
          result = { idle: true };
        } else if (body.action === "aiStudioCaptureBaseline") {
          result = { modelContainerCount: 0, answerCount: 0, thoughtsCount: 0, lastAnswerText: "" };
        } else if (body.action === "aiStudioCheckSubmitStatus") {
          result = submitted
            ? { isStop: true, isRunningLive: true, isDisabled: false, editorLength: 0 }
            : { isStop: false, isRunningLive: false, isDisabled: false, editorLength: 10 };
        } else if (body.action === "clickSelector") {
          submitted = true;
          currentUrl = "https://aistudio.google.com/prompts/1f4VKkbKG5PxctRMKVZN4bR3TRBcc1ROb";
          result = { clicked: true };
        } else if (body.action === "aiStudioCaptureStatus") {
          result = {
            isGenerating: false,
            responseReadyLive: true,
            hasNewAnswerTurn: true,
            hasTurnFooter: true,
            thoughtsCount: 0,
            rawHtml: "<p>OK</p>",
            rawText: "OK",
            singleMarkdownCodeBlockText: null,
            hasContent: true,
          };
        } else if (body.action === "aiStudioCopyMarkdown") {
          result = { text: "````markdown\n<webResponse>\nXin chào Electron\n</webResponse>\n````" };
        }
        return new Response(JSON.stringify({ ok: true, result }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    const worker = new AiStudioBrowserWorker();
    const res = await worker.executeTurn(client, {
      prompt: "Chào",
      modelSlug: "ai-studio/gemini-4-hydrogen",
      pollingIntervalMs: 1,
    });

    expect(actions).toContain("aiStudioCheckCleanNewChat");
    expect(actions).toContain("aiStudioWaitForBotGuardReady");
    expect(actions).toContain("aiStudioCaptureBaseline");
    expect(actions).toContain("fillTextarea");
    expect(actions).toContain("aiStudioCaptureStatus");
    expect(actions).toContain("aiStudioCopyMarkdown");
    expect(res).toEqual({
      rawResponse: "````markdown\n<webResponse>\nXin chào Electron\n</webResponse>\n````",
      conversationId: "1f4VKkbKG5PxctRMKVZN4bR3TRBcc1ROb",
    });

    // Lượt tái sử dụng tab (launcherReused=true) bỏ qua aiStudioWaitForBotGuardReady để không chờ thừa
    actions.length = 0;
    submitted = false;
    await worker.executeTurn(client, {
      prompt: "Lượt 2",
      existingConversationId: "1f4VKkbKG5PxctRMKVZN4bR3TRBcc1ROb",
      launcherReused: true,
      pollingIntervalMs: 1,
    });
    expect(actions).not.toContain("aiStudioWaitForBotGuardReady");
  });

  test("runEphemeralSurfaceTask hỗ trợ retainOnCompleted & omitConnectorIdentity để giữ tab speech khi thành công và đóng khi lỗi", async () => {
    const adapter = new AiStudioAdapter();
    const engine = (adapter as any).engine;
    const lifecycleCalls: Array<{ phase: string; body: Record<string, unknown> }> = [];

    engine.lifecycleOps = {
      resolveDescriptorPath: () => "/tmp/fake-launcher.json",
      startTurn: async ({ activity }: { activity: Record<string, unknown> }) => {
        lifecycleCalls.push({ phase: "start", body: activity });
        return {
          surfaceId: "speech-surface-1",
          conversationId: undefined,
          reused: lifecycleCalls.filter(c => c.phase === "start").length > 1,
          descriptor: {
            control: { endpoint: "http://127.0.0.1:9999", token: "tok" },
          },
          connection: null,
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
