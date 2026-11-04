import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { modelsRequest } from "../src/server";

test("catalog diagnostics preserve safe causes without attributing an upstream abort to the client", async () => {
  for (const [error, code] of [
    [new DOMException("internal cancellation", "AbortError"), "ABORT_ERR"],
    [new DOMException("deadline", "TimeoutError"), "ETIMEDOUT"],
    [new TypeError("private error message", { cause: { code: "ECONNRESET" } }), "ECONNRESET"],
    [{ code: "ConnectionRefused" }, "ConnectionRefused"],
    [{ code: "https://private.example/token", cause: { code: "/private/key" } }, undefined],
  ] as const) {
    const request = new Request("http://127.0.0.1/v1/models", { headers: { authorization: "Bearer fixture" } });
    let failure: unknown;
    const response = await modelsRequest(request, defaultConfig("browser-only"), async () => { throw error; },
      undefined, result => { failure = result; });
    expect(request.signal.aborted).toBeFalse();
    expect(response.status).toBe(502);
    expect(failure).toEqual({ stage: "transport", ...(code ? { code } : {}) });
  }
});

test("proxies official /models auth and query, then appends grouped and legacy Web models", async () => {
  const request = new Request("http://127.0.0.1:17841/v1/models?client_version=1.2.3", {
    headers: { authorization: "Bearer codex-oauth-token", "if-none-match": "native-etag" },
  });
  let upstream: Request | undefined;
  const config = defaultConfig("full");
  config.subagentProtocol = "native";
  config.extraHighAvailable = true;
  config.proAvailable = true;
  const response = await modelsRequest(request, config, async input => {
    upstream = input;
    return Response.json({
      models: [{
        slug: "gpt-5.6-sol",
        display_name: "5.6 Sol",
        priority: 1,
        visibility: "list",
        supported_in_api: true,
        multi_agent_version: "v2",
        supported_reasoning_levels: [],
        tool_mode: "code_mode_only",
        context_window: 300_000,
        max_context_window: 320_000,
        auto_compact_token_limit: 270_000,
      }],
    }, { headers: { etag: "native-etag" } });
  }, () => ({ contextWindow: 371_851 }));

  expect(upstream!.url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=1.2.3");
  expect(upstream!.method).toBe("GET");
  expect(upstream!.headers.get("authorization")).toBe("Bearer codex-oauth-token");
  expect(upstream!.headers.get("if-none-match")).toBeNull();
  expect(response.headers.get("etag")).not.toBe("native-etag");
  const body = await response.json() as {
    models: Array<{
      slug: string;
      context_window?: number;
      max_context_window?: number;
      effective_context_window_percent?: number;
      auto_compact_token_limit?: number;
      supported_in_api?: boolean;
      priority?: number;
      multi_agent_version?: string;
    }>;
  };
  const slugs = body.models.map(model => model.slug);
  expect(slugs).toContain("gpt-5.6-sol");
  expect(slugs).toContain("chatgpt-web");
  expect(slugs).toContain("m365-copilot");
  expect(slugs).toContain("gemini-web");
  expect(slugs).toContain("qwen-web");
  expect(body.models[0]!.context_window).toBe(300_000);
  expect(body.models[0]!.max_context_window).toBe(371_851);
  expect(body.models[0]!.auto_compact_token_limit).toBe(270_000);
  expect(body.models[0]!.multi_agent_version).toBe("v2");
});

test("Luna-only account exposes no paid ChatGPT Web routes", async () => {
  const config = defaultConfig("browser-only");
  config.solAvailable = false;
  const response = await modelsRequest(
    new Request("http://127.0.0.1:17841/v1/models", {
      headers: { authorization: "Bearer codex-oauth-token" },
    }),
    config,
    async () => Response.json({
      models: [{
        slug: "gpt-5.6-sol",
        display_name: "5.6 Sol",
        visibility: "list",
        supported_in_api: true,
        supported_reasoning_levels: [{ effort: "low", description: "Low" }],
        tool_mode: "code_mode_only",
      }],
    }),
  );
  const body = await response.json() as { models: Array<{ slug: string }> };
  expect(body.models.some(model => model.slug === "chatgpt-web")).toBe(true);
  expect(body.models.some(model => model.slug === "qwen-web")).toBe(true);
});

test("legacy account flags still return one unified ChatGPT Web row", async () => {
  const config = defaultConfig("browser-only");
  config.browserInteractionMode = "manual";
  config.solAvailable = true;
  config.extraHighAvailable = true;
  config.proAvailable = true;
  const response = await modelsRequest(
    new Request("http://127.0.0.1:17841/v1/models", {
      headers: { authorization: "Bearer codex-oauth-token" },
    }),
    config,
    async () => Response.json({
      models: [{
        slug: "gpt-5.6-sol",
        display_name: "5.6 Sol",
        visibility: "list",
        supported_in_api: true,
        supported_reasoning_levels: [{ effort: "low", description: "Low" }],
        tool_mode: "code_mode_only",
      }],
    }),
  );

  expect(response.status).toBe(200);
  const body = await response.json() as { models: Array<Record<string, unknown> & { slug: string }> };
  expect(body.models.filter(model =>
    model.slug === "chatgpt-web" || model.slug.startsWith("chatgpt-web/")
  )).toEqual([{
    slug: "chatgpt-web",
    display_name: "ChatGPT (Web)",
    description: "ChatGPT Web với chế độ thường hoặc suy nghĩ.",
    visibility: "list",
    supported_in_api: true,
    supported_reasoning_levels: [
      { effort: "low", description: "Normal" },
      { effort: "high", description: "Thinking" },
    ],
    tool_mode: null,
    upgrade: null,
    default_reasoning_level: "low",
    input_modalities: ["text", "image"],
    context_window: 100_000,
    max_context_window: 100_000,
    effective_context_window_percent: 90,
    auto_compact_token_limit: 90_000,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    support_verbosity: true,
    multi_agent_version: "v1",
  }]);
});

test("ChatGPT-only native catalog rows do not turn model discovery into a 502", async () => {
  const config = defaultConfig("browser-only");
  const response = await modelsRequest(
    new Request("http://127.0.0.1:17841/v1/models?client_version=0.147.0", {
      headers: { authorization: "Bearer chatgpt-session-token" },
    }),
    config,
    async () => Response.json({
      models: [{
        slug: "gpt-chatgpt-only",
        display_name: "ChatGPT only",
        visibility: "list",
        supported_in_api: false,
        supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
        tool_mode: null,
      }],
    }),
  );

  expect(response.status).toBe(200);
  const body = await response.json() as { models: Array<{ slug: string; supported_in_api?: boolean }> };
  expect(body.models[0]).toMatchObject({ slug: "gpt-chatgpt-only", supported_in_api: false });
  expect(body.models.some(model => model.slug === "chatgpt-web")).toBe(true);
  expect(body.models.some(model => model.slug === "qwen-web")).toBe(true);
});

test("API Key auth returns augmented model catalog with M365 models without calling upstream", async () => {
  const config = defaultConfig("full");
  let upstreamCalled = false;
  const response = await modelsRequest(
    new Request("http://127.0.0.1:17842/v1/models", {
      headers: { authorization: "Bearer sk-dummy-key-for-offline-m365" },
    }),
    config,
    async () => {
      upstreamCalled = true;
      throw new Error("Upstream should not be called with API Key in offline mode");
    },
  );

  expect(upstreamCalled).toBe(false);
  expect(response.status).toBe(200);
  const body = await response.json() as { models: Array<{ slug: string }> };
  const slugs = body.models.map(m => m.slug);
  expect(slugs).toContain("m365-copilot");
  expect(slugs).toContain("m365-copilot/gpt-5.6");
  expect(slugs).toContain("gpt-5.6-sol");
});
