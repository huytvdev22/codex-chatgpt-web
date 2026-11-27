import { describe, expect, test } from "bun:test";
import {
  buildChatGptConversationUrl,
  CHATGPT_HOME_URL,
  ChatGptAdapter,
  ChatGptCapabilityPicker,
  ChatGptModelProvider,
  chatGptConversationKey,
  createChatGptAdapter,
  isChatGptAuthUrl,
  normalizeChatGptConversationId,
  parseChatGptConversationId,
} from "../src/adapters/chatgpt";
import { WebTurnEngine } from "../src/adapters/web/engine";
import type { WebProviderDefinition } from "../src/adapters/web/definition";
import type { CodexParsedRequest } from "../src/types";

function makeParsedRequest(
  overrides: Partial<CodexParsedRequest> = {},
): CodexParsedRequest {
  return {
    modelId: "chatgpt/gpt-6.2",
    stream: true,
    options: { reasoning: "medium" },
    context: {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello ChatGPT" }],
          timestamp: 1_700_000_000_000,
        },
      ],
      tools: [],
    },
    ...overrides,
  };
}

function getDefinition(adapter: ChatGptAdapter): WebProviderDefinition {
  const engine = (adapter as unknown as { engine: WebTurnEngine }).engine;
  return (engine as unknown as { definition: WebProviderDefinition }).definition;
}

