import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { modelsRequest } from "../src/server";

test("catalog diagnostics record safe failure when contextOverride throws", async () => {
  const request = new Request("http://127.0.0.1/v1/models", {
    headers: { authorization: "Bearer fixture" },
  });
  let failure: unknown;
  const response = await modelsRequest(
    request,
    defaultConfig("browser-only"),
    () => {
      throw new DOMException("internal cancellation", "AbortError");
    },
    result => {
      failure = result;
    },
  );
  expect(request.signal.aborted).toBeFalse();
  expect(response.status).toBe(500);
  expect(failure).toEqual({ stage: "catalog", code: "ABORT_ERR" });
});

test("returns only registered adapter models locally without native fallback", async () => {
  const request = new Request("http://127.0.0.1:17841/v1/models?client_version=1.2.3", {
    headers: { authorization: "Bearer codex-oauth-token" },
  });
  const config = defaultConfig("browser-only");
  config.subagentProtocol = "native";
  const response = await modelsRequest(request, config);

  expect(response.status).toBe(200);
  const body = await response.json() as {
    models: Array<{
      slug: string;
      context_window?: number;
      max_context_window?: number;
      auto_compact_token_limit?: number;
      supported_in_api?: boolean;
      multi_agent_version?: string;
    }>;
  };
  const slugs = body.models.map(model => model.slug);
  expect(slugs).toEqual([
    "m365-copilot/gpt-5.6",
    "m365-copilot",
    "ai-studio/gemini-4-hydrogen",
    "gemini/4-hydrogen",
    "gemini/4-neon",
    "chatgpt/gpt-6.2",
    "chatgpt/gpt-6",
    "chatgpt/gpt-5.6-sol",
  ]);
  expect(slugs.some(slug => slug === "gpt-5.6-sol" || slug === "gpt-5.5")).toBe(false);
  expect(slugs.some(slug => slug === "chatgpt-web" || slug.startsWith("chatgpt-web/"))).toBe(false);

  const m365Default = body.models.find(model => model.slug === "m365-copilot");
  expect(m365Default).toBeDefined();
  expect(m365Default!.context_window).toBe(100_000);
  expect(m365Default!.max_context_window).toBe(100_000);
});

test("M365 model catalog does not expose chatgpt-web routes even if legacy flags exist in loaded JSON", async () => {
  const config = defaultConfig("browser-only");
  const response = await modelsRequest(
    new Request("http://127.0.0.1:17841/v1/models", {
      headers: { authorization: "Bearer codex-oauth-token" },
    }),
    config,
  );

  expect(response.status).toBe(200);
  const body = await response.json() as { models: Array<{ slug: string }> };
  const slugs = body.models.map(model => model.slug);
  expect(slugs).toContain("m365-copilot");
  expect(slugs).toContain("m365-copilot/gpt-5.6");
  expect(slugs.some(slug => slug.startsWith("chatgpt-web"))).toBe(false);
});
