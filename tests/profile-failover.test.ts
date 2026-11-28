import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { ManagedTurnRequest, ProviderAdapter } from "../src/adapters/base";
import {
  WebTurnEngine,
  type WebProviderDefinition,
  type WebRuntimeLifecycleOps,
} from "../src/adapters/web";
import { AssistantResponsesService } from "../src/assistant";
import { ThreadProviderBindingStore } from "../src/services/thread-provider-binding-store";
import {
  formatResetRemainingText,
  LimitStore,
  parseQuotaResetDelayMs,
  ProfileCooldownStore,
  ProfileFailoverCoordinator,
  ProfileFailoverSettingsStore,
  ThreadProfileBindingStore,
} from "../src/limits";
import type { LauncherBrowserHostDescriptor } from "../src/launcher-browser-host";
import { LimitManagementService } from "../src/services/limit-management-service";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

const require = createRequire(import.meta.url);
const { buildOfflineLimitsSnapshot } = require("../launcher/electron/infra/limits-store.cjs") as {
  buildOfflineLimitsSnapshot: (
    filePath: string,
    providersList: Array<Record<string, unknown>>,
  ) => {
    entries: Array<{
      providerId: string;
      profileId: string;
      status: string;
      buckets: Array<{ id: string; label: string; resetAt?: string | null }>;
    }>;
  };
};

function createParsedRequest(
  messages: Array<{ role: string; content: string }>,
  threadId?: string,
): CodexParsedRequest {
  return {
    modelId: "ai-studio/gemini-4-hydrogen",
    stream: true,
    options: { reasoning: "high" } as never,
    context: {
      systemPrompt: ["System prompt"],
      messages: messages.map((m) => ({ ...m, timestamp: Date.now() })) as never,
      tools: [],
    },
    _rawBody: {
      model: "ai-studio/gemini-4-hydrogen",
      input: messages,
      ...(threadId
        ? { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId }) } }
        : {}),
    },
  };
}

