import { describe, expect, test } from "bun:test";
import { AdapterRegistry } from "../src/adapters/adapter-registry";
import {
  CHATGPT_DEFAULT_MODEL_SLUG,
  ChatGptAdapter,
  ChatGptModelProvider,
} from "../src/adapters/chatgpt";
import { WebProviderAdapter } from "../src/adapters/web/web-provider-adapter";
import { ModelRegistry } from "../src/models/model-registry";

describe("ChatGptModelProvider & Registry integration", () => {
  test("đăng ký đầy đủ 3 model ChatGPT trong ModelRegistry & AdapterRegistry", () => {
    const modelProvider = ChatGptModelProvider.getInstance();
    expect(modelProvider.id).toBe("chatgpt");
    expect(modelProvider.routes.map((route) => route.slug)).toEqual([
      "chatgpt/gpt-6.2",
      "chatgpt/gpt-6",
      "chatgpt/gpt-5.6-sol",
    ]);

    expect(modelProvider.matchModelSlug("chatgpt")).toBe(true);
    expect(modelProvider.matchModelSlug("chatgpt/gpt-6.2")).toBe(true);
    expect(modelProvider.matchModelSlug("chatgpt/gpt-6")).toBe(true);
    expect(modelProvider.matchModelSlug("chatgpt/gpt-5.6-sol")).toBe(true);
    expect(modelProvider.matchModelSlug("chatgpt-web/gpt-5")).toBe(false);

    const registry = ModelRegistry.getInstance();
    expect(registry.findProvider("chatgpt/gpt-6.2")?.id).toBe("chatgpt");
    expect(registry.findProvider("chatgpt/gpt-6")?.id).toBe("chatgpt");
    expect(registry.findProvider("chatgpt/gpt-5.6-sol")?.id).toBe("chatgpt");
    expect(registry.findProvider("chatgpt")?.id).toBe("chatgpt");
    expect(registry.findRoute("chatgpt")?.slug).toBe(CHATGPT_DEFAULT_MODEL_SLUG);

    const adapterRegistry = AdapterRegistry.getInstance();
    expect(adapterRegistry.has("chatgpt")).toBe(true);
    const adapter = adapterRegistry.createAdapter("chatgpt");
    expect(adapter).toBeInstanceOf(ChatGptAdapter);
    expect(adapter).toBeInstanceOf(WebProviderAdapter);
    expect(adapter.name).toBe("chatgpt");
  });

  test("resolveThinkingEffort & resolveCapabilityTarget ánh xạ chuẩn Instant (none) / Medium / High", () => {
    const provider = ChatGptModelProvider.getInstance();

    expect(provider.resolveThinkingEffort("chatgpt/gpt-6.2", "low")).toBe("none");
    expect(provider.resolveThinkingEffort("chatgpt/gpt-6.2", "medium")).toBe("medium");
    expect(provider.resolveThinkingEffort("chatgpt/gpt-6.2", "high")).toBe("high");
    expect(provider.resolveThinkingEffort("chatgpt/gpt-6.2", undefined)).toBe("medium");

    expect(provider.resolveCapabilityTarget("chatgpt/gpt-6.2", "high")).toEqual({
      modelSlug: "chatgpt/gpt-6.2",
      modelLabel: "GPT-6.2",
      shortUiVersion: undefined,
      isAccountDefault: true,
      thinkingEffort: "high",
    });

    expect(provider.resolveCapabilityTarget("chatgpt/gpt-6", "low")).toEqual({
      modelSlug: "chatgpt/gpt-6",
      modelLabel: "GPT-6",
      shortUiVersion: "6",
      isAccountDefault: undefined,
      thinkingEffort: "none",
    });

    expect(provider.resolveCapabilityTarget("chatgpt/gpt-5.6-sol", "medium")).toEqual({
      modelSlug: "chatgpt/gpt-5.6-sol",
      modelLabel: "GPT-5.6 Sol",
      shortUiVersion: "5.6",
      isAccountDefault: undefined,
      thinkingEffort: "medium",
    });
  });
});
