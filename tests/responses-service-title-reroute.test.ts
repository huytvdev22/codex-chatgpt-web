import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry } from "../src/adapters/adapter-registry";
import type { ProviderAdapter } from "../src/adapters/base";
import { readCodexConfiguredModel } from "../src/codex-integration-document";
import { ModelRegistry } from "../src/models/model-registry";
import {
  ResponsesService,
  isCodexThreadTitleRequest,
} from "../src/services/responses-service";
import type { CodexParsedRequest } from "../src/types";

function makeTitleRequestPayload(model = "m365-copilot/gpt-5.6") {
  return {
    model,
    stream: false,
    input: [
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "You are Codex, a coding assistant." }],
      },
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.",
          },
        ],
      },
    ],
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        strict: true,
        name: "codex_output_schema",
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
          },
          required: ["title", "description"],
          additionalProperties: false,
        },
      },
    },
  };
}

function makeNormalRequestPayload(model: string) {
  return {
    model,
    stream: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "xin chào" }],
      },
    ],
  };
}

describe("ResponsesService Codex thread-title rerouting", () => {
  test("isCodexThreadTitleRequest chỉ khớp đúng request sinh tiêu đề codex_output_schema", () => {
    expect(isCodexThreadTitleRequest(makeTitleRequestPayload())).toBe(true);
    expect(isCodexThreadTitleRequest(makeNormalRequestPayload("m365-copilot/gpt-5.6"))).toBe(false);
    expect(
      isCodexThreadTitleRequest({
        ...makeTitleRequestPayload(),
        previous_response_id: "resp_123",
      }),
    ).toBe(false);
    expect(
      isCodexThreadTitleRequest({
        ...makeTitleRequestPayload(),
        text: {
          format: {
            type: "json_schema",
            name: "other_schema",
            schema: { properties: { answer: { type: "string" } } },
          },
        },
      }),
    ).toBe(false);
  });

  test("định tuyến lại request sinh tiêu đề bị fallback sang m365-copilot/gpt-5.6 về model cấu hình trong config.toml", async () => {
    const dispatched: Array<{ providerId: string; modelId: string }> = [];
    const makeStubAdapter = (providerId: string): ProviderAdapter => ({
      name: providerId,
      async runTurn(parsed: CodexParsedRequest, _incoming, emit) {
        dispatched.push({ providerId, modelId: parsed.modelId });
        emit({ type: "text_delta", text: '{"title":"Xin chào","description":"Chào hỏi"}' });
        emit({ type: "done" });
      },
    });

    const adapterRegistry = new AdapterRegistry([
      ["m365-copilot", () => makeStubAdapter("m365-copilot")],
      ["ai-studio", () => makeStubAdapter("ai-studio")],
    ]);
    const service = new ResponsesService(
      ModelRegistry.getInstance(),
      adapterRegistry,
      () => "ai-studio/gemini-4-hydrogen",
    );

    const payload = makeTitleRequestPayload("m365-copilot/gpt-5.6");
    const res = await service.executeTurn({
      req: new Request("http://127.0.0.1:17841/v1/responses", { method: "POST" }),
      raw: payload,
      requestedModel: "m365-copilot/gpt-5.6",
      providerId: "m365-copilot",
      options: { rememberState: false },
    });

    expect(res.status).toBe(200);
    expect(dispatched).toEqual([
      { providerId: "ai-studio", modelId: "ai-studio/gemini-4-hydrogen" },
    ]);
  });

  test("ưu tiên model của turn chính gần nhất và không đổi hướng request thông thường", async () => {
    const dispatched: Array<{ providerId: string; modelId: string }> = [];
    const makeStubAdapter = (providerId: string): ProviderAdapter => ({
      name: providerId,
      async runTurn(parsed: CodexParsedRequest, _incoming, emit) {
        dispatched.push({ providerId, modelId: parsed.modelId });
        emit({
          type: "text_delta",
          text: '{"title":"M365 Task","description":"Tác vụ M365"}',
        });
        emit({ type: "done" });
      },
    });

    const adapterRegistry = new AdapterRegistry([
      ["m365-copilot", () => makeStubAdapter("m365-copilot")],
      ["ai-studio", () => makeStubAdapter("ai-studio")],
    ]);
    // Giả lập config.toml là ai-studio, nhưng người dùng vừa chạy turn chính bằng m365-copilot/gpt-5.6
    const service = new ResponsesService(
      ModelRegistry.getInstance(),
      adapterRegistry,
      () => "ai-studio/gemini-4-hydrogen",
    );

    await service.executeTurn({
      req: new Request("http://127.0.0.1:17841/v1/responses", { method: "POST" }),
      raw: makeNormalRequestPayload("m365-copilot/gpt-5.6"),
      requestedModel: "m365-copilot/gpt-5.6",
      providerId: "m365-copilot",
      options: { rememberState: false },
    });

    await service.executeTurn({
      req: new Request("http://127.0.0.1:17841/v1/responses", { method: "POST" }),
      raw: makeTitleRequestPayload("m365-copilot/gpt-5.6"),
      requestedModel: "m365-copilot/gpt-5.6",
      providerId: "m365-copilot",
      options: { rememberState: false },
    });

    // Giờ người dùng chạy turn chính bằng ai-studio/gemini-4-hydrogen -> title turn sau đó đi theo ai-studio
    await service.executeTurn({
      req: new Request("http://127.0.0.1:17841/v1/responses", { method: "POST" }),
      raw: makeNormalRequestPayload("ai-studio/gemini-4-hydrogen"),
      requestedModel: "ai-studio/gemini-4-hydrogen",
      providerId: "ai-studio",
      options: { rememberState: false },
    });

    await service.executeTurn({
      req: new Request("http://127.0.0.1:17841/v1/responses", { method: "POST" }),
      raw: makeTitleRequestPayload("m365-copilot/gpt-5.6"),
      requestedModel: "m365-copilot/gpt-5.6",
      providerId: "m365-copilot",
      options: { rememberState: false },
    });

    expect(dispatched).toEqual([
      { providerId: "m365-copilot", modelId: "m365-copilot/gpt-5.6" },
      { providerId: "m365-copilot", modelId: "m365-copilot/gpt-5.6" },
      { providerId: "ai-studio", modelId: "ai-studio/gemini-4-hydrogen" },
      { providerId: "ai-studio", modelId: "ai-studio/gemini-4-hydrogen" },
    ]);
  });

  test("readCodexConfiguredModel đọc đúng top-level model trong config.toml", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "codex-cfg-model-"));
    const prevCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = tempHome;
      expect(readCodexConfiguredModel()).toBeUndefined();

      writeFileSync(
        join(tempHome, "config.toml"),
        'model = "ai-studio/gemini-4-hydrogen"\nmodel_reasoning_effort = "high"\n',
        "utf8",
      );
      expect(readCodexConfiguredModel()).toBe("ai-studio/gemini-4-hydrogen");
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
