import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiStudioModelProvider } from "../src/adapters/ai-studio/model-provider";
import { ChatGptModelProvider } from "../src/adapters/chatgpt/model-provider";
import { GeminiModelProvider } from "../src/adapters/gemini/model-provider";
import { M365ModelProvider } from "../src/adapters/m365-copilot/model-provider";
import type { AppConfig } from "../src/config";
import { ModelCatalog } from "../src/models/model-catalog";
import { ModelConfigError, ModelConfigStore } from "../src/models/model-config-store";
import { ModelRegistry } from "../src/models/model-registry";

const nativeConfig = {
  subagentProtocol: "native",
} as AppConfig;

function createIsolatedHarness() {
  const dir = mkdtempSync(join(tmpdir(), "codex-model-config-"));
  const store = new ModelConfigStore(() => dir);
  const providers = [
    M365ModelProvider.getInstance(),
    AiStudioModelProvider.getInstance(),
    GeminiModelProvider.getInstance(),
    ChatGptModelProvider.getInstance(),
  ];
  const registry = new ModelRegistry(providers, store);
  const catalog = new ModelCatalog(registry);
  return {
    dir,
    store,
    providers,
    registry,
    catalog,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("ModelConfigStore overlay, auto-discovery merge & constraints", () => {
  test("mặc định bật toàn bộ built-in models khi chưa có models.json", () => {
    const h = createIsolatedHarness();
    try {
      const snap = h.registry.getManagedSnapshot();
      expect(snap.totalEnabledCount).toBe(7);
      expect(h.registry.listEnabledRoutes().map(r => r.slug)).toEqual([
        "m365-copilot/gpt-5.6",
        "m365-copilot",
        "ai-studio/gemini-4-hydrogen",
        "gemini",
        "chatgpt/gpt-6.2",
        "chatgpt/gpt-6",
        "chatgpt/gpt-5.6-sol",
      ]);
      expect(h.registry.getModelStatus("chatgpt/gpt-6").status).toBe("enabled");
    } finally {
      h.cleanup();
    }
  });

  test("chặn tắt model bật cuối cùng (AT_LEAST_ONE_MODEL_REQUIRED) cả ở mức model và provider", () => {
    const h = createIsolatedHarness();
    try {
      h.store.setProviderEnabled(h.providers, "m365-copilot", false);
      h.store.setProviderEnabled(h.providers, "ai-studio", false);
      h.store.setProviderEnabled(h.providers, "gemini", false);
      h.store.updateOverride(h.providers, "chatgpt/gpt-6", { enabled: false });
      h.store.updateOverride(h.providers, "chatgpt/gpt-5.6-sol", { enabled: false });

      const beforeFinal = h.registry.getManagedSnapshot();
      expect(beforeFinal.totalEnabledCount).toBe(1);

      expect(() =>
        h.store.updateOverride(h.providers, "chatgpt/gpt-6.2", { enabled: false }),
      ).toThrow(ModelConfigError);

      try {
        h.store.setProviderEnabled(h.providers, "chatgpt", false);
        throw new Error("Expected setProviderEnabled to fail");
      } catch (err) {
        expect(err).toBeInstanceOf(ModelConfigError);
        expect((err as ModelConfigError).code).toBe("AT_LEAST_ONE_MODEL_REQUIRED");
      }
    } finally {
      h.cleanup();
    }
  });

  test("model mới phát hiện qua Refresh mặc định OFF; model biến mất thành unavailable nhưng giữ nguyên override", () => {
    const h = createIsolatedHarness();
    try {
      // User chỉnh tên tùy biến cho chatgpt/gpt-6 trước
      h.store.updateOverride(h.providers, "chatgpt/gpt-6", {
        displayName: "My GPT-6",
        contextWindow: 200_000,
      });

      // Refresh lần 1 phát hiện thêm model mới "chatgpt/gpt-6.5" và chỉ giữ gpt-6.2 + gpt-6 (thiếu gpt-5.6-sol)
      const outcome1 = h.store.applyDiscoveryResult(h.providers, "chatgpt", [
        {
          slug: "chatgpt/gpt-6.2",
          providerId: "chatgpt",
          displayName: "ChatGPT - GPT-6.2",
          uiLabel: "GPT-6.2",
          isAccountDefault: true,
        },
        {
          slug: "chatgpt/gpt-6",
          providerId: "chatgpt",
          displayName: "ChatGPT - GPT-6",
          uiLabel: "GPT-6",
          shortUiVersion: "6",
        },
        {
          slug: "chatgpt/gpt-6.5",
          providerId: "chatgpt",
          displayName: "ChatGPT - GPT-6.5",
          uiLabel: "GPT-6.5",
          shortUiVersion: "6.5",
        },
      ]);

      expect(outcome1.addedCount).toBe(1);
      expect(outcome1.updatedCount).toBe(2);
      expect(outcome1.unavailableCount).toBe(1);

      const gpt65 = h.registry.listManagedModels("chatgpt").find(m => m.slug === "chatgpt/gpt-6.5");
      expect(gpt65).toBeDefined();
      expect(gpt65!.source).toBe("discovered");
      expect(gpt65!.available).toBe(true);
      expect(gpt65!.enabled).toBe(false);
      expect(h.registry.getModelStatus("chatgpt/gpt-6.5").status).toBe("disabled");

      const gpt56 = h.registry.listManagedModels("chatgpt").find(m => m.slug === "chatgpt/gpt-5.6-sol");
      expect(gpt56!.available).toBe(false);
      expect(gpt56!.effectiveEnabled).toBe(false);
      expect(h.registry.getModelStatus("chatgpt/gpt-5.6-sol").status).toBe("unavailable");

      // Refresh lần 2: gpt-6 biến mất tạm thời, gpt-6.5 được user bật ON
      h.store.updateOverride(h.providers, "chatgpt/gpt-6.5", { enabled: true });
      h.store.applyDiscoveryResult(h.providers, "chatgpt", [
        {
          slug: "chatgpt/gpt-6.2",
          providerId: "chatgpt",
          displayName: "ChatGPT - GPT-6.2",
          uiLabel: "GPT-6.2",
          isAccountDefault: true,
        },
        {
          slug: "chatgpt/gpt-6.5",
          providerId: "chatgpt",
          displayName: "ChatGPT - GPT-6.5",
          uiLabel: "GPT-6.5",
          shortUiVersion: "6.5",
        },
      ]);
      expect(h.registry.getModelStatus("chatgpt/gpt-6").status).toBe("unavailable");
      expect(h.registry.getModelStatus("chatgpt/gpt-6.5").status).toBe("enabled");

      // Refresh lần 3: gpt-6 xuất hiện lại -> vẫn giữ nguyên custom displayName & contextWindow
      h.store.applyDiscoveryResult(h.providers, "chatgpt", [
        {
          slug: "chatgpt/gpt-6.2",
          providerId: "chatgpt",
          displayName: "ChatGPT - GPT-6.2",
          uiLabel: "GPT-6.2",
          isAccountDefault: true,
        },
        {
          slug: "chatgpt/gpt-6",
          providerId: "chatgpt",
          displayName: "ChatGPT - GPT-6",
          uiLabel: "GPT-6",
          shortUiVersion: "6",
        },
      ]);
      const restoredGpt6 = h.registry.listManagedModels("chatgpt").find(m => m.slug === "chatgpt/gpt-6");
      expect(restoredGpt6!.available).toBe(true);
      expect(restoredGpt6!.displayName).toBe("My GPT-6");
      expect(restoredGpt6!.contextWindow).toBe(200_000);
      expect(restoredGpt6!.autoCompactTokenLimit).toBe(180_000);
    } finally {
      h.cleanup();
    }
  });

  test("hot-reload khi models.json bị chỉnh tay bên ngoài & đồng bộ catalog.json chỉ chứa model ON", () => {
    const h = createIsolatedHarness();
    try {
      h.store.updateOverride(h.providers, "ai-studio/gemini-4-hydrogen", {
        displayName: "Gemini 4 Custom",
        contextWindow: 500_000,
        inputModalities: ["text"],
        defaultReasoningLevel: "medium",
      });
      h.store.updateOverride(h.providers, "chatgpt/gpt-6", { enabled: false });

      const built = h.catalog.buildCatalog(nativeConfig);
      expect(built.models.some(m => m.slug === "chatgpt/gpt-6")).toBe(false);
      const gemini = built.models.find(m => m.slug === "ai-studio/gemini-4-hydrogen");
      expect(gemini).toMatchObject({
        display_name: "Gemini 4 Custom",
        context_window: 500_000,
        auto_compact_token_limit: 450_000,
        input_modalities: ["text"],
        default_reasoning_level: "medium",
      });

      const catalogPath = join(h.dir, "catalog.json");
      h.catalog.ensureManagedCatalogFile(nativeConfig, catalogPath);
      expect(JSON.parse(readFileSync(catalogPath, "utf8")).models).toHaveLength(6);

      // Sửa tay models.json trực tiếp trên đĩa để bật lại chatgpt/gpt-6
      const filePath = h.store.getConfigPath();
      const rawJson = JSON.parse(readFileSync(filePath, "utf8"));
      delete rawJson.overrides["chatgpt/gpt-6"];
      writeFileSync(filePath, `${JSON.stringify(rawJson, null, 2)}\n`);

      expect(h.registry.getModelStatus("chatgpt/gpt-6").status).toBe("enabled");
      h.catalog.ensureManagedCatalogFile(nativeConfig, catalogPath);
      expect(JSON.parse(readFileSync(catalogPath, "utf8")).models).toHaveLength(7);
    } finally {
      h.cleanup();
    }
  });
});
