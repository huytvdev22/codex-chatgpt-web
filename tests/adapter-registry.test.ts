import { expect, test } from "bun:test";
import { AdapterRegistry } from "../src/adapters/adapter-registry";
import type { ProviderAdapter } from "../src/adapters/base";

test("AdapterRegistry resolves registered default m365-copilot adapter and rejects unknown providerId", () => {
  const registry = AdapterRegistry.getInstance();
  expect(registry.has("m365-copilot")).toBe(true);
  expect(registry.listProviderIds()).toContain("m365-copilot");

  const adapter = registry.createAdapter("m365-copilot");
  expect(adapter.name).toBe("m365-copilot");
  expect(() => registry.createAdapter("unknown-provider")).toThrow(
    "No adapter factory registered for provider 'unknown-provider'.",
  );
});

test("AdapterRegistry supports registering custom ProviderAdapter factories dynamically", () => {
  const stubAdapter: ProviderAdapter = {
    name: "custom-web",
    async runTurn(_parsed, _incoming, emit) {
      emit({ type: "done" });
    },
  };
  const registry = new AdapterRegistry();
  registry.register("custom-web", () => stubAdapter);

  expect(registry.has("custom-web")).toBe(true);
  expect(registry.createAdapter("custom-web")).toBe(stubAdapter);
});

