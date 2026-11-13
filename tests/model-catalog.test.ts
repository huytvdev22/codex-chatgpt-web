import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config";
import { BaseModelProvider } from "../src/models/base-model-provider";
import { ModelCatalog } from "../src/models/model-catalog";
import { ModelRegistry } from "../src/models/model-registry";
import type { JsonObject, ModelRouteDefinition } from "../src/models/types";

const nativeConfig = {
  subagentProtocol: "native",
} as never;

describe("model catalog chỉ xuất các model từ adapter qua BaseModelProvider + ModelRegistry", () => {
  const registry = ModelRegistry.getInstance();
  const catalog = ModelCatalog.getInstance();

  test("chỉ trả về đúng các route từ adapter đã đăng ký, không có native fallback", () => {
    const result = catalog.buildCatalog(nativeConfig);
    const expectedRoutes = registry.listRoutes();

    expect(result.models.map(model => model.slug))
      .toEqual(expectedRoutes.map(route => route.slug));
    expect(result.models.some(model => model.slug === "gpt-5.6-sol")).toBe(false);
    expect(result.models.some(model => model.slug === "gpt-5.5")).toBe(false);
  });

  test("công bố đầy đủ các model M365 Copilot với đầy đủ metadata cho Codex", () => {
    const models = catalog.buildCatalog(nativeConfig).models;

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      slug: "m365-copilot/gpt-5.6",
      display_name: "M365 - GPT 5.6",
      visibility: "list",
      supported_in_api: true,
      default_reasoning_level: "low",
      supported_reasoning_levels: [
        { effort: "low", description: "Quick" },
        { effort: "high", description: "Deeper" },
      ],
      input_modalities: ["text", "image"],
      context_window: 100_000,
      max_context_window: 100_000,
      effective_context_window_percent: 90,
      auto_compact_token_limit: 90_000,
      shell_type: "unified_exec",
      multi_agent_version: "v2",
    });
  });

  test("builder chung tạo model cho mọi provider từ canonical defaults", () => {
    for (const route of registry.listRoutes()) {
      const model = catalog.buildProviderModel(route, nativeConfig);

      expect(model).toMatchObject({
        slug: route.slug,
        display_name: route.displayName,
        description: route.description,
        visibility: "list",
        supported_in_api: true,
        tool_mode: null,
        default_reasoning_level: route.defaultReasoningLevel,
        context_window: route.contextWindow,
        max_context_window: route.contextWindow,
        auto_compact_token_limit: route.autoCompactTokenLimit,
      });
      expect(
        (model.supported_reasoning_levels as Array<{ effort: string }>)
          .map(level => level.effort),
      ).toEqual(route.reasoningLevels.map(level => level.effort));
    }
  });

  test("Compatibility V1 áp dụng protocol v1 cho toàn bộ adapter models", () => {
    const config = { subagentProtocol: "compatibility-v1" } as never;
    const models = catalog.buildCatalog(config).models;

    expect(models.every(model => model.multi_agent_version === "v1")).toBeTrue();
  });

  test("từ chối build route chưa có provider đăng ký", () => {
    const orphanRoute: ModelRouteDefinition = {
      slug: "unregistered/model",
      displayName: "Orphan",
      description: "Unregistered route",
      contextWindow: 100_000,
      autoCompactTokenLimit: 90_000,
      effectiveContextWindowPercent: 90,
      inputModalities: ["text"],
      defaultReasoningLevel: "low",
      reasoningLevels: [{ effort: "low", description: "Low" }],
    };

    expect(() => catalog.buildProviderModel(orphanRoute, nativeConfig)).toThrow(
      "No registered ModelProvider for route: unregistered/model",
    );
  });

  test("adapter mới kế thừa BaseModelProvider chỉ cần override hook cần thiết", () => {
    class CustomWebModelProvider extends BaseModelProvider {
      public readonly id = "custom-web";
      public readonly exactSlugs = ["custom-web"] as const;
      public readonly slugPrefixes = ["custom-web/"] as const;
      public readonly routes: readonly ModelRouteDefinition[] = [
        {
          slug: "custom-web/pro",
          displayName: "Custom Web Pro",
          description: "Custom Web Adapter Model",
          contextWindow: 128_000,
          autoCompactTokenLimit: 110_000,
          effectiveContextWindowPercent: 90,
          inputModalities: ["text"],
          defaultReasoningLevel: "low",
          reasoningLevels: [
            { effort: "low", description: "Fast" },
            { effort: "high", description: "Deep" },
          ],
        },
      ];

      protected override buildModelOverrides(
        _route: ModelRouteDefinition,
        _config: AppConfig,
      ): JsonObject {
        return { custom_adapter_flag: true };
      }

      public override isCatalogSynced(storedProviderModels: readonly JsonObject[]): boolean {
        return super.isCatalogSynced(storedProviderModels)
          && storedProviderModels.every(model => model.custom_adapter_flag === true);
      }
    }

    const customRegistry = new ModelRegistry([new CustomWebModelProvider()]);
    const customCatalog = new ModelCatalog(customRegistry);
    const built = customCatalog.buildCatalog(nativeConfig);
    const customModel = built.models.find(m => m.slug === "custom-web/pro");

    expect(built.models).toHaveLength(1);
    expect(customModel).toMatchObject({
      slug: "custom-web/pro",
      display_name: "Custom Web Pro",
      custom_adapter_flag: true,
      context_window: 128_000,
    });

    const tempDir = mkdtempSync(join(tmpdir(), "custom-model-provider-"));
    try {
      const catalogPath = join(tempDir, "catalog.json");
      writeFileSync(catalogPath, JSON.stringify({
        models: [
          {
            slug: "custom-web/pro",
            visibility: "list",
            input_modalities: ["text"],
          },
        ],
      }));

      customCatalog.ensureManagedCatalogFile(nativeConfig, catalogPath, false);
      const refreshed = JSON.parse(readFileSync(catalogPath, "utf8")) as {
        models: JsonObject[];
      };
      const syncedCustom = refreshed.models.find(model => model.slug === "custom-web/pro");
      expect(syncedCustom?.custom_adapter_flag).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
