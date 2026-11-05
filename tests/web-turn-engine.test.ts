import { describe, expect, test } from "bun:test";
import {
  WebProviderAdapter,
  WebTurnEngine,
  conversationGuard,
  type WebProviderDefinition,
} from "../src/adapters/web";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

function createParsedRequest(
  messages: Array<{ role: string; content: string }> = [
    { role: "user", content: "Xin chào" },
  ],
  tools: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }> = [],
): CodexParsedRequest {
  return {
    modelId: "test-web/default",
    stream: true,
    options: { reasoning: "medium" } as any,
    context: {
      systemPrompt: ["System prompt"],
      messages: messages.map(m => ({ ...m, timestamp: Date.now() })) as any,
      tools: tools as any,
    },
    _rawBody: {
      model: "test-web/default",
      input: messages,
    },
  };
}

describe("WebTurnEngine & WebProviderAdapter Contract Tests", () => {
  test("1. Ném AbortError ngay lập tức nếu incoming.abortSignal đã bị hủy trước khi bắt đầu", async () => {
    const controller = new AbortController();
    controller.abort();

    const definition: WebProviderDefinition = {
      id: "test-web",
      assistantName: "TestAssistant",
      logPrefix: "test-adapter",
      abortMessage: "Test turn aborted before start",
      policies: { manageLauncherLeaseInEngine: false },
      conversation: {
        resolveConversationKey: () => "key-1",
      },
      browser: {
        launcherProviderId: "gemini",
        connectorIdentity: "test-web",
        executeTurn: async () => ({ rawResponse: "" }),
      },
    };

    const adapter = new WebProviderAdapter(definition);
    expect(adapter.name).toBe("test-web");

    await expect(
      adapter.runTurn(
        createParsedRequest(),
        { headers: new Headers(), abortSignal: controller.signal },
        () => {},
      ),
    ).rejects.toThrow("Test turn aborted before start");
  });

  test("2. Thực thi thành công lượt trả về final_answer chuẩn <webResponse>", async () => {
    const events: AdapterEvent[] = [];
    const definition: WebProviderDefinition = {
      id: "test-web",
      assistantName: "TestAssistant",
      logPrefix: "test-adapter",
      policies: { manageLauncherLeaseInEngine: false },
      conversation: {
        resolveConversationKey: () => "key-2",
      },
      browser: {
        launcherProviderId: "gemini",
        connectorIdentity: "test-web",
        executeTurn: async () => ({
          rawResponse: "````markdown\n<webResponse>\nXin chào từ WebTurnEngine!\n</webResponse>\n````",
          conversationId: "conv-123",
        }),
      },
    };

    const engine = new WebTurnEngine(definition);
    await engine.runTurn(
      createParsedRequest(),
      { headers: new Headers() },
      ev => events.push(ev),
    );

    expect(events).toEqual([
      { type: "text_delta", text: "Xin chào từ WebTurnEngine!" },
      { type: "done" },
    ]);
  });

  test("3. Tự động retry khi sai định dạng và emit tool_call hợp lệ ở lần thử tiếp theo", async () => {
    const events: AdapterEvent[] = [];
    let attempts = 0;

    const definition: WebProviderDefinition = {
      id: "test-web",
      assistantName: "TestAssistant",
      logPrefix: "test-adapter",
      policies: { manageLauncherLeaseInEngine: false, maxFormatRetries: 2 },
      conversation: {
        resolveConversationKey: () => "key-3",
      },
      browser: {
        launcherProviderId: "qwen",
        connectorIdentity: "test-web",
        executeTurn: async () => {
          attempts += 1;
          if (attempts === 1) {
            return { rawResponse: "Phản hồi thiếu thẻ webResponse" };
          }
          return {
            rawResponse: [
              "````markdown",
              "<webResponse>",
              "<tool_call>",
              '{"name":"exec_command","arguments":{"cmd":"pwd"}}',
              "</tool_call>",
              "</webResponse>",
              "````",
            ].join("\n"),
          };
        },
      },
      response: {
        createCallId: () => "call_fixed_1",
      },
    };

    const engine = new WebTurnEngine(definition);
    await engine.runTurn(
      createParsedRequest(
        [{ role: "user", content: "Kiểm tra thư mục" }],
        [{ name: "exec_command", description: "Run command", parameters: {} }],
      ),
      { headers: new Headers() },
      ev => events.push(ev),
    );

    expect(attempts).toBe(2);
    expect(events[0]).toEqual({
      type: "tool_call_start",
      id: "call_fixed_1",
      name: "exec_command",
    });
    expect(events[1]?.type).toBe("tool_call_delta");
    expect(events[2]).toEqual({ type: "tool_call_end" });
    expect(events[3]).toEqual({ type: "done" });
  });

  test("4. Hỗ trợ sanitizeRawResponse và tolerantNaturalTextFallback cho Google AI Studio", async () => {
    const events: AdapterEvent[] = [];

    const definition: WebProviderDefinition = {
      id: "google-ai-studio",
      assistantName: "Google AI Studio",
      logPrefix: "ai-studio-adapter",
      policies: { manageLauncherLeaseInEngine: false },
      conversation: {
        resolveConversationKey: () => "key-4",
      },
      browser: {
        launcherProviderId: "google-ai-studio",
        connectorIdentity: "google-ai-studio",
        executeTurn: async () => ({
          rawResponse: "Phản hồi văn bản tự nhiên không bọc thẻ XML",
        }),
      },
      response: {
        tolerantNaturalTextFallback: true,
        includeDetailedDoneEvent: true,
        computeUsage: () => ({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
      },
    };

    const engine = new WebTurnEngine(definition);
    await engine.runTurn(
      createParsedRequest(),
      { headers: new Headers() },
      ev => events.push(ev),
    );

    expect(events).toEqual([
      {
        type: "text_delta",
        text: "Phản hồi văn bản tự nhiên không bọc thẻ XML",
      },
      {
        type: "done",
        stopReason: "stop",
        endTurn: true,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    ]);
  });

  test("5. Hỗ trợ enableEarlyExitOnFinalAnswer và enableToolLoopGuard cho M365 policy", async () => {
    const events: AdapterEvent[] = [];
    let browserCalled = false;

    const definition: WebProviderDefinition = {
      id: "m365-copilot",
      assistantName: "M365",
      logPrefix: "m365-adapter",
      policies: {
        manageLauncherLeaseInEngine: false,
        enableEarlyExitOnFinalAnswer: true,
        enableToolLoopGuard: true,
      },
      conversation: {
        resolveConversationKey: () => "key-early-exit",
      },
      browser: {
        launcherProviderId: "m365",
        connectorIdentity: "m365-copilot",
        executeTurn: async () => {
          browserCalled = true;
          return { rawResponse: "" };
        },
      },
    };

    conversationGuard.set("key-early-exit", {
      toolIterations: 2,
      identicalToolCount: 1,
      updatedAt: Date.now(),
    });

    const engine = new WebTurnEngine(definition);
    await engine.runTurn(
      createParsedRequest([
        { role: "user", content: "Chào" },
        { role: "assistant", content: "Câu trả lời đã hoàn tất." },
      ]),
      { headers: new Headers() },
      ev => events.push(ev),
    );

    expect(browserCalled).toBe(false);
    expect(conversationGuard.has("key-early-exit")).toBe(false);
    expect(events).toEqual([
      {
        type: "done",
        stopReason: "stop",
        endTurn: true,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    ]);
  });
});
