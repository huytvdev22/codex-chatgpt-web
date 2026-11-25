import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry } from "../src/adapters/adapter-registry";
import { AiStudioModelProvider } from "../src/adapters/ai-studio/model-provider";
import type { ProviderAdapter } from "../src/adapters/base";
import { ChatGptModelProvider } from "../src/adapters/chatgpt/model-provider";
import { GeminiModelProvider } from "../src/adapters/gemini/model-provider";
import { M365ModelProvider } from "../src/adapters/m365-copilot/model-provider";
import { activeWebTurnRegistry } from "../src/adapters/web";
import { defaultConfig } from "../src/config";
import { AdminController } from "../src/controllers/admin-controller";
import { HttpTurnCounter } from "../src/controllers/http-turn-counter";
import { ModelsController } from "../src/controllers/models-controller";
import { ResponsesController } from "../src/controllers/responses-controller";
import { ModelCatalog } from "../src/models/model-catalog";
import { ModelConfigStore } from "../src/models/model-config-store";
import { ModelRegistry } from "../src/models/model-registry";
import { ModelManagementService } from "../src/services/model-management-service";
import { RawResponsesService } from "../src/services/raw-responses-service";
import { ResponsesService } from "../src/services/responses-service";
import { V2ConversationStore } from "../src/services/v2-conversation-store";

function createTestRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "codex-model-api-"));
  const config = {
    ...defaultConfig("browser-only"),
    controlToken: "test-control-token",
    subagentProtocol: "native" as const,
  };

  const store = new ModelConfigStore(() => dir);
  const modelRegistry = new ModelRegistry(
    [
      M365ModelProvider.getInstance(),
      AiStudioModelProvider.getInstance(),
      GeminiModelProvider.getInstance(),
      ChatGptModelProvider.getInstance(),
    ],
    store,
  );
  const modelCatalog = new ModelCatalog(modelRegistry);
  const adapterRegistry = new AdapterRegistry([
    [
      "chatgpt",
      () =>
        ({
          name: "chatgpt",
          runTurn: async (_parsed, _incoming, emit) => {
            emit({ type: "text_delta", text: "OK" });
            emit({ type: "done", stopReason: "stop", endTurn: true });
          },
          runRawTurn: async () => ({ outputText: "OK", conversationId: "conv-1" }),
          discoverModels: async () => [
            {
              slug: "chatgpt/gpt-6.2",
              providerId: "chatgpt",
              displayName: "ChatGPT - GPT-6.2",
              uiLabel: "GPT-6.2",
              isAccountDefault: true,
            },
            {
              slug: "chatgpt/gpt-6.8-new",
              providerId: "chatgpt",
              displayName: "ChatGPT - GPT-6.8 New",
              uiLabel: "GPT-6.8 New",
              shortUiVersion: "6.8",
            },
          ],
        }) satisfies ProviderAdapter,
    ],
    [
      "ai-studio",
      () =>
        ({
          name: "ai-studio",
          runTurn: async () => {},
          discoverModels: async () => [
            {
              slug: "ai-studio/gemini-4-hydrogen",
              providerId: "ai-studio",
              displayName: "Gemini 4 Hydrogen",
              remoteModelId: "gemini-4-hydrogen",
              contextWindow: 1_000_000,
            },
          ],
        }) satisfies ProviderAdapter,
    ],
    [
      "m365-copilot",
      () =>
        ({
          name: "m365-copilot",
          runTurn: async () => {},
          discoverModels: async () => [
            {
              slug: "m365-copilot",
              providerId: "m365-copilot",
              displayName: "M365 Copilot",
            },
          ],
        }) satisfies ProviderAdapter,
    ],
  ]);

  const modelManagementService = new ModelManagementService(
    modelRegistry,
    modelCatalog,
    adapterRegistry,
  );
  const modelsController = new ModelsController(modelCatalog);
  const responsesController = new ResponsesController(
    new ResponsesService(modelRegistry, adapterRegistry, () => undefined),
    new RawResponsesService(
      modelRegistry,
      adapterRegistry,
      new V2ConversationStore(join(dir, "v2-conv.json")),
    ),
  );
  const adminController = new AdminController({
    config,
    startedAt: Date.now(),
    swaggerPath: join(dir, "swagger.html"),
    httpTurns: new HttpTurnCounter(),
    getModelsMetrics: () => modelsController.getMetricsSnapshot(),
    isDraining: () => false,
    setDraining: () => {},
    shutdown: () => {},
    modelManagementService,
  });

  const authHeaders = {
    authorization: "Bearer test-control-token",
    "content-type": "application/json",
  };

  return {
    dir,
    config,
    authHeaders,
    modelCatalog,
    modelRegistry,
    adminController,
    modelsController,
    responsesController,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("Model Management Control Plane & /v1 + /v2 Enforcement", () => {
  test("từ chối truy cập /admin/models nếu thiếu hoặc sai controlToken", async () => {
    const rt = createTestRuntime();
    try {
      const res1 = rt.adminController.handleGetModels(new Request("http://127.0.0.1/admin/models"));
      expect(res1.status).toBe(401);

      const res2 = await rt.adminController.handleRefreshModels(
        new Request("http://127.0.0.1/admin/models/refresh", {
          method: "POST",
          headers: { authorization: "Bearer wrong" },
        }),
      );
      expect(res2.status).toBe(401);
    } finally {
      rt.cleanup();
    }
  });

  test("tắt model ẩn ngay khỏi /v1/models và chặn cả /v1/responses + /v2/responses bằng 400", async () => {
    const rt = createTestRuntime();
    try {
      // 1. Tắt chatgpt/gpt-6
      const putRes = await rt.adminController.handleUpdateModelOverride(
        new Request("http://127.0.0.1/admin/models/override", {
          method: "PUT",
          headers: rt.authHeaders,
          body: JSON.stringify({ slug: "chatgpt/gpt-6", patch: { enabled: false } }),
        }),
      );
      expect(putRes.status).toBe(200);

      // /v1/models bỏ chatgpt/gpt-6 ngay
      const modelsRes = await rt.modelsController.handleModelsRequest(
        new Request("http://127.0.0.1/v1/models"),
        rt.config,
      );
      const modelsBody = (await modelsRes.json()) as { models: Array<{ slug: string }> };
      expect(modelsBody.models.some(m => m.slug === "chatgpt/gpt-6")).toBe(false);

      // /v1/responses với chatgpt/gpt-6 bị chặn 400
      const v1Res = await rt.responsesController.handleResponses(
        new Request("http://127.0.0.1/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "chatgpt/gpt-6", input: "hi", stream: false }),
        }),
      );
      expect(v1Res.status).toBe(400);
      const v1Err = (await v1Res.json()) as { error: { message: string } };
      expect(v1Err.error.message).toContain("disabled");

      // /v2/responses với chatgpt/gpt-6 cũng bị chặn 400
      const v2Res = await rt.responsesController.handleV2Responses(
        new Request("http://127.0.0.1/v2/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "chatgpt/gpt-6", prompt: "hi" }),
        }),
      );
      expect(v2Res.status).toBe(400);
      const v2Err = (await v2Res.json()) as { error: { message: string } };
      expect(v2Err.error.message).toContain("disabled");

      // /v2/responses với model đang bật vẫn chạy bình thường
      const v2Ok = await rt.responsesController.handleV2Responses(
        new Request("http://127.0.0.1/v2/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "chatgpt/gpt-6.2", prompt: "hi" }),
        }),
      );
      expect(v2Ok.status).toBe(200);
      expect(((await v2Ok.json()) as { output_text: string }).output_text).toBe("OK");
    } finally {
      rt.cleanup();
    }
  });

  test("refresh discovery trả 409 nếu provider đang chạy turn, và cập nhật model mới opt-in OFF khi rảnh", async () => {
    const rt = createTestRuntime();
    try {
      const reg = activeWebTurnRegistry.register("busy-trace-123", undefined, "chatgpt");
      try {
        const busyRes = await rt.adminController.handleRefreshModels(
          new Request("http://127.0.0.1/admin/models/refresh", {
            method: "POST",
            headers: rt.authHeaders,
            body: JSON.stringify({ providerId: "chatgpt" }),
          }),
        );
        expect(busyRes.status).toBe(409);
        const busyJson = (await busyRes.json()) as { code: string };
        expect(busyJson.code).toBe("PROVIDER_BUSY");
      } finally {
        reg.finish();
      }

      const refreshRes = await rt.adminController.handleRefreshModels(
        new Request("http://127.0.0.1/admin/models/refresh", {
          method: "POST",
          headers: rt.authHeaders,
          body: JSON.stringify({ providerId: "chatgpt" }),
        }),
      );
      expect(refreshRes.status).toBe(200);
      const refreshBody = (await refreshRes.json()) as {
        results: Array<{ providerId: string; status: string; addedCount: number }>;
      };
      expect(refreshBody.results[0]).toMatchObject({
        providerId: "chatgpt",
        status: "ok",
        addedCount: 1,
      });

      // Model mới mặc định OFF -> bị chặn ở /v2/responses cho tới khi user bật ON
      const blockedNew = await rt.responsesController.handleV2Responses(
        new Request("http://127.0.0.1/v2/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "chatgpt/gpt-6.8-new", prompt: "hi" }),
        }),
      );
      expect(blockedNew.status).toBe(400);

      await rt.adminController.handleUpdateModelOverride(
        new Request("http://127.0.0.1/admin/models/override", {
          method: "PUT",
          headers: rt.authHeaders,
          body: JSON.stringify({ slug: "chatgpt/gpt-6.8-new", patch: { enabled: true } }),
        }),
      );

      const allowedNew = await rt.responsesController.handleV2Responses(
        new Request("http://127.0.0.1/v2/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "chatgpt/gpt-6.8-new", prompt: "hi" }),
        }),
      );
      expect(allowedNew.status).toBe(200);

      // Reset all đưa mọi thứ về mặc định ban đầu
      const resetRes = await rt.adminController.handleResetModels(
        new Request("http://127.0.0.1/admin/models/reset", {
          method: "POST",
          headers: rt.authHeaders,
          body: JSON.stringify({}),
        }),
      );
      expect(resetRes.status).toBe(200);
      const resetJson = (await resetRes.json()) as { snapshot: { totalEnabledCount: number } };
      expect(resetJson.snapshot.totalEnabledCount).toBe(7);

      // Nếu catalogPath được tạo trong dir tạm, kiểm tra readFileSync không lỗi
      const savedPath = rt.modelCatalog.getManagedCatalogPath(rt.dir);
      rt.modelCatalog.buildAndSyncCatalog(rt.config, { catalogPath: savedPath });
      expect(JSON.parse(readFileSync(savedPath, "utf8")).models).toHaveLength(7);
    } finally {
      rt.cleanup();
    }
  });
});