describe("ChatGptAdapter contract & URL helpers", () => {
  test("parse, normalize và build ChatGPT conversation URL từ chối path hệ thống", () => {
    const sampleId = "6afae1f3-e4f0-83ec-8aca-7c8649cfde1c";
    expect(normalizeChatGptConversationId(sampleId)).toBe(sampleId);
    expect(normalizeChatGptConversationId("new")).toBeUndefined();
    expect(normalizeChatGptConversationId("auth")).toBeUndefined();
    expect(parseChatGptConversationId(`https://chatgpt.com/c/${sampleId}`)).toBe(
      sampleId,
    );
    expect(
      parseChatGptConversationId(`https://chatgpt.com/g/g-123/c/${sampleId}`),
    ).toBe(sampleId);
    expect(
      parseChatGptConversationId("https://evil.example.com/c/6afae1f3-e4f0-83ec-8aca-7c8649cfde1c"),
    ).toBeUndefined();
    expect(buildChatGptConversationUrl(sampleId)).toBe(
      `https://chatgpt.com/c/${sampleId}`,
    );
    expect(isChatGptAuthUrl("https://auth.openai.com/u/login")).toBe(true);
    expect(isChatGptAuthUrl("https://chatgpt.com/auth/login")).toBe(true);
    expect(isChatGptAuthUrl("https://chatgpt.com/")).toBe(false);
  });

  test("chatGptConversationKey tạo SHA-256 hex ổn định theo threadId và giữ nguyên khi đổi model/reasoning cùng provider", () => {
    const keyA = chatGptConversationKey(
      makeParsedRequest({ modelId: "chatgpt/gpt-6.2", options: { reasoning: "medium" } }),
      "thread_secret_123",
    );
    const keyB = chatGptConversationKey(
      makeParsedRequest({ modelId: "chatgpt/gpt-6", options: { reasoning: "high" } }),
      "thread_secret_123",
    );
    const keyOtherThread = chatGptConversationKey(
      makeParsedRequest({ modelId: "chatgpt/gpt-6.2", options: { reasoning: "medium" } }),
      "thread_secret_456",
    );

    expect(keyA).toMatch(/^[a-f0-9]{64}$/);
    expect(keyA).toBe(keyB);
    expect(keyA).not.toBe(keyOtherThread);
    expect(keyA).not.toContain("thread_secret_123");
  });

  test("resolveState vẫn đánh dấu isNewConversation=true khi chưa có tab/link web dù Codex đã có lịch sử", () => {
    const adapter = createChatGptAdapter() as ChatGptAdapter;
    const def = getDefinition(adapter);
    const resolved = def.conversation.resolveState?.({
      parsed: makeParsedRequest(),
      incoming: { headers: new Headers() },
      leaseConversationId: undefined,
      launcherReused: false,
      hasPriorAssistantReply: true,
    });
    expect(resolved).toEqual({
      existingConversationId: undefined,
      isNewConversation: true,
    });
  });

  test("WebProviderDefinition tuân thủ fail-closed, ephemeral json_schema retain=false, max 3 images và usage tracking", () => {
    const adapter = createChatGptAdapter() as ChatGptAdapter;
    const def = getDefinition(adapter);

    expect(def.id).toBe("chatgpt");
    expect(def.assistantName).toBe("ChatGPT");
    expect(def.browser.launcherProviderId).toBe("chatgpt");
    expect(def.browser.connectorIdentity).toBe("chatgpt");
    expect(def.policies?.launcherFailureMode).toBe("fail-closed");
    expect(def.policies?.enableEarlyExitOnFinalAnswer).toBe(true);
    expect(def.policies?.enableToolLoopGuard).toBe(true);
    expect(def.attachments?.maxInputImages).toBe(3);

    expect(def.browser.resolveInitialUrl?.({ modelId: "chatgpt/gpt-6", existingConversationId: undefined })).toBe(
      CHATGPT_HOME_URL,
    );
    expect(
      def.browser.resolveInitialUrl?.({
        modelId: "chatgpt/gpt-6",
        existingConversationId: "6afae1f3-e4f0-83ec-8aca-7c8649cfde1c",
      }),
    ).toBe("https://chatgpt.com/c/6afae1f3-e4f0-83ec-8aca-7c8649cfde1c");

    const jsonSchemaParsed = makeParsedRequest({
      options: {
        outputFormat: {
          type: "json_schema",
          name: "title_schema",
          strict: true,
          schema: { type: "object", properties: { title: { type: "string" } } },
        },
      },
    });
    const ephemeralBinding = def.conversation.resolveEndTurnBinding?.({
      finalStatus: "completed",
      activeConversationId: "6afae1f3-e4f0-83ec-8aca-7c8649cfde1c",
      parsed: jsonSchemaParsed,
      hasPriorAssistantReply: false,
      hasToolResults: false,
    });
    expect(ephemeralBinding).toEqual({ connectorBound: false, retain: false });

    const normalBinding = def.conversation.resolveEndTurnBinding?.({
      finalStatus: "completed",
      activeConversationId: "6afae1f3-e4f0-83ec-8aca-7c8649cfde1c",
      parsed: makeParsedRequest(),
      hasPriorAssistantReply: false,
      hasToolResults: false,
    });
    expect(normalBinding).toEqual({
      connectorBound: true,
      conversationId: "6afae1f3-e4f0-83ec-8aca-7c8649cfde1c",
      retain: true,
    });

    const attachmentsAttempt0 = def.attachments?.extractAttachments?.({
      parsed: makeParsedRequest(),
      attempt: 0,
      normalized: {
        prompt: "hi",
        images: [
          { name: "a.png", mimeType: "image/png", buffer: Buffer.from("a") },
        ],
      } as never,
    });
    const attachmentsAttempt1 = def.attachments?.extractAttachments?.({
      parsed: makeParsedRequest(),
      attempt: 1,
      normalized: {
        prompt: "hi",
        images: [
          { name: "a.png", mimeType: "image/png", buffer: Buffer.from("a") },
        ],
      } as never,
    });
    expect(attachmentsAttempt0).toHaveLength(1);
    expect(attachmentsAttempt1).toEqual([]);

    const usage = def.response?.computeUsage?.({
      initialPrompt: "Hello world",
      totalPromptChars: 11,
      lastRaw: "Hi there",
    });
    expect(usage?.totalTokens).toBeGreaterThan(0);
  });

  test("ChatGptCapabilityPicker không bỏ qua bước chọn GPT-6.2 khi UI đang ở 5.6 và thiếu nút Reset to default", async () => {
    const picker = new ChatGptCapabilityPicker();
    let clickedToggle = false;
    let clickedGpt62Radio = false;
    let currentEffort = "medium";

    const makeLocator = (kind: string, index = 0): any => ({
      first() {
        return makeLocator(kind, 0);
      },
      last() {
        return makeLocator(kind, 0);
      },
      nth(i: number) {
        return makeLocator(kind, i);
      },
      locator(subSel: string) {
        if (subSel.includes("model-picker-view-toggle")) return makeLocator("viewToggle");
        if (subSel.includes("menuitemradio")) return makeLocator("radios");
        if (subSel.includes("reasoning-slider")) return makeLocator("sliderRow");
        if (subSel.includes("slider")) return makeLocator("sliderThumb");
        if (subSel.includes("Legacy")) return makeLocator("legacy");
        return makeLocator("unknown");
      },
      async isVisible() {
        if (kind === "legacy") return false;
        return true;
      },
      async waitFor() {},
      async click() {
        if (kind === "viewToggle") clickedToggle = true;
        if (kind === "radios" && index === 0) clickedGpt62Radio = true;
      },
      async count() {
        if (kind === "radios") return 2;
        return 1;
      },
      async innerText() {
        if (kind === "radios") return index === 0 ? "GPT-6.2" : "GPT-5.6 Sol";
        return "";
      },
      async getAttribute(name: string) {
        if (kind === "trigger" && name === "data-selected-reasoning-effort") return currentEffort;
        if (kind === "radios" && name === "aria-checked") {
          return index === 0 ? (clickedGpt62Radio ? "true" : "false") : "true";
        }
        return null;
      },
      async evaluate(fn: any, arg: any) {
        if (kind === "menu") {
          // Giả lập simple view đang hiện "5.6" và KHÔNG có nút "Reset to default"
          const fakeMenu = {
            querySelector: (sel: string) =>
              sel.includes("view-toggle") ? { innerText: "5.6\nThinking", textContent: "5.6\nThinking" } : null,
            querySelectorAll: () => [],
          };
          return fn(fakeMenu, arg);
        }
        return { min: 0, max: 2, now: 1 };
      },
    });

    const fakePage: any = {
      locator(sel: string) {
        if (sel.includes("Select ChatGPT model")) return makeLocator("trigger");
        if (sel.includes("role=\"menu\"")) return makeLocator("menu");
        return makeLocator("other");
      },
      keyboard: { press: async () => {} },
      waitForTimeout: async () => {},
    };

    const target = ChatGptModelProvider.getInstance().resolveCapabilityTarget("chatgpt/gpt-6.2", "medium");
    const result = await picker.ensureCapabilityDetailed(fakePage, target);

    expect(result.modelSelected).toBe(true);
    expect(clickedToggle).toBe(true);
    expect(clickedGpt62Radio).toBe(true);
  });
});
