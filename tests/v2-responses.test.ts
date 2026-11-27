import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import type { ProviderAdapter } from "../src/adapters/base";
import {
  buildM365ConversationUrl,
  M365BrowserWorker,
  normalizeM365ConversationId,
} from "../src/adapters/m365-copilot";
import type { WebBrowserTurnExecutionInput, WebProviderDefinition } from "../src/adapters/web/definition";
import { WebTurnEngine } from "../src/adapters/web/engine";
import { defaultConfig } from "../src/config";
import { ModelRegistry } from "../src/models/model-registry";
import { AdapterRegistry } from "../src/adapters/adapter-registry";
import { startServer } from "../src/server";
import { RawResponsesService } from "../src/services/raw-responses-service";
import { V2ConversationStore } from "../src/services/v2-conversation-store";

const tempDirs: string[] = [];
const originalHome = process.env.CODEX_CHATGPT_WEB_HOME;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.CODEX_CHATGPT_WEB_HOME;
  } else {
    process.env.CODEX_CHATGPT_WEB_HOME = originalHome;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRawEngineAdapter(params: {
  providerId?: string;
  onExecute: (input: WebBrowserTurnExecutionInput) => Promise<{ rawResponse: string; conversationId?: string }>;
  resolveSurface?: (conversationKey?: string) => {
    launcherReused: boolean;
    leaseConversationId?: string;
  };
}): ProviderAdapter {
  const providerId = params.providerId ?? "m365-copilot";
  const definition: WebProviderDefinition = {
    id: providerId,
    assistantName: "M365",
    logPrefix: "v2-test",
    policies: {
      manageLauncherLeaseInEngine: true,
      launcherFailureMode: "fail-closed",
    },
    conversation: {
      resolveConversationKey: () => "unused-in-v2",
      onConversationUpdated: ({ conversationId }) => conversationId,
      resolveEndTurnBinding: ({ finalStatus, activeConversationId }) => ({
        connectorBound: finalStatus === "completed" && Boolean(activeConversationId),
        conversationId: activeConversationId,
        retain: true,
      }),
    },
    browser: {
      launcherProviderId: "m365",
      connectorIdentity: providerId,
      executeTurn: params.onExecute,
    },
  };

  const activeEngine = new WebTurnEngine(definition, undefined, {
    resolveDescriptorPath: () => "/tmp/mock-descriptor.json",
    startTurn: async ({ activity }) => {
      const state = params.resolveSurface?.(activity.conversationKey) ?? {
        launcherReused: false,
        leaseConversationId: undefined,
      };
      return {
        connection: { page: {} as Page, browser: { close: async () => {} } } as any,
        surfaceId: "surface-1",
        conversationId: state.leaseConversationId,
        reused: state.launcherReused,
        connectorBound: Boolean(state.leaseConversationId),
      };
    },
    endTurn: async () => {},
    heartbeatTurn: async () => {},
  });

  return {
    name: providerId,
    runTurn: async () => {
      throw new Error("v1 runTurn should not be called in /v2/responses tests");
    },
    runRawTurn: (request, incoming) => activeEngine.runRawTurn(request, incoming),
  };
}

describe("POST /v2/responses (Raw Passthrough & Target Conversation)", () => {
  test("Turn 1 tự sinh conversation_key, forward prompt nguyên văn và Turn 2 tự khôi phục conversation_id từ disk sau restart", async () => {
    const dir = makeTempDir("v2-conv-store-");
    const storePath = join(dir, "v2-conversations.json");
    const recordedInputs: WebBrowserTurnExecutionInput[] = [];
    const targetConvId = "123e4567-e89b-12d3-a456-426614174000";

    const makeService = () => new RawResponsesService(
      ModelRegistry.getInstance(),
      AdapterRegistry.getInstance(),
      new V2ConversationStore(storePath),
    );

    const adapterFactory = () => createRawEngineAdapter({
      onExecute: async (input) => {
        recordedInputs.push(input);
        return {
          rawResponse: input.existingConversationId
            ? "Tiếp tục đúng cuộc hội thoại cũ!"
            : "Chào Huy!",
          conversationId: targetConvId,
        };
      },
    });

    // Turn 1: bỏ trống conversation_key & conversation_id
    const turn1Res = await makeService().executeRawTurn({
      req: new Request("http://127.0.0.1/v2/responses", { method: "POST" }),
      raw: {
        model: "m365-copilot/gpt-5.6",
        prompt: "  Xin chào, giữ nguyên khoảng trắng và KHÔNG thêm <webResponse>!  ",
        reasoning: "high",
      },
      adapterFactory,
    });

    expect(turn1Res.status).toBe(200);
    const turn1Json = await turn1Res.json() as Record<string, unknown>;
    expect(turn1Json.object).toBe("v2.response");
    expect(turn1Json.model).toBe("m365-copilot/gpt-5.6");
    expect(turn1Json.provider).toBe("m365-copilot");
    expect(typeof turn1Json.conversation_key).toBe("string");
    expect((turn1Json.conversation_key as string).length).toBeGreaterThan(10);
    expect(turn1Json.conversation_id).toBe(targetConvId);
    expect(turn1Json.output_text).toBe("Chào Huy!");

    expect(recordedInputs).toHaveLength(1);
    expect(recordedInputs[0].prompt).toBe("  Xin chào, giữ nguyên khoảng trắng và KHÔNG thêm <webResponse>!  ");
    expect(recordedInputs[0].isNewConversation).toBe(true);
    expect(recordedInputs[0].existingConversationId).toBeUndefined();
    expect(recordedInputs[0].reasoningEffort).toBe("high");

    // Turn 2: tạo RawResponsesService + V2ConversationStore mới (mô phỏng server/launcher restart, tab cũ đóng)
    // Chỉ gửi conversation_key từ Turn 1, Launcher trả launcherReused=false & leaseConversationId=undefined
    const turn2Res = await makeService().executeRawTurn({
      req: new Request("http://127.0.0.1/v2/responses", { method: "POST" }),
      raw: {
        model: "m365-copilot/gpt-5.6",
        prompt: "Tên tôi là gì?",
        conversation_key: turn1Json.conversation_key,
      },
      adapterFactory,
    });

    expect(turn2Res.status).toBe(200);
    const turn2Json = await turn2Res.json() as Record<string, unknown>;
    expect(turn2Json.conversation_key).toBe(turn1Json.conversation_key);
    expect(turn2Json.conversation_id).toBe(targetConvId);
    expect(turn2Json.output_text).toBe("Tiếp tục đúng cuộc hội thoại cũ!");

    expect(recordedInputs).toHaveLength(2);
    expect(recordedInputs[1].prompt).toBe("Tên tôi là gì?");
    expect(recordedInputs[1].existingConversationId).toBe(targetConvId);
    expect(recordedInputs[1].isNewConversation).toBe(false);
    expect(recordedInputs[1].conversationKey).toBe(recordedInputs[0].conversationKey);
  });

  test("chấp nhận client tự đặt conversation_key hoặc chỉ truyền conversation_id ở Turn 2+", async () => {
    const dir = makeTempDir("v2-conv-direct-");
    const storePath = join(dir, "v2-conversations.json");
    const service = new RawResponsesService(
      ModelRegistry.getInstance(),
      AdapterRegistry.getInstance(),
      new V2ConversationStore(storePath),
    );
    const seen: WebBrowserTurnExecutionInput[] = [];
    const targetId = "223e4567-e89b-12d3-a456-426614174111";

    const adapterFactory = () => createRawEngineAdapter({
      onExecute: async (input) => {
        seen.push(input);
        return { rawResponse: "OK", conversationId: targetId };
      },
    });

    // Turn 1 với custom conversation_key
    const res1 = await service.executeRawTurn({
      req: new Request("http://127.0.0.1/v2/responses", { method: "POST" }),
      raw: {
        model: "m365-copilot",
        prompt: "Task #99",
        conversation_key: "order-99",
      },
      adapterFactory,
    });
    expect(res1.status).toBe(200);
    expect((await res1.json()).conversation_key).toBe("order-99");

    // Turn 2 chỉ gửi conversation_id (không gửi conversation_key)
    const res2 = await service.executeRawTurn({
      req: new Request("http://127.0.0.1/v2/responses", { method: "POST" }),
      raw: {
        model: "m365-copilot",
        prompt: "Tiếp tục Task #99",
        conversation_id: targetId,
      },
      adapterFactory,
    });
    expect(res2.status).toBe(200);
    const json2 = await res2.json() as Record<string, unknown>;
    expect(json2.conversation_key).toBe("order-99");
    expect(json2.conversation_id).toBe(targetId);
    expect(seen[1].existingConversationId).toBe(targetId);
    expect(seen[1].conversationKey).toBe(seen[0].conversationKey);
  });

  test("trả về 409 Conflict khi bắn 2 request song song vào cùng target conversation", async () => {
    const dir = makeTempDir("v2-conv-lock-");
    const service = new RawResponsesService(
      ModelRegistry.getInstance(),
      AdapterRegistry.getInstance(),
      new V2ConversationStore(join(dir, "v2-conversations.json")),
    );

    let releaseFirstTurn!: () => void;
    const firstTurnGate = new Promise<void>(resolve => {
      releaseFirstTurn = resolve;
    });
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>(resolve => {
      firstStarted = resolve;
    });

    const adapterFactory = () => createRawEngineAdapter({
      onExecute: async () => {
        firstStarted();
        await firstTurnGate;
        return {
          rawResponse: "done",
          conversationId: "323e4567-e89b-12d3-a456-426614174222",
        };
      },
    });

    const firstPromise = service.executeRawTurn({
      req: new Request("http://127.0.0.1/v2/responses", { method: "POST" }),
      raw: {
        model: "m365-copilot/gpt-5.6",
        prompt: "First",
        conversation_key: "same-session",
      },
      adapterFactory,
    });

    await firstStartedPromise;

    const conflictRes = await service.executeRawTurn({
      req: new Request("http://127.0.0.1/v2/responses", { method: "POST" }),
      raw: {
        model: "m365-copilot/gpt-5.6",
        prompt: "Second concurrent",
        conversation_key: "same-session",
      },
      adapterFactory,
    });
    expect(conflictRes.status).toBe(409);

    releaseFirstTurn();
    const firstRes = await firstPromise;
    expect(firstRes.status).toBe(200);

    // Sau khi lượt 1 xong, lock được giải phóng nên lượt mới chạy bình thường
    const afterRelease = await service.executeRawTurn({
      req: new Request("http://127.0.0.1/v2/responses", { method: "POST" }),
      raw: {
        model: "m365-copilot/gpt-5.6",
        prompt: "Third after done",
        conversation_key: "same-session",
      },
      adapterFactory,
    });
    expect(afterRelease.status).toBe(200);
  });

  test("từ chối stream: true (400), thiếu prompt (400), và hỗ trợ images", async () => {
    const dir = makeTempDir("v2-conv-validate-");
    const service = new RawResponsesService(
      ModelRegistry.getInstance(),
      AdapterRegistry.getInstance(),
      new V2ConversationStore(join(dir, "v2-conversations.json")),
    );
    const seenImages: number[] = [];
    const adapterFactory = () => createRawEngineAdapter({
      onExecute: async (input) => {
        seenImages.push(input.attachments.length);
        return { rawResponse: "img-ok", conversationId: "423e4567-e89b-12d3-a456-426614174333" };
      },
    });

    const streamRes = await service.executeRawTurn({
      req: new Request("http://127.0.0.1/v2/responses", { method: "POST" }),
      raw: { model: "m365-copilot", prompt: "hi", stream: true },
      adapterFactory,
    });
    expect(streamRes.status).toBe(400);

    const emptyPromptRes = await service.executeRawTurn({
      req: new Request("http://127.0.0.1/v2/responses", { method: "POST" }),
      raw: { model: "m365-copilot", prompt: "   " },
      adapterFactory,
    });
    expect(emptyPromptRes.status).toBe(400);

    const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
    const imageRes = await service.executeRawTurn({
      req: new Request("http://127.0.0.1/v2/responses", { method: "POST" }),
      raw: {
        model: "m365-copilot",
        prompt: "Mô tả ảnh này",
        images: [tinyPng],
      },
      adapterFactory,
    });
    expect(imageRes.status).toBe(200);
    expect(seenImages).toEqual([1]);
  });

  test("M365BrowserWorker.navigate mở lại đúng URL conversation khi !launcherReused và giữ fail-closed khi launcherReused", async () => {
    const uuid = "523e4567-e89b-12d3-a456-426614174444";
    expect(normalizeM365ConversationId(uuid.toUpperCase())).toBe(uuid);
    expect(buildM365ConversationUrl(uuid)).toBe(`https://m365.cloud.microsoft/chat/conversation/${uuid}`);

    class TestM365Worker extends M365BrowserWorker {
      public async testNavigate(page: Page, options: any): Promise<void> {
        await this.navigate(page, options);
      }
    }

    const worker = new TestM365Worker();
    const visited: string[] = [];
    let currentUrl = "https://m365.cloud.microsoft/chat";
    const mockPage = {
      url: () => currentUrl,
      goto: async (url: string) => {
        visited.push(url);
        currentUrl = url;
      },
    } as unknown as Page;

    // Khi !launcherReused (tab mới sau khi restart/đóng tab): tự goto tới conversation UUID
    await worker.testNavigate(mockPage, {
      prompt: "hi",
      conversationKey: "k1",
      existingConversationId: uuid,
      launcherReused: false,
    });
    expect(visited).toEqual([`https://m365.cloud.microsoft/chat/conversation/${uuid}`]);

    // Khi launcherReused === true nhưng URL lệch UUID: vẫn fail-closed
    currentUrl = "https://m365.cloud.microsoft/chat/conversation/999e4567-e89b-12d3-a456-426614174999";
    await expect(worker.testNavigate(mockPage, {
      prompt: "hi",
      conversationKey: "k1",
      existingConversationId: uuid,
      launcherReused: true,
    })).rejects.toThrow("M365 retained conversation mismatch");
  });

  test("HTTP server định tuyến POST /v2/responses và docs/swagger.html có tài liệu /v2/responses", async () => {
    const dir = makeTempDir("v2-http-");
    process.env.CODEX_CHATGPT_WEB_HOME = dir;
    const cfg = defaultConfig("browser-only");
    cfg.port = 0;

    const server = startServer(cfg, {
      adapterFactory: () => ({
        name: "m365-copilot",
        runTurn: async () => {},
        runRawTurn: async (req) => ({
          outputText: `ECHO:${req.prompt}`,
          conversationId: "623e4567-e89b-12d3-a456-426614174555",
        }),
      }),
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/v2/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m365-copilot/gpt-5.6",
          prompt: "Raw test via HTTP",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.output_text).toBe("ECHO:Raw test via HTTP");
      expect(body.conversation_id).toBe("623e4567-e89b-12d3-a456-426614174555");

      const swaggerHtml = readFileSync(join(process.cwd(), "docs", "swagger.html"), "utf8");
      expect(swaggerHtml).toContain('"/v2/responses"');
      expect(swaggerHtml).toContain("409 Conflict");
    } finally {
      await server.stop(true);
    }
  });

  test("POST /v2/responses truyền x-gateway-profile-id và tách kho conversation theo từng profile", async () => {
    const dir = makeTempDir("v2-profile-");
    const storePath = join(dir, "v2-conversations.json");
    const seenProfiles: Array<string | undefined> = [];
    const seenConvIds: Array<string | undefined> = [];
    const service = new RawResponsesService(
      ModelRegistry.getInstance(),
      AdapterRegistry.getInstance(),
      new V2ConversationStore(storePath),
    );

    const adapterFactory = () => ({
      name: "m365-copilot",
      runTurn: async () => {},
      runRawTurn: async (req: { profileId?: string; existingConversationId?: string }) => {
        seenProfiles.push(req.profileId);
        seenConvIds.push(req.existingConversationId);
        return {
          outputText: `OK:${req.profileId || "default"}`,
          conversationId:
            req.profileId === "p2"
              ? "222e4567-e89b-12d3-a456-426614174002"
              : "111e4567-e89b-12d3-a456-426614174001",
        };
      },
    });

    const r1 = await service.executeRawTurn({
      req: new Request("http://127.0.0.1/v2/responses", {
        method: "POST",
        headers: { "x-gateway-profile-id": "P2" },
      }),
      raw: {
        model: "m365-copilot/gpt-5.6",
        conversation_key: "shared-podcast-key",
        prompt: "Turn P2",
      },
      adapterFactory,
    });
    const r2 = await service.executeRawTurn({
      req: new Request("http://127.0.0.1/v2/responses", { method: "POST" }),
      raw: {
        model: "m365-copilot/gpt-5.6",
        conversation_key: "shared-podcast-key",
        prompt: "Turn default",
      },
      adapterFactory,
    });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(seenProfiles).toEqual(["p2", undefined]);
    expect(seenConvIds).toEqual([undefined, undefined]);
    const b1 = await r1.json() as Record<string, unknown>;
    const b2 = await r2.json() as Record<string, unknown>;
    expect(b1.conversation_id).toBe("222e4567-e89b-12d3-a456-426614174002");
    expect(b2.conversation_id).toBe("111e4567-e89b-12d3-a456-426614174001");
  });
});
