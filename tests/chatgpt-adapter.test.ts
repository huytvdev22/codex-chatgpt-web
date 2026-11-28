import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { WebRuntimeLifecycleOps } from "../src/adapters/web";
import {
  LimitStore,
  ProfileCooldownStore,
  ProfileFailoverCoordinator,
  ProfileFailoverSettingsStore,
  ThreadProfileBindingStore,
} from "../src/limits";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

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

  test("extractAttachments phân biệt pre-submit/transport/failover với post-submit format retry", () => {
    const adapter = createChatGptAdapter() as ChatGptAdapter;
    const def = getDefinition(adapter);
    const dataUrl = `data:image/png;base64,${Buffer.from(
      "real-first-turn-image-payload-for-chatgpt-retry-test",
    ).toString("base64")}`;
    const sampleImage = {
      ref: "web-img-1",
      name: "image-1.png",
      mimeType: "image/png",
      dataUrl,
      buffer: Buffer.from("real-first-turn-image-payload-for-chatgpt-retry-test"),
    };
    const parsed = makeParsedRequest({
      _rawBody: {
        model: "chatgpt/gpt-6.2",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Phân tích ảnh này" },
              { type: "input_image", image_url: dataUrl },
            ],
          },
        ],
      },
    });
    const normalized = { images: [sampleImage] } as never;

    expect(
      def.attachments?.extractAttachments?.({
        parsed,
        attempt: 0,
        normalized,
        isNewConversation: true,
        retryKind: "initial",
        originalMessageSubmitted: false,
      }),
    ).toHaveLength(1);

    // Pre-submit failure & transport retry (chưa submit tin nhắn gốc): bảo toàn ảnh gốc dù attempt > 0
    expect(
      def.attachments?.extractAttachments?.({
        parsed,
        attempt: 1,
        normalized,
        isNewConversation: false,
        retryKind: "pre_submit",
        originalMessageSubmitted: false,
      }),
    ).toHaveLength(1);
    expect(
      def.attachments?.extractAttachments?.({
        parsed,
        attempt: 1,
        normalized,
        isNewConversation: false,
        retryKind: "transport",
        originalMessageSubmitted: false,
      }),
    ).toHaveLength(1);

    // New conversation / profile failover: luôn bảo toàn ảnh gốc
    expect(
      def.attachments?.extractAttachments?.({
        parsed,
        attempt: 1,
        normalized,
        isNewConversation: true,
        retryKind: "failover",
        originalMessageSubmitted: false,
      }),
    ).toHaveLength(1);
    expect(
      def.attachments?.extractAttachments?.({
        parsed,
        attempt: 1,
        normalized,
        isNewConversation: true,
      }),
    ).toHaveLength(1);

    // Đã submit thành công trên cùng conversation: không upload trùng khi transport/format/tool retry
    expect(
      def.attachments?.extractAttachments?.({
        parsed,
        attempt: 1,
        normalized,
        isNewConversation: false,
        retryKind: "transport",
        originalMessageSubmitted: true,
      }),
    ).toEqual([]);
    expect(
      def.attachments?.extractAttachments?.({
        parsed,
        attempt: 1,
        normalized,
        isNewConversation: false,
        isPostSubmitRetry: true,
        originalMessageSubmitted: true,
        retryKind: "format",
      }),
    ).toEqual([]);
    expect(
      def.attachments?.extractAttachments?.({
        parsed,
        attempt: 1,
        normalized,
        isNewConversation: false,
        isPostSubmitRetry: true,
        originalMessageSubmitted: true,
        retryKind: "tool_describe",
      }),
    ).toEqual([]);
  });

  test("WebTurnEngine + ChatGptAdapter giữ ảnh ở Turn 1 khi failover profile và không upload trùng khi format retry cùng conversation", async () => {
    const dataUrl = `data:image/png;base64,${Buffer.from(
      "first-turn-screenshot-payload-for-engine-retry-matrix",
    ).toString("base64")}`;
    const createImageParsed = () =>
      makeParsedRequest({
        context: {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Kiểm tra ảnh" }],
              timestamp: 1_700_000_000_000,
            },
          ],
          tools: [],
        },
        _rawBody: {
          model: "chatgpt/gpt-6.2",
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "Kiểm tra ảnh" },
                { type: "input_image", image_url: dataUrl },
              ],
            },
          ],
        },
      });

    // 1. Post-submit format retry trên cùng conversation: attempt 0 có ảnh, attempt 1 không re-upload
    const formatRetryAdapter = createChatGptAdapter() as ChatGptAdapter;
    const formatRetryDef = getDefinition(formatRetryAdapter);
    const formatCalls: Array<{
      attempt: number;
      isNewConversation: boolean;
      existingConversationId?: string;
      imagesCount: number;
    }> = [];
    const formatWorker = (
      formatRetryAdapter as unknown as {
        worker: {
          executeTurn: (page: unknown, opts: Record<string, unknown>) => Promise<unknown>;
        };
      }
    ).worker;
    let formatAttempt = 0;
    formatWorker.executeTurn = async (_page, opts) => {
      formatCalls.push({
        attempt: formatAttempt,
        isNewConversation: Boolean(opts.isNewConversation),
        existingConversationId: opts.existingConversationId as string | undefined,
        imagesCount: Array.isArray(opts.images) ? opts.images.length : 0,
      });
      formatAttempt += 1;
      if (formatAttempt === 1) {
        return {
          rawResponse: "Trả lời thiếu thẻ webResponse",
          conversationId: "6afae1f3-e4f0-83ec-8aca-7c8649cfde1c",
        };
      }
      return {
        rawResponse: "````markdown\n<webResponse>\nĐã thấy ảnh\n</webResponse>\n````",
        conversationId: "6afae1f3-e4f0-83ec-8aca-7c8649cfde1c",
      };
    };

    const noopOps: Partial<WebRuntimeLifecycleOps> = {
      resolveDescriptorPath: () => "/tmp/chatgpt-test-descriptor.json",
      startTurn: async () => ({
        surfaceId: "surface-chatgpt",
        conversationId: undefined,
        reused: false,
        connectorBound: false,
        connection: {
          descriptor: {} as never,
          context: {} as never,
          page: { url: () => CHATGPT_HOME_URL } as never,
          browser: { close: async () => {} } as never,
        },
      }),
      heartbeatTurn: async () => {},
      endTurn: async () => {},
      closeTurn: async () => {},
    };

    const formatEvents: AdapterEvent[] = [];
    const formatEngine = new WebTurnEngine(formatRetryDef, undefined, noopOps);
    await formatEngine.runTurn(
      createImageParsed(),
      { headers: new Headers() },
      (ev) => formatEvents.push(ev),
    );
    expect(formatCalls).toEqual([
      {
        attempt: 0,
        isNewConversation: true,
        existingConversationId: undefined,
        imagesCount: 1,
      },
      {
        attempt: 1,
        isNewConversation: false,
        existingConversationId: "6afae1f3-e4f0-83ec-8aca-7c8649cfde1c",
        imagesCount: 0,
      },
    ]);
    expect(
      formatEvents.some(
        (ev) => ev.type === "text_delta" && ev.text.includes("Đã thấy ảnh"),
      ),
    ).toBe(true);

    // 2. Profile failover (runTurn + runRawTurn + runManagedTurn): sang profile mới phải giữ nguyên ảnh & isNewConversation=true
    const tmpDir = mkdtempSync(join(tmpdir(), "codex-chatgpt-attach-failover-"));
    try {
      const settingsStore = new ProfileFailoverSettingsStore(
        join(tmpDir, "settings.json"),
      );
      settingsStore.save({ autoSwitchProfileOnQuotaLimit: true });
      const coordinator = new ProfileFailoverCoordinator(
        settingsStore,
        new ProfileCooldownStore(join(tmpDir, "cooldowns.json")),
        new ThreadProfileBindingStore({
          filePath: join(tmpDir, "bindings.json"),
          debounceMs: 0,
        }),
        new LimitStore(join(tmpDir, "limits.json")),
        () => ({
          activeProfileId: "default",
          profiles: [
            { id: "default", name: "Default", authenticated: true },
            { id: "p2", name: "Backup", authenticated: true },
          ],
        }),
      );

      const failoverAdapter = createChatGptAdapter() as ChatGptAdapter;
      const failoverDef = getDefinition(failoverAdapter);
      const failoverCalls: Array<{
        profileId?: string;
        isNewConversation: boolean;
        existingConversationId?: string;
        imagesCount: number;
      }> = [];
      let activeProfile = "default";
      const failoverWorker = (
        failoverAdapter as unknown as {
          worker: {
            executeTurn: (page: unknown, opts: Record<string, unknown>) => Promise<unknown>;
          };
        }
      ).worker;
      failoverWorker.executeTurn = async (_page, opts) => {
        failoverCalls.push({
          profileId: activeProfile,
          isNewConversation: Boolean(opts.isNewConversation),
          existingConversationId: opts.existingConversationId as string | undefined,
          imagesCount: Array.isArray(opts.images) ? opts.images.length : 0,
        });
        if (activeProfile === "default") {
          throw new Error(
            "[ChatGPT Web Error] You've reached your usage limit / quota exceeded",
          );
        }
        return {
          rawResponse:
            "````markdown\n<webResponse>\nFailover vẫn thấy ảnh\n</webResponse>\n````",
          conversationId: "7bfae1f3-e4f0-83ec-8aca-7c8649cfde1d",
        };
      };

      const failoverOps: Partial<WebRuntimeLifecycleOps> = {
        resolveDescriptorPath: () => "/tmp/chatgpt-failover-descriptor.json",
        startTurn: async ({ activity }) => {
          activeProfile = activity.profileId || "default";
          return {
            surfaceId: `surface-${activeProfile}`,
            conversationId: undefined,
            reused: false,
            connectorBound: false,
            connection: {
              descriptor: {} as never,
              context: {} as never,
              page: { url: () => CHATGPT_HOME_URL } as never,
              browser: { close: async () => {} } as never,
            },
          };
        },
        heartbeatTurn: async () => {},
        endTurn: async () => {},
        closeTurn: async () => {},
      };

      const failoverEngine = new WebTurnEngine(
        failoverDef,
        undefined,
        failoverOps,
        undefined,
        undefined,
        coordinator,
      );
      await failoverEngine.runTurn(
        createImageParsed(),
        { headers: new Headers() },
        () => {},
      );
      expect(failoverCalls).toEqual([
        {
          profileId: "default",
          isNewConversation: true,
          existingConversationId: undefined,
          imagesCount: 1,
        },
        {
          profileId: "p2",
          isNewConversation: true,
          existingConversationId: undefined,
          imagesCount: 1,
        },
      ]);

      // runManagedTurn failover (attempt >= 1) cũng không được ép isNewConversation về false
      const managedSpyCalls: Array<{
        isNewConversation: boolean;
        imagesCount: number;
      }> = [];
      failoverWorker.executeTurn = async (_page, opts) => {
        managedSpyCalls.push({
          isNewConversation: Boolean(opts.isNewConversation),
          imagesCount: Array.isArray(opts.images) ? opts.images.length : 0,
        });
        return {
          rawResponse: "Managed failover OK",
          conversationId: "8bfae1f3-e4f0-83ec-8aca-7c8649cfde1e",
        };
      };
      await failoverEngine.runManagedTurn(
        {
          modelId: "chatgpt/gpt-6.2",
          prompt: "Xem ảnh",
          conversationKey: "conv-managed-failover",
          isNewConversation: true,
          attempt: 1,
          images: [
            {
              name: "shot.png",
              mimeType: "image/png",
              dataUrl,
              buffer: Buffer.from("first-turn-screenshot-payload-for-engine-retry-matrix"),
            },
          ],
        },
        { headers: new Headers() },
      );
      expect(managedSpyCalls).toEqual([
        { isNewConversation: true, imagesCount: 1 },
      ]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
