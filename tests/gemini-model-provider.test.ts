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
  test("đăng ký GeminiModelProvider & GeminiAdapter trong ModelRegistry & AdapterRegistry", () => {
    const modelProvider = GeminiModelProvider.getInstance();
    expect(modelProvider.id).toBe("gemini");
    expect(modelProvider.routes.map((route) => route.slug)).toEqual(["gemini"]);
    expect(modelProvider.routes[0]?.contextWindow).toBe(1_000_000);
    expect(modelProvider.routes[0]?.autoCompactTokenLimit).toBe(900_000);
    expect(modelProvider.routes[0]?.defaultReasoningLevel).toBe("medium");

    expect(modelProvider.matchModelSlug("gemini")).toBe(true);
    expect(modelProvider.matchModelSlug("gemini/4-neon")).toBe(true);
    expect(modelProvider.matchModelSlug("gemini-pro")).toBe(false);

    const registry = ModelRegistry.getInstance();
    expect(registry.findProvider("gemini")?.id).toBe("gemini");
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

    expect(provider.resolveThinkingEffort("gemini", "low")).toBe("low");
    expect(provider.resolveThinkingEffort("gemini", "medium")).toBe("medium");
    expect(provider.resolveThinkingEffort("gemini", "high")).toBe("high");
    expect(provider.resolveThinkingEffort("gemini", undefined)).toBe("medium");

    expect(provider.resolveCapabilityTarget("gemini", "high")).toEqual({
      modelSlug: "gemini",
      isAccountDefault: true,
      thinkingEffort: "high",
    });

    const discoveredRoute = provider.buildRouteFromDiscovered({
      slug: "gemini/4-neon",
      providerId: "gemini",
      displayName: "Gemini - 4 Neon",
      uiLabel: "4 Neon",
      remoteModelId: "e6fa609c3fa255c0",
      isAccountDefault: false,
      contextWindow: 1_000_000,
    });
    expect(discoveredRoute).toMatchObject({
      slug: "gemini/4-neon",
      uiLabel: "4 Neon",
      remoteModelId: "e6fa609c3fa255c0",
      isAccountDefault: false,
      contextWindow: 1_000_000,
      autoCompactTokenLimit: 900_000,
    });
  });
});
