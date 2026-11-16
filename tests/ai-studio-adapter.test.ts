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
import { AiStudioDomObserver } from "../src/adapters/ai-studio/ai-studio-dom-observer";
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
  });
});
