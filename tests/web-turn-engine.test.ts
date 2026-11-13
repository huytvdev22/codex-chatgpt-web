import { describe, expect, test } from "bun:test";
import {
  startLauncherBrowserTurn,
  WebProviderAdapter,
  WebTurnEngine,
  conversationGuard,
  MAX_IDENTICAL_WRITE_TOOL_CALLS,
  MAX_TOOL_ITERATIONS,
  type WebProviderDefinition,
  type WebRuntimeLifecycleOps,
} from "../src/adapters/web";
import { M365CopilotAdapter } from "../src/adapters/m365-copilot";
import { ChatGptWebAdapter } from "../src/adapters/chatgpt-web";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

function createParsedRequest(
  messages: Array<{ role: string; content: string }> = [
    { role: "user", content: "Xin chào" },
  ],
  tools: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }> = [],
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
        launcherProviderId: "m365",
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
        launcherProviderId: "m365",
        connectorIdentity: "test-web",
        executeTurn: async () => ({
          rawResponse:
            "````markdown\n<webResponse>\nXin chào từ WebTurnEngine!\n</webResponse>\n````",
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
        launcherProviderId: "chatgpt",
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

  test("4. Hỗ trợ sanitizeRawResponse và tolerantNaturalTextFallback cho custom provider", async () => {
    const events: AdapterEvent[] = [];

    const definition: WebProviderDefinition = {
      id: "m365-copilot",
      assistantName: "M365 Copilot",
      logPrefix: "m365-adapter",
      policies: { manageLauncherLeaseInEngine: false },
      conversation: {
        resolveConversationKey: () => "key-4",
      },
      browser: {
        launcherProviderId: "m365",
        connectorIdentity: "m365-copilot",
        executeTurn: async () => ({
          rawResponse:
            "code Codedownload <webResponse>Câu trả lời sau khi lọc rác</webResponse> trailing_noise",
        }),
      },
      response: {
        sanitizeRawResponse: raw => {
          const start = raw.indexOf("<webResponse>");
          const end = raw.lastIndexOf("</webResponse>");
          return start >= 0 && end >= 0
            ? raw.slice(start, end + "</webResponse>".length)
            : raw;
        },
        tolerantNaturalTextFallback: true,
        includeDetailedDoneEvent: true,
        computeUsage: () => ({
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
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
      {
        type: "text_delta",
        text: "Câu trả lời sau khi lọc rác",
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

  test("6. Toàn bộ 2 Web Provider Adapters đều kế thừa WebProviderAdapter dùng chung", () => {
    const adapters = [
      new M365CopilotAdapter(),
      new ChatGptWebAdapter(),
    ];

    for (const adapter of adapters) {
      expect(adapter).toBeInstanceOf(WebProviderAdapter);
      expect(typeof adapter.runTurn).toBe("function");
    }
  });

  // =========================================================================
  // 4.1. Lifecycle Matrix
  // =========================================================================

  test("7. Lifecycle: launcherFailureMode='fail-closed' ném lỗi ngay khi có descriptorPath nhưng startTurn ném lỗi", async () => {
    let localBrowserCalled = false;
    const localBrowser = {
      ensurePage: async () => {
        localBrowserCalled = true;
        return {} as any;
      },
    } as any;

    const ops: Partial<WebRuntimeLifecycleOps> = {
      resolveDescriptorPath: () => "/tmp/fake-descriptor.json",
      startTurn: async () => {
        throw new Error("CDP connection refused");
      },
    };

    const definition: WebProviderDefinition = {
      id: "chatgpt-web",
      assistantName: "ChatGPT",
      logPrefix: "chatgpt-adapter",
      policies: {
        launcherFailureMode: "fail-closed",
        emitErrorEventOnFailure: false,
        rethrowError: true,
      },
      conversation: { resolveConversationKey: () => "key-lc-1" },
      browser: {
        launcherProviderId: "chatgpt",
        connectorIdentity: "chatgpt-web",
        executeTurn: async () => ({ rawResponse: "" }),
      },
    };

    const engine = new WebTurnEngine(definition, localBrowser, ops);
    await expect(
      engine.runTurn(createParsedRequest(), { headers: new Headers() }, () => {}),
    ).rejects.toThrow(
      "[chatgpt-adapter] Không thể kết nối với Launcher browser tab: CDP connection refused",
    );
    expect(localBrowserCalled).toBe(false);
  });

  test("8. Lifecycle: launcherFailureMode='fail-closed' ném lỗi khi có descriptorPath nhưng startTurn trả về null (Launcher đã dừng)", async () => {
    let localBrowserCalled = false;
    const localBrowser = {
      ensurePage: async () => {
        localBrowserCalled = true;
        return {} as any;
      },
    } as any;

    const ops: Partial<WebRuntimeLifecycleOps> = {
      resolveDescriptorPath: () => "/tmp/fake-descriptor.json",
      startTurn: async () => null,
    };

    const definition: WebProviderDefinition = {
      id: "chatgpt-web",
      assistantName: "ChatGPT",
      logPrefix: "chatgpt-adapter",
      policies: {
        launcherFailureMode: "fail-closed",
        emitErrorEventOnFailure: false,
        rethrowError: true,
      },
      conversation: { resolveConversationKey: () => "key-lc-2" },
      browser: {
        launcherProviderId: "chatgpt",
        connectorIdentity: "chatgpt-web",
        executeTurn: async () => ({ rawResponse: "" }),
      },
    };

    const engine = new WebTurnEngine(definition, localBrowser, ops);
    await expect(
      engine.runTurn(createParsedRequest(), { headers: new Headers() }, () => {}),
    ).rejects.toThrow(
      "[chatgpt-adapter] Không thể kết nối với Launcher browser tab.",
    );
    expect(localBrowserCalled).toBe(false);
  });

  test("9. Lifecycle: launcherFailureMode='fallback-local' tự động chuyển sang LocalBrowserRuntime khi Launcher lỗi", async () => {
    const fakeLocalPage = { kind: "local-page" } as any;
    let receivedPage: any = null;

    const localBrowser = {
      ensurePage: async () => fakeLocalPage,
    } as any;

    const ops: Partial<WebRuntimeLifecycleOps> = {
      resolveDescriptorPath: () => "/tmp/fake-descriptor.json",
      startTurn: async () => {
        throw new Error("Launcher offline");
      },
    };

    const definition: WebProviderDefinition = {
      id: "m365-copilot",
      assistantName: "M365 Copilot",
      logPrefix: "m365-adapter",
      policies: {
        launcherFailureMode: "fallback-local",
      },
      conversation: { resolveConversationKey: () => "key-lc-3" },
      browser: {
        launcherProviderId: "m365",
        connectorIdentity: "m365-copilot",
        executeTurn: async ({ page }) => {
          receivedPage = page;
          return {
            rawResponse:
              "````markdown\n<webResponse>\nFallback local thành công\n</webResponse>\n````",
          };
        },
      },
    };

    const events: AdapterEvent[] = [];
    const engine = new WebTurnEngine(definition, localBrowser, ops);
    await engine.runTurn(
      createParsedRequest(),
      { headers: new Headers() },
      ev => events.push(ev),
    );

    expect(receivedPage).toBe(fakeLocalPage);
    expect(events[0]).toEqual({
      type: "text_delta",
      text: "Fallback local thành công",
    });
  });

  test("10. Lifecycle: manageLauncherLeaseInEngine=false hỗ trợ compatibility provider tự quản lý lease", async () => {
    let startCalled = false;
    let endCalled = false;
    let closeCalled = false;

    const ops: Partial<WebRuntimeLifecycleOps> = {
      resolveDescriptorPath: () => "/tmp/fake-descriptor.json",
      startTurn: async () => {
        startCalled = true;
        return null;
      },
      endTurn: async () => {
        endCalled = true;
      },
      closeTurn: async () => {
        closeCalled = true;
      },
    };

    const definition: WebProviderDefinition = {
      id: "m365-copilot",
      assistantName: "M365",
      logPrefix: "m365-adapter",
      policies: { manageLauncherLeaseInEngine: false },
      conversation: { resolveConversationKey: () => "key-lc-4" },
      browser: {
        launcherProviderId: "m365",
        connectorIdentity: "legacy-self-managed-provider",
        executeTurn: async ({ page }) => {
          expect(page).toBeNull();
          return {
            rawResponse:
              "````markdown\n<webResponse>\nWorker tự quản lý lease\n</webResponse>\n````",
          };
        },
      },
    };

    const engine = new WebTurnEngine(definition, undefined, ops);
    await engine.runTurn(
      createParsedRequest(),
      { headers: new Headers() },
      () => {},
    );

    expect(startCalled).toBe(false);
    expect(endCalled).toBe(false);
    expect(closeCalled).toBe(false);
  });

  test("10.1. Lifecycle: shared engine cấp heartbeat callback cho browser driver", async () => {
    const heartbeatActivities: any[] = [];
    const fakeConnection = { page: { kind: "m365-page" } } as any;
    const ops: Partial<WebRuntimeLifecycleOps> = {
      resolveDescriptorPath: () => "/tmp/m365-descriptor.json",
      startTurn: async () => ({
        connection: fakeConnection,
        surfaceId: "surface-m365",
        conversationId: "11111111-1111-4111-8111-111111111111",
        reused: true,
        connectorBound: true,
      }),
      heartbeatTurn: async ({ activity }) => {
        heartbeatActivities.push(activity);
      },
      endTurn: async () => {},
      closeTurn: async () => {},
    };

    const definition: WebProviderDefinition = {
      id: "m365-copilot",
      assistantName: "M365",
      logPrefix: "m365-adapter",
      conversation: {
        resolveConversationKey: () => "key-m365-heartbeat",
      },
      browser: {
        launcherProviderId: "m365",
        connectorIdentity: "m365-copilot",
        executeTurn: async ({ page, heartbeat, launcherReused }) => {
          expect(page).toBe(fakeConnection.page);
          expect(launcherReused).toBe(true);
          expect(heartbeat).toBeDefined();
          await heartbeat?.();
          return {
            rawResponse:
              "````markdown\n<webResponse>\nHeartbeat OK\n</webResponse>\n````",
            conversationId: "11111111-1111-4111-8111-111111111111",
          };
        },
      },
    };

    const engine = new WebTurnEngine(definition, undefined, ops);
    await engine.runTurn(
      createParsedRequest(),
      { headers: new Headers() },
      () => {},
    );

    expect(heartbeatActivities).toHaveLength(1);
    expect(heartbeatActivities[0]).toMatchObject({
      phase: "heartbeat",
      refreshViewport: false,
    });
    expect(heartbeatActivities[0]?.traceId).toEqual(expect.any(String));
    expect(heartbeatActivities[0]?.helperPid).toBe(process.pid);
  });

  test("11. Lifecycle: closeLauncherConnectionOnEnd=false gửi phase=end nhưng không đóng kết nối CDP", async () => {
    let endActivities: any[] = [];
    let closeCalled = false;
    const fakeConnection = { page: { kind: "studio-page" } } as any;

    const ops: Partial<WebRuntimeLifecycleOps> = {
      resolveDescriptorPath: () => "/tmp/studio-descriptor.json",
      startTurn: async () => ({
        connection: fakeConnection,
        surfaceId: "surface-studio",
        conversationId: "prompt-111",
        reused: true,
        connectorBound: true,
      }),
      endTurn: async ({ activity }) => {
        endActivities.push(activity);
      },
      closeTurn: async () => {
        closeCalled = true;
      },
    };

    const definition: WebProviderDefinition = {
      id: "chatgpt-web",
      assistantName: "ChatGPT",
      logPrefix: "chatgpt-adapter",
      policies: {
        closeLauncherConnectionOnEnd: false,
      },
      conversation: {
        resolveConversationKey: () => "key-conv",
        resolveEndTurnBinding: ({ activeConversationId, conversationKey }) => ({
          connectorBound: true,
          conversationId: activeConversationId || conversationKey,
        }),
      },
      browser: {
        launcherProviderId: "chatgpt",
        connectorIdentity: "chatgpt-web",
        executeTurn: async () => ({
          rawResponse:
            "````markdown\n<webResponse>\nChatGPT OK\n</webResponse>\n````",
          conversationId: "prompt-222",
        }),
      },
    };

    const engine = new WebTurnEngine(definition, undefined, ops);
    await engine.runTurn(
      createParsedRequest(),
      { headers: new Headers() },
      () => {},
    );

    expect(endActivities.length).toBe(1);
    expect(endActivities[0]?.phase).toBe("end");
    expect(endActivities[0]?.status).toBe("completed");
    expect(endActivities[0]?.conversationId).toBe("prompt-222");
    expect(closeCalled).toBe(false);
  });

  test("12. Lifecycle: Gửi phase=end với status='completed', 'failed' và 'aborted' chính xác theo kết quả lượt", async () => {
    const recordedStatuses: string[] = [];
    const recordedEndSignals: Array<AbortSignal | undefined> = [];
    let closedCount = 0;

    const createOps = (): Partial<WebRuntimeLifecycleOps> => ({
      resolveDescriptorPath: () => "/tmp/test-descriptor.json",
      startTurn: async () => ({
        connection: { page: {} } as any,
        surfaceId: "surface-1",
        conversationId: "conv-init",
        reused: false,
        connectorBound: false,
      }),
      endTurn: async ({ activity, signal }) => {
        recordedStatuses.push(activity.status);
        recordedEndSignals.push(signal);
      },
      closeTurn: async () => {
        closedCount += 1;
      },
    });

    // 1. Completed
    const engineOk = new WebTurnEngine(
      {
        id: "test-ok",
        assistantName: "Test",
        logPrefix: "test",
        conversation: { resolveConversationKey: () => "k1" },
        browser: {
          launcherProviderId: "chatgpt",
          connectorIdentity: "chatgpt-web",
          executeTurn: async () => ({
            rawResponse: "````markdown\n<webResponse>\nOK\n</webResponse>\n````",
          }),
        },
      },
      undefined,
      createOps(),
    );
    // Signal của request còn sống lúc gọi phase=end nhưng có thể bị hủy ngay sau
    // khi SSE đóng; phase=end không được phụ thuộc vào nó (xem troubleshooting 047).
    await engineOk.runTurn(
      createParsedRequest(),
      { headers: new Headers(), abortSignal: new AbortController().signal },
      () => {},
    );

    // 2. Failed
    const engineFail = new WebTurnEngine(
      {
        id: "test-fail",
        assistantName: "Test",
        logPrefix: "test",
        policies: { rethrowError: false, emitErrorEventOnFailure: false },
        conversation: { resolveConversationKey: () => "k2" },
        browser: {
          launcherProviderId: "chatgpt",
          connectorIdentity: "chatgpt-web",
          executeTurn: async () => {
            throw new Error("Browser crash");
          },
        },
      },
      undefined,
      createOps(),
    );
    await engineFail.runTurn(createParsedRequest(), { headers: new Headers() }, () => {});

    // 3. Aborted during turn
    const abortController = new AbortController();
    const engineAbort = new WebTurnEngine(
      {
        id: "test-abort",
        assistantName: "Test",
        logPrefix: "test",
        policies: { rethrowError: true, emitErrorEventOnFailure: false },
        conversation: { resolveConversationKey: () => "k3" },
        browser: {
          launcherProviderId: "chatgpt",
          connectorIdentity: "chatgpt-web",
          executeTurn: async () => {
            abortController.abort();
            throw new Error("Turn cancelled");
          },
        },
      },
      undefined,
      createOps(),
    );
    await expect(
      engineAbort.runTurn(
        createParsedRequest(),
        { headers: new Headers(), abortSignal: abortController.signal },
        () => {},
      ),
    ).rejects.toThrow("Turn cancelled");

    expect(recordedStatuses).toEqual(["completed", "failed", "aborted"]);
    expect(recordedEndSignals[0]).toBeUndefined();
    expect(recordedEndSignals[1]).toBeUndefined();
    expect(recordedEndSignals[2]).toBeUndefined();
    expect(closedCount).toBe(3);
  });

  test("13. Lifecycle: releaseWebTurnSurface vẫn luôn chạy trong finally ngay cả khi hàm emit ném lỗi", async () => {
    let endCalled = false;
    let closeCalled = false;

    const ops: Partial<WebRuntimeLifecycleOps> = {
      resolveDescriptorPath: () => "/tmp/test-descriptor.json",
      startTurn: async () => ({
        connection: { page: {} } as any,
        surfaceId: "surface-1",
        conversationId: "conv-1",
        reused: true,
        connectorBound: true,
      }),
      endTurn: async () => {
        endCalled = true;
      },
      closeTurn: async () => {
        closeCalled = true;
      },
    };

    const definition: WebProviderDefinition = {
      id: "test-emit-throw",
      assistantName: "Test",
      logPrefix: "test",
      policies: { emitErrorEventOnFailure: false, rethrowError: true },
      conversation: { resolveConversationKey: () => "k-emit" },
      browser: {
        launcherProviderId: "chatgpt",
        connectorIdentity: "chatgpt-web",
        executeTurn: async () => ({
          rawResponse: "````markdown\n<webResponse>\nHello\n</webResponse>\n````",
        }),
      },
    };

    const engine = new WebTurnEngine(definition, undefined, ops);
    await expect(
      engine.runTurn(createParsedRequest(), { headers: new Headers() }, () => {
        throw new Error("SSE stream broken during emit");
      }),
    ).rejects.toThrow("SSE stream broken during emit");

    expect(endCalled).toBe(true);
    expect(closeCalled).toBe(true);
  });

  // =========================================================================
  // 4.2. Error Policy Matrix
  // =========================================================================

  test("14. Error Policy: emitErrorEventOnFailure=true + rethrowError=true vừa emit error vừa ném lỗi", async () => {
    const events: AdapterEvent[] = [];
    const engine = new WebTurnEngine({
      id: "chatgpt-web",
      assistantName: "ChatGPT",
      logPrefix: "chatgpt-adapter",
      policies: {
        manageLauncherLeaseInEngine: false,
        emitErrorEventOnFailure: true,
        rethrowError: true,
      },
      conversation: { resolveConversationKey: () => "k-err-1" },
      browser: {
        launcherProviderId: "chatgpt",
        connectorIdentity: "chatgpt-web",
        executeTurn: async () => {
          throw new Error("DOM selector timeout");
        },
      },
    });

    await expect(
      engine.runTurn(
        createParsedRequest(),
        { headers: new Headers() },
        ev => events.push(ev),
      ),
    ).rejects.toThrow("DOM selector timeout");

    expect(events).toEqual([
      { type: "error", message: "DOM selector timeout" },
    ]);
  });

  test("15. Error Policy: emitErrorEventOnFailure=false + rethrowError=true chỉ ném lỗi mà không emit error trùng lặp", async () => {
    const events: AdapterEvent[] = [];
    const engine = new WebTurnEngine({
      id: "chatgpt-web",
      assistantName: "ChatGPT",
      logPrefix: "chatgpt-adapter",
      policies: {
        manageLauncherLeaseInEngine: false,
        emitErrorEventOnFailure: false,
        rethrowError: true,
      },
      conversation: { resolveConversationKey: () => "k-err-2" },
      browser: {
        launcherProviderId: "chatgpt",
        connectorIdentity: "chatgpt-web",
        executeTurn: async () => {
          throw new Error("Rate limit");
        },
      },
    });

    await expect(
      engine.runTurn(
        createParsedRequest(),
        { headers: new Headers() },
        ev => events.push(ev),
      ),
    ).rejects.toThrow("Rate limit");

    expect(events).toEqual([]);
  });

  test("16. Error Policy: emitErrorEventOnFailure=true + rethrowError=false + errorMessagePrefix (M365) emit error có tiền tố và nuốt lỗi", async () => {
    const events: AdapterEvent[] = [];
    const engine = new WebTurnEngine({
      id: "m365-copilot",
      assistantName: "M365",
      logPrefix: "m365-adapter",
      policies: {
        manageLauncherLeaseInEngine: false,
        emitErrorEventOnFailure: true,
        errorMessagePrefix: "[M365 Copilot]",
        rethrowError: false,
      },
      conversation: { resolveConversationKey: () => "k-err-3" },
      browser: {
        launcherProviderId: "m365",
        connectorIdentity: "m365-copilot",
        executeTurn: async () => {
          throw new Error("Không tìm thấy nút Send");
        },
      },
    });

    await engine.runTurn(
      createParsedRequest(),
      { headers: new Headers() },
      ev => events.push(ev),
    );

    expect(events).toEqual([
      {
        type: "error",
        message: "[M365 Copilot] Không tìm thấy nút Send",
      },
    ]);
  });

  test("17. Error Policy: Abort giữa chừng với rethrowError=false (M365) vẫn ném DOMException AbortError và không emit error thường", async () => {
    const events: AdapterEvent[] = [];
    const controller = new AbortController();

    const engine = new WebTurnEngine({
      id: "m365-copilot",
      assistantName: "M365",
      logPrefix: "m365-adapter",
      policies: {
        manageLauncherLeaseInEngine: false,
        emitErrorEventOnFailure: true,
        errorMessagePrefix: "[M365 Copilot]",
        rethrowError: false,
        abortedTurnMessage: "M365 Copilot turn aborted",
      },
      conversation: { resolveConversationKey: () => "k-err-4" },
      browser: {
        launcherProviderId: "m365",
        connectorIdentity: "m365-copilot",
        executeTurn: async () => {
          controller.abort();
          throw new Error("Worker cancelled");
        },
      },
    });

    await expect(
      engine.runTurn(
        createParsedRequest(),
        { headers: new Headers(), abortSignal: controller.signal },
        ev => events.push(ev),
      ),
    ).rejects.toThrow("M365 Copilot turn aborted");

    expect(events).toEqual([]);
  });

  // =========================================================================
  // 4.3. Conversation Policy Matrix
  // =========================================================================

  test("18. Conversation Policy: resolveState ưu tiên leaseConversationId và fallback sang store; onConversationUpdated lọc ID không hợp lệ", async () => {
    let capturedInput: any = null;
    let endBindingInput: any = null;

    const ops: Partial<WebRuntimeLifecycleOps> = {
      resolveDescriptorPath: () => "/tmp/conv-descriptor.json",
      startTurn: async () => ({
        connection: { page: {} } as any,
        surfaceId: "s1",
        conversationId: "valid-lease-id",
        reused: true,
        connectorBound: true,
      }),
      endTurn: async () => {},
      closeTurn: async () => {},
    };

    const engine = new WebTurnEngine(
      {
        id: "chatgpt-web",
        assistantName: "ChatGPT",
        logPrefix: "chatgpt-adapter",
        conversation: {
          resolveConversationKey: () => "conv-key-18",
          resolveState: ({ leaseConversationId }) => ({
            existingConversationId: leaseConversationId || "stored-id",
            isNewConversation: false,
          }),
          onConversationUpdated: ({ conversationId }) =>
            conversationId?.startsWith("valid-") ? conversationId : undefined,
          resolveEndTurnBinding: ctx => {
            endBindingInput = ctx;
            return {
              connectorBound: Boolean(ctx.activeConversationId),
              conversationId: ctx.activeConversationId,
            };
          },
        },
        browser: {
          launcherProviderId: "chatgpt",
          connectorIdentity: "chatgpt-web",
          executeTurn: async input => {
            capturedInput = input;
            // Trả về conversationId không hợp lệ -> phải bị onConversationUpdated bỏ qua, giữ nguyên valid-lease-id
            return {
              rawResponse:
                "````markdown\n<webResponse>\nDone\n</webResponse>\n````",
              conversationId: "invalid-temp-id",
            };
          },
        },
      },
      undefined,
      ops,
    );

    await engine.runTurn(
      createParsedRequest(),
      { headers: new Headers() },
      () => {},
    );

    expect(capturedInput?.existingConversationId).toBe("valid-lease-id");
    expect(capturedInput?.isNewConversation).toBe(false);
    expect(endBindingInput?.activeConversationId).toBe("valid-lease-id");
  });

  test("19. Conversation Policy: hoàn thành không có conversationId vẫn gửi connectorBound=true và không đính kèm conversationId rỗng", async () => {
    let capturedActivity: any = null;

    const ops: Partial<WebRuntimeLifecycleOps> = {
      resolveDescriptorPath: () => "/tmp/chatgpt-descriptor.json",
      startTurn: async () => ({
        connection: { page: {} } as any,
        surfaceId: "s-chatgpt",
        conversationId: undefined,
        reused: false,
        connectorBound: false,
      }),
      endTurn: async ({ activity }) => {
        capturedActivity = activity;
      },
      closeTurn: async () => {},
    };

    const engine = new WebTurnEngine(
      {
        id: "chatgpt-web",
        assistantName: "ChatGPT",
        logPrefix: "chatgpt-adapter",
        conversation: { resolveConversationKey: () => "chatgpt-key" },
        browser: {
          launcherProviderId: "chatgpt",
          connectorIdentity: "chatgpt-web",
          executeTurn: async () => ({
            rawResponse:
              "````markdown\n<webResponse>\nChatGPT reply\n</webResponse>\n````",
          }),
        },
      },
      undefined,
      ops,
    );

    await engine.runTurn(
      createParsedRequest(),
      { headers: new Headers() },
      () => {},
    );

    expect(capturedActivity?.connectorBound).toBe(true);
    expect("conversationId" in capturedActivity).toBe(false);
  });

  test("20. Conversation Policy: fallback sang conversationKey khi chưa có activeConversationId", async () => {
    let capturedActivity: any = null;

    const ops: Partial<WebRuntimeLifecycleOps> = {
      resolveDescriptorPath: () => "/tmp/studio-descriptor.json",
      startTurn: async () => ({
        connection: { page: {} } as any,
        surfaceId: "s-studio",
        conversationId: undefined,
        reused: false,
        connectorBound: false,
      }),
      endTurn: async ({ activity }) => {
        capturedActivity = activity;
      },
      closeTurn: async () => {},
    };

    const engine = new WebTurnEngine(
      {
        id: "chatgpt-web",
        assistantName: "ChatGPT",
        logPrefix: "chatgpt-adapter",
        conversation: {
          resolveConversationKey: () => "fallback-conv-key",
          resolveEndTurnBinding: ({ activeConversationId, conversationKey }) => ({
            connectorBound: true,
            conversationId: activeConversationId || conversationKey,
          }),
        },
        browser: {
          launcherProviderId: "chatgpt",
          connectorIdentity: "chatgpt-web",
          executeTurn: async () => ({
            rawResponse:
              "````markdown\n<webResponse>\nReply\n</webResponse>\n````",
          }),
        },
      },
      undefined,
      ops,
    );

    await engine.runTurn(
      createParsedRequest(),
      { headers: new Headers() },
      () => {},
    );

    expect(capturedActivity?.connectorBound).toBe(true);
    expect(capturedActivity?.conversationId).toBe("fallback-conv-key");
  });

  // =========================================================================
  // 4.4. Retry, Attachments, Loop Guard & Usage Matrix
  // =========================================================================

  test("21. Retry & Attachments: chỉ gửi attachments ở attempt=0, chuyển isNewConversation=false và giữ conversationId mới tạo ở attempt retry", async () => {
    const attemptInputs: Array<{
      attempt: number;
      isNewConversation: boolean;
      existingConversationId?: string;
      attachmentCount: number;
    }> = [];
    let usageContext: any = null;

    const engine = new WebTurnEngine({
      id: "m365-copilot",
      assistantName: "M365",
      logPrefix: "m365-adapter",
      policies: {
        manageLauncherLeaseInEngine: false,
        maxFormatRetries: 2,
      },
      conversation: {
        resolveConversationKey: () => "key-retry-attach",
      },
      attachments: {
        extractAttachments: ({ attempt }) =>
          attempt === 0
            ? [{ mediaType: "image/png", dataUrl: "data:image/png;base64,AAA" } as any]
            : [],
      },
      browser: {
        launcherProviderId: "m365",
        connectorIdentity: "m365-copilot",
        executeTurn: async ({
          attempt,
          isNewConversation,
          existingConversationId,
          attachments,
        }) => {
          attemptInputs.push({
            attempt,
            isNewConversation,
            existingConversationId,
            attachmentCount: attachments.length,
          });
          if (attempt === 0) {
            return {
              rawResponse: "Phản hồi lỗi format ở attempt 0",
              conversationId: "conv-created-on-attempt-0",
            };
          }
          return {
            rawResponse:
              "````markdown\n<webResponse>\nThành công ở attempt 1\n</webResponse>\n````",
            conversationId: "conv-created-on-attempt-0",
          };
        },
      },
      response: {
        computeUsage: ctx => {
          usageContext = ctx;
          return { inputTokens: 10, outputTokens: 10, totalTokens: 20 };
        },
      },
    });

    await engine.runTurn(
      createParsedRequest(),
      { headers: new Headers() },
      () => {},
    );

    expect(attemptInputs).toEqual([
      {
        attempt: 0,
        isNewConversation: true,
        existingConversationId: undefined,
        attachmentCount: 1,
      },
      {
        attempt: 1,
        isNewConversation: false,
        existingConversationId: "conv-created-on-attempt-0",
        attachmentCount: 0,
      },
    ]);
    expect(usageContext?.totalPromptChars).toBeGreaterThan(
      usageContext?.initialPrompt.length,
    );
  });

  test("22. Loop Guard: tự động ngắt vòng lặp khi công cụ bị gọi lặp lại quá giới hạn hoặc vượt MAX_TOOL_ITERATIONS", async () => {
    const loopKey = "key-loop-guard-test";
    conversationGuard.delete(loopKey);

    const createLoopEngine = () =>
      new WebTurnEngine({
        id: "m365-copilot",
        assistantName: "M365",
        logPrefix: "m365-adapter",
        policies: {
          manageLauncherLeaseInEngine: false,
          enableToolLoopGuard: true,
        },
        conversation: {
          resolveConversationKey: () => loopKey,
        },
        browser: {
          launcherProviderId: "m365",
          connectorIdentity: "m365-copilot",
          executeTurn: async () => ({
            rawResponse: [
              "````markdown",
              "<webResponse>",
              "<tool_call>",
              '{"name":"exec_command","arguments":{"cmd":"echo loop"}}',
              "</tool_call>",
              "</webResponse>",
              "````",
            ].join("\n"),
          }),
        },
      });

    const req = createParsedRequest(
      [{ role: "user", content: "Chạy lệnh" }],
      [{ name: "exec_command", description: "Run cmd", parameters: {} }],
    );

    // Chạy đủ MAX_IDENTICAL_WRITE_TOOL_CALLS - 1 lần hợp lệ, lần thứ MAX_IDENTICAL_WRITE_TOOL_CALLS sẽ bị ngắt
    const engine = createLoopEngine();
    for (let i = 1; i < MAX_IDENTICAL_WRITE_TOOL_CALLS; i++) {
      await engine.runTurn(req, { headers: new Headers() }, () => {});
    }

    const limitTurnEvents: AdapterEvent[] = [];
    await engine.runTurn(req, { headers: new Headers() }, ev =>
      limitTurnEvents.push(ev),
    );

    expect(limitTurnEvents[0]?.type).toBe("text_delta");
    expect((limitTurnEvents[0] as any)?.text).toContain(
      "Phát hiện vòng lặp vô hạn",
    );
    expect(limitTurnEvents[1]).toEqual({
      type: "done",
      stopReason: "stop",
      endTurn: true,
      usage: undefined,
    });
    expect(conversationGuard.has(loopKey)).toBe(false);

    // Kiểm tra ngưỡng MAX_TOOL_ITERATIONS
    conversationGuard.set(loopKey, {
      toolIterations: MAX_TOOL_ITERATIONS,
      identicalToolCount: 0,
      lastToolFingerprint: "other_tool",
      updatedAt: Date.now(),
    });

    const maxIterEvents: AdapterEvent[] = [];
    await engine.runTurn(req, { headers: new Headers() }, ev =>
      maxIterEvents.push(ev),
    );

    expect(maxIterEvents[0]?.type).toBe("text_delta");
    expect((maxIterEvents[0] as any)?.text).toContain(
      "Max Tool Iterations Exceeded",
    );
    expect(conversationGuard.has(loopKey)).toBe(false);
  });

  test("23. Lifecycle: startLauncherBrowserTurn tự gửi phase=end giải phóng tab nếu connectBrowserHost thất bại hoặc bị hủy sau phase=start", async () => {
    for (const scenario of ["connect_error", "caller_aborted"] as const) {
      const recorded: Array<{ activity: any; signal: AbortSignal | undefined }> = [];
      const controller = new AbortController();

      const promise = startLauncherBrowserTurn({
        descriptorPath: "/tmp/mock-launcher-browser.json",
        signal: controller.signal,
        activity: {
          phase: "start",
          traceId: `trace-${scenario}`,
          helperPid: process.pid,
          provider: "m365",
          conversationKey: "conv-key-cdp-fail",
          connectorIdentity: "m365-copilot",
        },
        ops: {
          readDescriptor: () => ({
            version: 3,
            kind: "codex-web-gpt-launcher",
            profile: "development",
            pid: process.pid,
            endpoint: "http://127.0.0.1:9222",
            control: { endpoint: "http://127.0.0.1:9223", token: "tok" },
            helper: { executable: "bun", script: "helper.ts" },
            partition: "persist:test",
            idleUrl: "about:blank",
            surfaceId: "s".repeat(32),
            surfaceTargets: {},
            createdAt: new Date().toISOString(),
          }),
          isProcessRunning: () => true,
          notifyTurn: async (_descriptorPath, activity, _timeoutMs, signal) => {
            recorded.push({ activity, signal });
            if (activity.phase === "start") {
              return {
                surfaceId: "a".repeat(32),
                reused: false,
                connectorBound: false,
                conversationId: "m365-conv-42",
              };
            }
            return {};
          },
          connectBrowserHost: async () => {
            if (scenario === "caller_aborted") {
              controller.abort(new DOMException("Client disconnected", "AbortError"));
            }
            throw new Error(
              scenario === "caller_aborted"
                ? "Launcher browser acquisition cancelled"
                : "CDP WebSocket handshake failed",
            );
          },
        },
      });

      await expect(promise).rejects.toThrow(
        scenario === "caller_aborted"
          ? "Launcher browser acquisition cancelled"
          : "CDP WebSocket handshake failed",
      );

      expect(recorded).toHaveLength(2);
      expect(recorded[0]?.activity.phase).toBe("start");
      expect(recorded[1]?.activity).toEqual({
        phase: "end",
        traceId: `trace-${scenario}`,
        helperPid: process.pid,
        provider: "m365",
        status: scenario === "caller_aborted" ? "aborted" : "failed",
        retain: false,
        connectorBound: false,
        conversationId: "m365-conv-42",
      });
      // Đảm bảo signal đã bị hủy của caller không làm AbortError khi gửi phase=end
      expect(recorded[1]?.signal).toBeUndefined();
    }
  });
});
