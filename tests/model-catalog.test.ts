import { describe, expect, test } from "bun:test";
import {
  augmentNativeModelCatalog,
  buildProviderModel,
} from "../src/models/model-catalog";
import {
  listModelRoutes,
  requireModelRoute,
} from "../src/models/model-registry";

function source(): Record<string, unknown> {
  return {
    models: [
      {
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6 Sol",
        description: "Native model",
        priority: 2,
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        multi_agent_version: "v2",
        supported_reasoning_levels: [
          { effort: "low", description: "Low" },
          { effort: "medium", description: "Medium" },
          { effort: "high", description: "High" },
        ],
        tool_mode: "code_mode_only",
        context_window: 300_000,
        max_context_window: 320_000,
        auto_compact_token_limit: 270_000,
        comp_hash: "native-contract",
      },
      {
        slug: "gpt-5.6-terra",
        display_name: "GPT-5.6 Terra",
        description: "Native secondary model",
        priority: 3,
        visibility: "list",
        supported_in_api: true,
        multi_agent_version: "v2",
        supported_reasoning_levels: [
          { effort: "low", description: "Low" },
        ],
      },
    ],
  };
}

const nativeConfig = {
  subagentProtocol: "native",
} as never;

describe("model catalog dùng registry chung", () => {
  test("giữ nguyên native models và thêm tất cả route trong registry", () => {
    const native = source();
    const snapshot = structuredClone(native);
    const result = augmentNativeModelCatalog(native, nativeConfig);
    const models = result.models as Array<Record<string, unknown>>;
    const nativeModels = snapshot.models as Array<Record<string, unknown>>;
    const expectedRoutes = listModelRoutes();

    expect(native).toEqual(snapshot);
    expect(models.slice(0, nativeModels.length)).toEqual(nativeModels);
    expect(models.slice(nativeModels.length).map(model => model.slug))
      .toEqual(expectedRoutes.map(route => route.slug));
  });

  test("chỉ công bố một model ChatGPT Web", () => {
    const models = augmentNativeModelCatalog(source(), nativeConfig)
      .models as Array<Record<string, unknown>>;
    const chatGptModels = models.filter(model =>
      model.slug === "chatgpt-web"
      || String(model.slug).startsWith("chatgpt-web/")
    );

    expect(chatGptModels).toHaveLength(1);
    expect(chatGptModels[0]).toMatchObject({
      slug: "chatgpt-web",
      display_name: "ChatGPT (Web)",
      visibility: "list",
      default_reasoning_level: "low",
      supported_reasoning_levels: [
        { effort: "low", description: "Normal" },
        { effort: "high", description: "Thinking" },
      ],
      input_modalities: ["text", "image"],
      context_window: 100_000,
      max_context_window: 100_000,
      effective_context_window_percent: 90,
      auto_compact_token_limit: 90_000,
    });
  });

  test("builder chung tạo model cho mọi provider", () => {
    const template = (source().models as Array<Record<string, unknown>>)[0]!;

    for (const route of listModelRoutes()) {
      const model = buildProviderModel(template, route, nativeConfig);

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
      expect(model).not.toHaveProperty("comp_hash");
      expect(
        (model.supported_reasoning_levels as Array<{ effort: string }>)
          .map(level => level.effort),
      ).toEqual(route.reasoningLevels.map(level => level.effort));
    }
  });

  test("loại catalog provider cũ trước khi build lại nên kết quả idempotent", () => {
    const polluted = source();
    (polluted.models as unknown[]).push(
      { slug: "chatgpt-web/pro", display_name: "Legacy Pro" },
      { slug: "chatgpt-web/luna", display_name: "Legacy Luna" },
      { slug: "qwen-web/think", display_name: "Legacy Qwen Think" },
    );

    const first = augmentNativeModelCatalog(polluted, nativeConfig);
    const second = augmentNativeModelCatalog(first, nativeConfig);
    const models = second.models as Array<Record<string, unknown>>;
    const slugs = models.map(model => String(model.slug));

    expect(slugs.filter(slug => slug === "chatgpt-web")).toHaveLength(1);
    expect(slugs).not.toContain("chatgpt-web/pro");
    expect(slugs).not.toContain("chatgpt-web/luna");
    expect(slugs).not.toContain("qwen-web/think");
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test("Compatibility V1 áp dụng protocol cho native và provider rows", () => {
    const config = { subagentProtocol: "compatibility-v1" } as never;
    const models = augmentNativeModelCatalog(source(), config)
      .models as Array<Record<string, unknown>>;

    expect(models.every(model => model.multi_agent_version === "v1")).toBeTrue();
  });

  test("context override chỉ nâng max_context_window của native models", () => {
    const models = augmentNativeModelCatalog(source(), nativeConfig, {
      contextWindow: 371_851,
    }).models as Array<Record<string, unknown>>;

    expect(models[0]?.context_window).toBe(300_000);
    expect(models[0]?.max_context_window).toBe(371_851);
    expect(models[1]?.max_context_window).toBe(371_851);

    const chatGpt = models.find(model => model.slug === "chatgpt-web");
    expect(chatGpt?.context_window).toBe(100_000);
    expect(chatGpt?.max_context_window).toBe(100_000);
  });

  test("không chấp nhận provider route làm native template", () => {
    const route = requireModelRoute("chatgpt-web");

    expect(() => buildProviderModel({
      slug: "chatgpt-web",
      visibility: "list",
      supported_reasoning_levels: [{ effort: "low", description: "Low" }],
    }, route, nativeConfig)).toThrow("must be a native Codex model");
  });

  test("từ chối catalog không có native template hợp lệ", () => {
    expect(() => augmentNativeModelCatalog({
      models: [{
        slug: "native-invalid",
        visibility: "hide",
        supported_reasoning_levels: [],
      }],
    }, nativeConfig)).toThrow(
      "Native Codex models response has no list-visible model with reasoning metadata",
    );
  });
});
