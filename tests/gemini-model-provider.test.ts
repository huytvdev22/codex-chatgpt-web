import { describe, expect, test } from "bun:test";
import { AdapterRegistry } from "../src/adapters/adapter-registry";
import {
  GEMINI_DEFAULT_MODEL_SLUG,
  GeminiAdapter,
  GeminiModelProvider,
} from "../src/adapters/gemini";
import { WebProviderAdapter } from "../src/adapters/web/web-provider-adapter";
import { ModelRegistry } from "../src/models/model-registry";

describe("GeminiModelProvider & Registry integration", () => {
  test("đăng ký đầy đủ 2 model Gemini trong ModelRegistry & AdapterRegistry và giữ alias gemini", () => {
    const modelProvider = GeminiModelProvider.getInstance();
    expect(modelProvider.id).toBe("gemini");
    expect(modelProvider.routes.map((route) => route.slug)).toEqual([
      "gemini/4-hydrogen",
      "gemini/4-neon",
    ]);
    expect(modelProvider.routes[0]?.contextWindow).toBe(1_000_000);
    expect(modelProvider.routes[0]?.autoCompactTokenLimit).toBe(900_000);
    expect(modelProvider.routes[0]?.defaultReasoningLevel).toBe("medium");

    expect(modelProvider.matchModelSlug("gemini")).toBe(true);
    expect(modelProvider.matchModelSlug("gemini/4-hydrogen")).toBe(true);
    expect(modelProvider.matchModelSlug("gemini/4-neon")).toBe(true);
    expect(modelProvider.matchModelSlug("gemini-pro")).toBe(false);

    const registry = ModelRegistry.getInstance();
    expect(registry.findProvider("gemini")?.id).toBe("gemini");
    expect(registry.findProvider("gemini/4-hydrogen")?.id).toBe("gemini");
    expect(registry.findProvider("gemini/4-neon")?.id).toBe("gemini");
    expect(registry.findRoute("gemini")?.slug).toBe(GEMINI_DEFAULT_MODEL_SLUG);

    const adapterRegistry = AdapterRegistry.getInstance();
    expect(adapterRegistry.has("gemini")).toBe(true);
    const adapter = adapterRegistry.createAdapter("gemini");
    expect(adapter).toBeInstanceOf(GeminiAdapter);
    expect(adapter).toBeInstanceOf(WebProviderAdapter);
    expect(adapter.name).toBe("gemini");
  });

  test("resolveThinkingEffort & resolveCapabilityTarget ánh xạ Low / Medium / High và buildRouteFromDiscovered", () => {
    const provider = GeminiModelProvider.getInstance();

    expect(provider.resolveThinkingEffort("gemini/4-hydrogen", "low")).toBe("low");
    expect(provider.resolveThinkingEffort("gemini/4-hydrogen", "medium")).toBe("medium");
    expect(provider.resolveThinkingEffort("gemini/4-hydrogen", "high")).toBe("high");
    expect(provider.resolveThinkingEffort("gemini", undefined)).toBe("medium");

    expect(provider.resolveCapabilityTarget("gemini/4-hydrogen", "high")).toEqual({
      modelSlug: "gemini/4-hydrogen",
      modelLabel: "4 Hydrogen",
      isAccountDefault: true,
      thinkingEffort: "high",
    });

    expect(provider.resolveCapabilityTarget("gemini/4-neon", "medium")).toEqual({
      modelSlug: "gemini/4-neon",
      modelLabel: "4 Neon",
      isAccountDefault: undefined,
      thinkingEffort: "medium",
    });

    const discoveredRoute = provider.buildRouteFromDiscovered({
      slug: "gemini/auto",
      providerId: "gemini",
      displayName: "Gemini Web - Auto",
      uiLabel: "Auto",
      remoteModelId: "8c46e95b1a07cecc",
      isAccountDefault: false,
      contextWindow: 1_000_000,
    });
    expect(discoveredRoute).toMatchObject({
      slug: "gemini/auto",
      uiLabel: "Auto",
      remoteModelId: "8c46e95b1a07cecc",
      isAccountDefault: false,
      contextWindow: 1_000_000,
      autoCompactTokenLimit: 900_000,
    });
  });
});
