import { expect, test } from "bun:test";
import {
  parseOpenAIChatRequest,
  buildOpenAIModelCatalog,
  isOpenAIModelsRequest,
  handleOpenAIChatCompletions,
} from "../src/openai-compat";

test("buildOpenAIModelCatalog returns OpenAI format models list", () => {
  const catalog = buildOpenAIModelCatalog();
  expect(catalog.object).toBe("list");
  expect(Array.isArray(catalog.data)).toBeTrue();
  expect(catalog.data.length).toBeGreaterThanOrEqual(1);

  const gpt5 = catalog.data.find(m => m.id === "m365-copilot/gpt-5");
  expect(gpt5).toBeDefined();
  expect(gpt5?.object).toBe("model");
  expect(gpt5?.owned_by).toBe("microsoft");
});

test("isOpenAIModelsRequest detects Cursor and OpenAI clients", () => {
  // Cursor User-Agent
  const cursorReq = new Request("http://127.0.0.1:17841/v1/models", {
    headers: { "user-agent": "Cursor/0.45.0" },
  });
  expect(isOpenAIModelsRequest(cursorReq)).toBeTrue();

  // Dummy Bearer auth
  const dummyAuthReq = new Request("http://127.0.0.1:17841/v1/models", {
    headers: { authorization: "Bearer dummy" },
  });
  expect(isOpenAIModelsRequest(dummyAuthReq)).toBeTrue();

  // OpenAI query format
  const queryReq = new Request("http://127.0.0.1:17841/v1/models?format=openai");
  expect(isOpenAIModelsRequest(queryReq)).toBeTrue();

  // First party Codex client
  const codexReq = new Request("http://127.0.0.1:17841/v1/models", {
    headers: { "user-agent": "codex_cli_rs/1.0.0", authorization: "Bearer codex-real-session" },
  });
  expect(isOpenAIModelsRequest(codexReq)).toBeFalse();
});

test("parseOpenAIChatRequest maps messages and options into CodexParsedRequest", () => {
  const raw = {
    model: "m365-copilot/gpt-5",
    messages: [
      { role: "system", content: "You are a coding assistant" },
      { role: "user", content: "Write a hello world program" },
      { role: "assistant", content: "console.log('hello world')" },
      { role: "user", content: "Now explain it" },
    ],
    temperature: 0.5,
    max_tokens: 2048,
    stream: false,
  };

  const { parsed, requestedModel } = parseOpenAIChatRequest(raw);
  expect(requestedModel).toBe("m365-copilot/gpt-5");
  expect(parsed.modelId).toBe("m365-copilot/gpt-5");
  expect(parsed.context.systemPrompt).toEqual(["You are a coding assistant"]);
  expect(parsed.context.messages.length).toBe(3);
  expect(parsed.context.messages[0].role).toBe("user");
  expect(parsed.context.messages[0].content).toBe("Write a hello world program");
  expect(parsed.context.messages[1].role).toBe("assistant");
  expect(parsed.context.messages[2].role).toBe("user");
  expect(parsed.options.temperature).toBe(0.5);
  expect(parsed.options.maxOutputTokens).toBe(2048);
  expect(parsed.stream).toBeFalse();
});

test("parseOpenAIChatRequest falls back to m365-copilot/gpt-5 if model is arbitrary", () => {
  const raw = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hi" }],
  };

  const { parsed, requestedModel } = parseOpenAIChatRequest(raw);
  expect(requestedModel).toBe("gpt-4o");
  expect(parsed.modelId).toBe("m365-copilot/gpt-5");
});

test("handleOpenAIChatCompletions rejects invalid JSON or empty messages", async () => {
  const invalidReq = new Request("http://127.0.0.1:17841/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
  const res1 = await handleOpenAIChatCompletions(invalidReq);
  expect(res1.status).toBe(400);

  const emptyMessagesReq = new Request("http://127.0.0.1:17841/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m365-copilot/gpt-5", messages: [] }),
  });
  const res2 = await handleOpenAIChatCompletions(emptyMessagesReq);
  expect(res2.status).toBe(400);
});

test("server routes GET /v1/models to OpenAI catalog when requested by Cursor", async () => {
  const { startServer } = await import("../src/server");
  const { defaultConfig } = await import("../src/config");

  const server = startServer({ ...defaultConfig("browser-only"), port: 0 });
  const endpoint = `http://127.0.0.1:${server.port}`;

  try {
    // 1. Cursor UA
    const resCursor = await fetch(`${endpoint}/v1/models`, {
      headers: { "user-agent": "Cursor/0.45.0" },
    });
    expect(resCursor.status).toBe(200);
    const catalog1 = await resCursor.json() as Record<string, any>;
    expect(catalog1.object).toBe("list");
    expect(catalog1.data.some((m: any) => m.id === "m365-copilot/gpt-5")).toBeTrue();

    // 2. Dummy auth
    const resDummy = await fetch(`${endpoint}/v1/models`, {
      headers: { authorization: "Bearer dummy" },
    });
    expect(resDummy.status).toBe(200);
    const catalog2 = await resDummy.json() as Record<string, any>;
    expect(catalog2.object).toBe("list");
    expect(catalog2.data.some((m: any) => m.id === "m365-copilot/gpt-5")).toBeTrue();

    // 3. POST /v1/chat/completions with empty messages returns 400
    const resChat = await fetch(`${endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m365-copilot/gpt-5", messages: [] }),
    });
    expect(resChat.status).toBe(400);
  } finally {
    await server.stop(true);
  }
});

test("compileM365Prompt does not inject Codex tool prompt in OpenAI-compat mode", async () => {
  const { compileM365Prompt } = await import("../src/adapters/m365-copilot/prompt");

  // 1. OpenAI-compat request (từ Cline / Cursor)
  const openAIReq = parseOpenAIChatRequest({
    model: "m365-copilot/gpt-5",
    messages: [
      { role: "system", content: "You are Cline, an AI coding agent." },
      { role: "user", content: "Tìm tất cả chỗ sử dụng UserService" },
    ],
  }).parsed;

  expect(openAIReq._openAICompat).toBeTrue();
  const compiledOpenAI = compileM365Prompt(openAIReq);

  // Không được chứa tool instructions của Codex
  expect(compiledOpenAI).not.toContain("[Tool Instructions]");
  expect(compiledOpenAI).not.toContain("[HỆ THỐNG CÔNG CỤ TỰ ĐỘNG - TOOL CALLING PROTOCOL]");
  expect(compiledOpenAI).not.toContain("[Yêu cầu định dạng đầu ra]");
  expect(compiledOpenAI).not.toContain("<tool_call>");

  // Phải giữ nguyên System Instructions của Cline và câu hỏi của user
  expect(compiledOpenAI).toContain("You are Cline, an AI coding agent.");
  expect(compiledOpenAI).toContain("Tìm tất cả chỗ sử dụng UserService");

  // 2. Codex request (khi có tools)
  const codexReq = {
    modelId: "m365-copilot/gpt-5",
    context: {
      systemPrompt: ["You are Codex."],
      messages: [{ role: "user" as const, content: "Hello", timestamp: Date.now() }],
      tools: [{ name: "run_command", description: "Run command", parameters: {} }],
    },
    stream: false,
    options: {},
  };
  const compiledCodex = compileM365Prompt(codexReq);
  expect(compiledCodex).toContain("[Tool Instructions]");
  expect(compiledCodex).toContain("[Yêu cầu định dạng đầu ra]");
});
