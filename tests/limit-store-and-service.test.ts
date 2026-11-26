import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry } from "../src/adapters/adapter-registry";
import type { ProviderAdapter } from "../src/adapters/base";
import { activeWebTurnRegistry, ProviderBusyError } from "../src/adapters/web";
import type { AppConfig } from "../src/config";
import { AdminController } from "../src/controllers/admin-controller";
import { HttpTurnCounter } from "../src/controllers/http-turn-counter";
import { LimitStore } from "../src/limits";
import type { LauncherBrowserHostDescriptor } from "../src/launcher-browser-host";
import { ModelRegistry } from "../src/models/model-registry";
import { LimitManagementService } from "../src/services/limit-management-service";

function createTestConfig(port = 17841): AppConfig {
  return {
    host: "127.0.0.1",
    port,
    mode: "browser-only",
    controlToken: "test-control-token-1234567890",
    bridgeRouteName: "codex-web",
    subagentProtocol: "native",
    useSavedChats: false,
    experimentalBiggerContext: false,
    experimentalSkillAttachments: false,
    experimentalFreshConversationPerTurn: false,
    browserHostDescriptorPath: undefined,
  } as unknown as AppConfig;
}

describe("LimitStore, LimitManagementService & AdminController Limits API", () => {
  test("lưu trữ cache tách biệt theo (providerId, profileId) và dọn profile đã xóa", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-limits-store-"));
    try {
      const store = new LimitStore(join(dir, "provider-limits.json"));
      store.saveCheckResult({
        providerId: "chatgpt",
        profileId: "default",
        profileName: "Default",
        result: {
          status: "ok",
          planName: "ChatGPT Plus",
          sourceUrl: "https://chatgpt.com/settings/usage?tab=overview",
          sourceKind: "network-json",
          buckets: [
            {
              id: "primary_window",
              label: "5-hour limit",
              percentUsed: 12,
              severity: "ok",
            },
          ],
        },
      });
      store.saveCheckResult({
        providerId: "chatgpt",
        profileId: "work",
        profileName: "Work",
        result: {
          status: "warning",
          planName: "ChatGPT Team",
          sourceUrl: "https://chatgpt.com/settings/usage?tab=overview",
          sourceKind: "network-json",
          buckets: [
            {
              id: "primary_window",
              label: "5-hour limit",
              percentUsed: 88,
              severity: "warning",
            },
          ],
        },
      });

      store.clearCache();
      const file = store.readFile();
      expect(Object.keys(file.entries).sort()).toEqual([
        "chatgpt::default",
        "chatgpt::work",
      ]);
      expect(file.entries["chatgpt::work"].status).toBe("warning");

      const pruned = store.pruneRemovedProfiles(
        new Set(["chatgpt::default"]),
        new Set(["chatgpt"]),
      );
      expect(pruned).toBe(true);
      expect(Object.keys(store.readFile().entries)).toEqual(["chatgpt::default"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("LimitManagementService hỗ trợ đa profile, unsupported provider và chặn ProviderBusyError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-limits-service-"));
    try {
      const store = new LimitStore(join(dir, "provider-limits.json"));
      const checkedTargets: Array<{ provider: string; profileId?: string }> = [];

      const registry = new AdapterRegistry([
        [
          "chatgpt",
          () =>
            ({
              name: "chatgpt",
              runTurn: async () => {},
              checkUsageLimit: async (req) => {
                checkedTargets.push({ provider: "chatgpt", profileId: req?.profileId });
                return {
                  status: req?.profileId === "work" ? "warning" : "ok",
                  planName: req?.profileId === "work" ? "ChatGPT Pro" : "ChatGPT Plus",
                  sourceUrl: "https://chatgpt.com/settings/usage?tab=overview",
                  sourceKind: "network-json",
                  buckets: [
                    {
                      id: "primary_window",
                      label: "5-hour limit",
                      percentUsed: req?.profileId === "work" ? 85 : 5,
                      severity: req?.profileId === "work" ? "warning" : "ok",
                    },
                  ],
                };
              },
            }) satisfies ProviderAdapter,
        ],
        [
          "gemini",
          () =>
            ({
              name: "gemini",
              runTurn: async () => {},
              checkUsageLimit: async (req) => {
                checkedTargets.push({ provider: "gemini", profileId: req?.profileId });
                return {
                  status: "ok",
                  planName: "Gemini Pro",
                  sourceUrl: "https://gemini.google.com/usage",
                  sourceKind: "dom",
                  buckets: [
                    {
                      id: "current-usage",
                      label: "Current usage",
                      percentUsed: 0,
                      severity: "ok",
                    },
                  ],
                };
              },
            }) satisfies ProviderAdapter,
        ],
      ]);

      const descriptor = {
        provider: "chatgpt",
        providerProfiles: {
          chatgpt: {
            activeProfileId: "default",
            profiles: [
              { id: "default", name: "Personal", authenticated: true },
              { id: "work", name: "Work", authenticated: true },
              { id: "guest", name: "Guest", authenticated: false },
            ],
          },
          gemini: {
            activeProfileId: "default",
            profiles: [{ id: "default", name: "Default", authenticated: true }],
          },
          "ai-studio": {
            activeProfileId: "default",
            profiles: [{ id: "default", name: "Default", authenticated: true }],
          },
          m365: {
            activeProfileId: "default",
            profiles: [{ id: "default", name: "Default", authenticated: true }],
          },
        },
      } as unknown as LauncherBrowserHostDescriptor;

      const service = new LimitManagementService(
        store,
        ModelRegistry.getInstance(),
        registry,
        () => descriptor,
      );

      // Refresh riêng profile "work" của chatgpt
      const workOutcome = await service.refreshLimits({
        providerId: "chatgpt",
        profileId: "work",
      });
      expect(checkedTargets).toEqual([{ provider: "chatgpt", profileId: "work" }]);
      expect(workOutcome.results[0]).toMatchObject({
        providerId: "chatgpt",
        profileId: "work",
        status: "warning",
      });

      // Refresh toàn bộ: bỏ qua guest chưa auth và không chạy live cho ai-studio/m365-copilot
      checkedTargets.length = 0;
      const allOutcome = await service.refreshLimits();
      expect(checkedTargets).toEqual([
        { provider: "gemini", profileId: "default" },
        { provider: "chatgpt", profileId: "default" },
        { provider: "chatgpt", profileId: "work" },
      ]);
      const aiStudioEntry = allOutcome.snapshot.entries.find(
        (e) => e.providerId === "ai-studio",
      );
      expect(aiStudioEntry?.support).toBe("unsupported");
      expect(aiStudioEntry?.status).toBe("unsupported");

      const guestEntry = allOutcome.snapshot.entries.find(
        (e) => e.providerId === "chatgpt" && e.profileId === "guest",
      );
      expect(guestEntry?.status).toBe("signed_out");

      // Giả lập chatgpt đang chạy turn -> single target ném ProviderBusyError
      const reg = activeWebTurnRegistry.register("busy-trace-123456", undefined, "chatgpt");
      try {
        await expect(
          service.refreshLimits({ providerId: "chatgpt", profileId: "default" }),
        ).rejects.toThrow(ProviderBusyError);
      } finally {
        reg.finish();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AdminController exposes /admin/limits, /admin/limits/refresh và /v1/limits đúng phân quyền", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-limits-controller-"));
    try {
      const config = createTestConfig();
      const store = new LimitStore(join(dir, "provider-limits.json"));
      const service = new LimitManagementService(
        store,
        ModelRegistry.getInstance(),
        new AdapterRegistry([]),
        () => null,
      );

      const controller = new AdminController({
        config,
        startedAt: Date.now(),
        swaggerPath: join(dir, "swagger.html"),
        httpTurns: new HttpTurnCounter(),
        getModelsMetrics: () => ({
          successful_model_catalog_requests: 0,
          last_successful_model_catalog_request_at: null,
          model_catalog_requests: 0,
          last_model_catalog_result: null,
        }),
        isDraining: () => false,
        setDraining: () => {},
        shutdown: () => {},
        limitManagementService: service,
      });

      // /admin/limits yêu cầu Bearer token
      const unauthRes = controller.handleGetLimits(
        new Request("http://127.0.0.1:17841/admin/limits"),
      );
      expect(unauthRes.status).toBe(401);

      const authRes = controller.handleGetLimits(
        new Request("http://127.0.0.1:17841/admin/limits", {
          headers: { authorization: `Bearer ${config.controlToken}` },
        }),
      );
      expect(authRes.status).toBe(200);
      const authJson = (await authRes.json()) as { status: string; snapshot: { entries: unknown[] } };
      expect(authJson.status).toBe("ok");
      expect(Array.isArray(authJson.snapshot.entries)).toBe(true);

      // /v1/limits không cần token và chỉ đọc cache
      const pubRes = controller.handleGetPublicLimits();
      expect(pubRes.status).toBe(200);
      const pubJson = (await pubRes.json()) as { object: string; data: unknown[] };
      expect(pubJson.object).toBe("list");
      expect(Array.isArray(pubJson.data)).toBe(true);

      // /admin/limits/refresh trả 400 nếu profileId không kèm providerId
      const badRefresh = await controller.handleRefreshLimits(
        new Request("http://127.0.0.1:17841/admin/limits/refresh", {
          method: "POST",
          headers: { authorization: `Bearer ${config.controlToken}` },
          body: JSON.stringify({ profileId: "work" }),
        }),
      );
      expect(badRefresh.status).toBe(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