describe("Profile Failover & Passive Quota Cooldown", () => {
  test("parseQuotaResetDelayMs & formatResetRemainingText parse chính xác thời gian reset từ lỗi AI Studio", () => {
    const msg =
      "[AI Studio] [AI Studio Web Error] error Failed to generate content, Quota exceeded: you have reached the daily limit of requests for this model (resets in 15 hours, 24 minutes). Please select a different model, or try again tomorrow. close";
    const delayMs = parseQuotaResetDelayMs(msg);
    expect(delayMs).toBe((15 * 60 + 24) * 60_000);
    expect(formatResetRemainingText(1_000_000 + delayMs, 1_000_000)).toBe("15h 24m");

    expect(parseQuotaResetDelayMs("resets in 45 minutes")).toBe(45 * 60_000);
    expect(parseQuotaResetDelayMs("Quota exceeded", 123_456)).toBe(123_456);
  });

  test("ProfileCooldownStore tách riêng theo (providerId, profileId, modelSlug) và tự hết hạn", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-cooldown-"));
    try {
      const store = new ProfileCooldownStore(join(dir, "profile-cooldowns.json"));
      const now = 1_700_000_000_000;

      store.markExhausted({
        providerId: "ai-studio",
        profileId: "default",
        modelSlug: "gemini-4-hydrogen",
        message: "Quota exceeded (resets in 2 hours)",
        nowMs: now,
      });

      expect(
        store.isCoolingDown("ai-studio", "default", "gemini-4-hydrogen", now + 60_000),
      ).toBe(true);
      // Model khác trên cùng profile không bị khóa
      expect(
        store.isCoolingDown("ai-studio", "default", "gemini-2.5-pro", now + 60_000),
      ).toBe(false);
      // Profile khác trên cùng model không bị khóa
      expect(
        store.isCoolingDown("ai-studio", "p2", "gemini-4-hydrogen", now + 60_000),
      ).toBe(false);
      // Hết cooldown
      expect(
        store.isCoolingDown(
          "ai-studio",
          "default",
          "gemini-4-hydrogen",
          now + 2 * 60 * 60_000 + 1,
        ),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ProfileFailoverSettingsStore mặc định false và hot-reload khi lưu", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-failover-settings-"));
    try {
      const store = new ProfileFailoverSettingsStore(
        join(dir, "profile-failover-settings.json"),
      );
      expect(store.isAutoSwitchEnabled()).toBe(false);
      store.save({ autoSwitchProfileOnQuotaLimit: true });
      store.clearCache();
      expect(store.isAutoSwitchEnabled()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("LimitManagementService & buildOfflineLimitsSnapshot hiển thị passive exhausted cho AI Studio và tự dọn khi hết hạn", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-passive-limit-"));
    try {
      const limitsFile = join(dir, "provider-limits.json");
      const cooldownStore = new ProfileCooldownStore(join(dir, "profile-cooldowns.json"));
      const limitStore = new LimitStore(limitsFile);
      const settingsStore = new ProfileFailoverSettingsStore(
        join(dir, "profile-failover-settings.json"),
      );
      const threadProfileStore = new ThreadProfileBindingStore({
        filePath: join(dir, "thread-profile-bindings.json"),
        debounceMs: 0,
      });

      const coordinator = new ProfileFailoverCoordinator(
        settingsStore,
        cooldownStore,
        threadProfileStore,
        limitStore,
        () => ({
          activeProfileId: "default",
          profiles: [
            { id: "default", name: "Default", authenticated: true },
            { id: "p2", name: "Account 2", authenticated: true },
          ],
        }),
      );

      coordinator.handleQuotaFailure({
        providerId: "ai-studio",
        modelId: "ai-studio/gemini-4-hydrogen",
        profileId: "default",
        errorMessage: "Quota exceeded (resets in 1 hour)",
        pinnedByCaller: false,
        attemptedProfileIds: new Set(["default"]),
        hasEmittedOutput: false,
      });

      const descriptor: LauncherBrowserHostDescriptor = {
        version: 3,
        kind: "codex-web-gpt-launcher",
        profile: "production",
        pid: process.pid,
        endpoint: "http://127.0.0.1:17841",
        control: { endpoint: "http://127.0.0.1:17842", token: "tok" },
        helper: { executable: "electron", script: "helper.cjs" },
        partition: "persist:codex-web-aistudio",
        idleUrl: "about:blank",
        surfaceId: "s1",
        provider: "ai-studio",
        providerProfiles: {
          "ai-studio": {
            activeProfileId: "default",
            profiles: [
              { id: "default", name: "Default", authenticated: true },
              { id: "p2", name: "Account 2", authenticated: true },
            ],
          },
        },
        surfaceTargets: {},
        createdAt: new Date().toISOString(),
      };

      const limitService = new LimitManagementService(
        limitStore,
        undefined,
        undefined,
        () => descriptor,
        cooldownStore,
      );

      const snapshot = limitService.getSnapshot();
      const defaultEntry = snapshot.entries.find(
        (e) => e.providerId === "ai-studio" && e.profileId === "default",
      );
      const p2Entry = snapshot.entries.find(
        (e) => e.providerId === "ai-studio" && e.profileId === "p2",
      );
      expect(defaultEntry?.status).toBe("exhausted");
      expect(defaultEntry?.buckets[0]?.label).toBe("gemini-4-hydrogen");
      expect(p2Entry?.status).toBe("unsupported");

      const offlineSnap = buildOfflineLimitsSnapshot(limitsFile, [
        {
          id: "ai-studio",
          activeProfileId: "default",
          profiles: [
            { id: "default", name: "Default", authenticated: true },
            { id: "p2", name: "Account 2", authenticated: true },
          ],
        },
      ]);
      const offlineDefault = offlineSnap.entries.find(
        (e) => e.providerId === "ai-studio" && e.profileId === "default",
      );
      expect(offlineDefault?.status).toBe("exhausted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("WebTurnEngine tự động failover từ default sang p2 khi Auto-switch ON, mở chat mới kèm full history và sticky threadId -> p2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-engine-failover-"));
    try {
      const settingsStore = new ProfileFailoverSettingsStore(
        join(dir, "profile-failover-settings.json"),
      );
      settingsStore.save({ autoSwitchProfileOnQuotaLimit: true });
      const cooldownStore = new ProfileCooldownStore(
        join(dir, "profile-cooldowns.json"),
      );
      const threadProfileStore = new ThreadProfileBindingStore({
        filePath: join(dir, "thread-profile-bindings.json"),
        debounceMs: 0,
      });
      const limitStore = new LimitStore(join(dir, "provider-limits.json"));

      const coordinator = new ProfileFailoverCoordinator(
        settingsStore,
        cooldownStore,
        threadProfileStore,
        limitStore,
        () => ({
          activeProfileId: "default",
          profiles: [
            { id: "default", name: "Default", authenticated: true },
            { id: "p2", name: "Account 2", authenticated: true },
            { id: "p3", name: "Signed Out", authenticated: false },
          ],
        }),
      );

      const startCalls: Array<{ profileId?: string }> = [];
      const endCalls: Array<{ status: string; retain: boolean }> = [];
      const executeCalls: Array<{
        isNewConversation?: boolean;
        existingConversationId?: string;
        promptHasPriorHistory: boolean;
      }> = [];

      let currentAttemptProfile = "default";
      const definition: WebProviderDefinition = {
        id: "ai-studio",
        assistantName: "Gemini",
        logPrefix: "ai-studio-adapter",
        abortMessage: "AI Studio aborted",
        policies: {
          emitErrorEventOnFailure: true,
          errorMessagePrefix: "[AI Studio]",
          rethrowError: false,
        },
        conversation: {
          resolveConversationKey: () => "conv-failover-1",
          resolveState: ({ leaseConversationId, launcherReused }) => ({
            existingConversationId: leaseConversationId,
            isNewConversation: !launcherReused && !leaseConversationId,
          }),
        },
        browser: {
          launcherProviderId: "ai-studio",
          connectorIdentity: "ai-studio",
          executeTurn: async ({
            prompt,
            existingConversationId,
            isNewConversation,
          }) => {
            executeCalls.push({
              existingConversationId,
              isNewConversation,
              promptHasPriorHistory: prompt.includes("Lich su cu truoc do"),
            });
            if (currentAttemptProfile === "default") {
              throw new Error(
                "[AI Studio Web Error] error Failed to generate content, Quota exceeded: you have reached the daily limit of requests for this model (resets in 15 hours, 24 minutes). close",
              );
            }
            return {
              rawResponse: "````markdown\n<webResponse><final_answer>OK_FROM_P2</final_answer></webResponse>\n````",
              conversationId: "prompt-id-on-p2",
            };
          },
        },
      };

      const ops: Partial<WebRuntimeLifecycleOps> = {
        resolveDescriptorPath: () => "/tmp/fake-descriptor.json",
        startTurn: async ({ activity }) => {
          currentAttemptProfile = activity.profileId || "default";
          startCalls.push({ profileId: activity.profileId });
          const isTurnOnDefault = currentAttemptProfile === "default";
          return {
            surfaceId: `surface-${currentAttemptProfile}`,
            conversationId: isTurnOnDefault ? "prompt-id-on-default" : undefined,
            connectorBound: isTurnOnDefault,
            reused: isTurnOnDefault,
            connection: {
              descriptor: {} as never,
              context: {} as never,
              page: {} as never,
              browser: { close: async () => {} } as never,
            },
          };
        },
        heartbeatTurn: async () => {},
        endTurn: async ({ activity }) => {
          endCalls.push({
            status: activity.status,
            retain: activity.retain ?? false,
          });
        },
        closeTurn: async () => {},
      };

      const engine = new WebTurnEngine(
        definition,
        undefined,
        ops,
        undefined,
        undefined,
        coordinator,
      );

      const events: AdapterEvent[] = [];
      await engine.runTurn(
        createParsedRequest(
          [
            { role: "user", content: "Lich su cu truoc do" },
            { role: "assistant", content: "Da hieu" },
            { role: "user", content: "Cau hoi moi" },
          ],
          "thread-sticky-1",
        ),
        { headers: new Headers() },
        (ev) => events.push(ev),
      );

      // Turn 1 thử default (fail quota) -> release retain=false -> failover sang p2 (success)
      expect(startCalls.map((c) => c.profileId)).toEqual(["default", "p2"]);
      expect(endCalls).toEqual([
        { status: "failed", retain: false },
        { status: "completed", retain: true },
      ]);
      expect(executeCalls).toEqual([
        {
          existingConversationId: "prompt-id-on-default",
          isNewConversation: false,
          promptHasPriorHistory: false,
        },
        {
          existingConversationId: undefined,
          isNewConversation: true,
          promptHasPriorHistory: true,
        },
      ]);
      expect(
        events.some(
          (e) => e.type === "text_delta" && e.text.includes("OK_FROM_P2"),
        ),
      ).toBe(true);
      expect(events.some((e) => e.type === "error")).toBe(false);

      // Turn kế tiếp cùng threadId phải đi thẳng vào p2
      startCalls.length = 0;
      await engine.runTurn(
        createParsedRequest([{ role: "user", content: "Tiep tuc" }], "thread-sticky-1"),
        { headers: new Headers() },
        () => {},
      );
      expect(startCalls.map((c) => c.profileId)).toEqual(["p2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("WebTurnEngine dừng ngay sau khi thử hết mọi profile đã đăng nhập (không lặp vô hạn)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-engine-exhaust-all-"));
    try {
      const settingsStore = new ProfileFailoverSettingsStore(
        join(dir, "profile-failover-settings.json"),
      );
      settingsStore.save({ autoSwitchProfileOnQuotaLimit: true });
      const coordinator = new ProfileFailoverCoordinator(
        settingsStore,
        new ProfileCooldownStore(join(dir, "profile-cooldowns.json")),
        new ThreadProfileBindingStore({
          filePath: join(dir, "thread-profile-bindings.json"),
          debounceMs: 0,
        }),
        new LimitStore(join(dir, "provider-limits.json")),
        () => ({
          activeProfileId: "default",
          profiles: [
            { id: "default", name: "Default", authenticated: true },
            { id: "p2", name: "Account 2", authenticated: true },
          ],
        }),
      );

      let executeCount = 0;
      const startProfiles: Array<string | undefined> = [];
      const definition: WebProviderDefinition = {
        id: "ai-studio",
        assistantName: "Gemini",
        logPrefix: "ai-studio-adapter",
        abortMessage: "AI Studio aborted",
        policies: {
          emitErrorEventOnFailure: true,
          errorMessagePrefix: "[AI Studio]",
          rethrowError: false,
        },
        conversation: {
          resolveConversationKey: () => "conv-exhaust-all",
        },
        browser: {
          launcherProviderId: "ai-studio",
          connectorIdentity: "ai-studio",
          executeTurn: async () => {
            executeCount += 1;
            throw new Error(
              "[AI Studio Web Error] error Failed to generate content, Quota exceeded: you have reached the daily limit of requests for this model (resets in 10 hours). close",
            );
          },
        },
      };

      const ops: Partial<WebRuntimeLifecycleOps> = {
        resolveDescriptorPath: () => "/tmp/fake-descriptor.json",
        startTurn: async ({ activity }) => {
          startProfiles.push(activity.profileId);
          return {
            surfaceId: `s-${activity.profileId}`,
            conversationId: undefined,
            connectorBound: false,
            reused: false,
            connection: {
              descriptor: {} as never,
              context: {} as never,
              page: {} as never,
              browser: { close: async () => {} } as never,
            },
          };
        },
        heartbeatTurn: async () => {},
        endTurn: async () => {},
        closeTurn: async () => {},
      };

      const engine = new WebTurnEngine(
        definition,
        undefined,
        ops,
        undefined,
        undefined,
        coordinator,
      );
      const events: AdapterEvent[] = [];
      await engine.runTurn(
        createParsedRequest([{ role: "user", content: "xin chao" }], "thread-all-fail"),
        { headers: new Headers() },
        (ev) => events.push(ev),
      );

      expect(executeCount).toBe(2);
      expect(startProfiles).toEqual(["default", "p2"]);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("error");
      if (events[0]?.type === "error") {
        expect(events[0].retryable).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AssistantResponsesService (Telegram) tự failover từ p2 sang p3 giữa chừng khi đang có conversationId cũ và biên dịch lại full context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-assistant-failover-"));
    try {
      const settingsStore = new ProfileFailoverSettingsStore(
        join(dir, "profile-failover-settings.json"),
      );
      settingsStore.save({ autoSwitchProfileOnQuotaLimit: true });
      const coordinator = new ProfileFailoverCoordinator(
        settingsStore,
        new ProfileCooldownStore(join(dir, "profile-cooldowns.json")),
        new ThreadProfileBindingStore({
          filePath: join(dir, "thread-profile-bindings.json"),
          debounceMs: 0,
        }),
        new LimitStore(join(dir, "provider-limits.json")),
        () => ({
          activeProfileId: "p2",
          profiles: [
            { id: "default", name: "Default", authenticated: true },
            { id: "p2", name: "huytv8895", authenticated: true },
            { id: "p3", name: "Account 3", authenticated: true },
          ],
        }),
      );

      const service = new AssistantResponsesService(
        undefined,
        undefined,
        new ThreadProviderBindingStore({
          filePath: join(dir, "assistant-thread-bindings.json"),
          debounceMs: 0,
        }),
        undefined,
        undefined,
        coordinator,
      );

      let failP2Now = false;
      const calls: Array<{
        profileId?: string;
        existingConversationId?: string;
        isNewConversation?: boolean;
        hasPriorHistory: boolean;
      }> = [];

      const fakeAdapter: ProviderAdapter = {
        name: "ai-studio",
        async runTurn() {},
        async runManagedTurn(req: ManagedTurnRequest) {
          calls.push({
            profileId: req.profileId,
            existingConversationId: req.existingConversationId,
            isNewConversation: req.isNewConversation,
            hasPriorHistory: req.prompt.includes("Lich su Telegram cu"),
          });
          if (req.profileId === "p2" && failP2Now) {
            throw new Error(
              "[AI Studio] [AI Studio Web Error] error Failed to generate content, Quota exceeded: you have reached the daily limit of requests for this model (resets in 6 hours, 55 minutes). close",
            );
          }
          return {
            rawResponse: req.profileId === "p3" ? "OK_FROM_P3_TG" : "OK_TURN_1_P2",
            conversationId: req.profileId === "p3" ? "prompt-p3-new" : "prompt-p2-old",
            launcherReused: false,
          };
        },
      };

      const sendTgTurn = async (
        input: Array<{ role: string; content: Array<{ type: string; text: string }> }>,
      ) => {
        const res = await service.executeTurn({
          req: new Request("http://127.0.0.1/clients/assistant/v1/responses", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-codex-turn-metadata": JSON.stringify({
                thread_id: "tg-gemini-web-thread",
                turn_id: `turn-${Date.now()}`,
              }),
            },
            body: JSON.stringify({
              model: "ai-studio/gemini-4-neon",
              stream: true,
              input,
            }),
          }),
          raw: {
            model: "ai-studio/gemini-4-neon",
            stream: true,
            input,
            client_metadata: {
              "x-codex-turn-metadata": JSON.stringify({
                thread_id: "tg-gemini-web-thread",
                turn_id: "turn-tg",
              }),
            },
          },
          requestedModel: "ai-studio/gemini-4-neon",
          providerId: "ai-studio",
          options: { rememberState: false },
          adapterFactory: () => fakeAdapter,
        });
        return await res.text();
      };

      // Turn 1 trên p2 thành công & lưu conversationId = "prompt-p2-old"
      const sse1 = await sendTgTurn([
        { role: "user", content: [{ type: "input_text", text: "Lich su Telegram cu" }] },
      ]);
      expect(sse1).toContain("OK_TURN_1_P2");
      expect(calls[0]?.profileId).toBe("p2");
      expect(calls[0]?.isNewConversation).toBe(true);

      // Turn 2: p2 dính Quota exceeded khi đang có existingConversationId="prompt-p2-old"
      // -> phải tự nhảy sang p3, xóa existingConversationId, ép isNewConversation=true & giữ lại lịch sử cũ
      failP2Now = true;
      calls.length = 0;
      const sse2 = await sendTgTurn([
        { role: "user", content: [{ type: "input_text", text: "Lich su Telegram cu" }] },
        { role: "assistant", content: [{ type: "output_text", text: "OK_TURN_1_P2" }] },
        { role: "user", content: [{ type: "input_text", text: "co" }] },
      ]);
      expect(sse2).toContain("OK_FROM_P3_TG");
      expect(sse2).not.toContain("response.failed");
      expect(calls).toEqual([
        {
          profileId: "p2",
          existingConversationId: "prompt-p2-old",
          isNewConversation: false,
          hasPriorHistory: false,
        },
        {
          profileId: "p3",
          existingConversationId: undefined,
          isNewConversation: true,
          hasPriorHistory: true,
        },
      ]);

      // Turn 3 tiếp theo cùng thread Telegram bám thẳng trên p3 và dùng prompt-p3-new
      calls.length = 0;
      const sse3 = await sendTgTurn([
        { role: "user", content: [{ type: "input_text", text: "Lich su Telegram cu" }] },
        { role: "assistant", content: [{ type: "output_text", text: "OK_TURN_1_P2" }] },
        { role: "user", content: [{ type: "input_text", text: "co" }] },
        { role: "assistant", content: [{ type: "output_text", text: "OK_FROM_P3_TG" }] },
        { role: "user", content: [{ type: "input_text", text: "lam tiep" }] },
      ]);
      expect(sse3).toContain("OK_FROM_P3_TG");
      expect(calls).toEqual([
        {
          profileId: "p3",
          existingConversationId: "prompt-p3-new",
          isNewConversation: false,
          hasPriorHistory: false,
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
