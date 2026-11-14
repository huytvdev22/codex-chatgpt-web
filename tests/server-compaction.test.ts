import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { compactRequest } from "../src/server";

test("compactRequest forwards m365-copilot compaction to the adapter with stream=false", async () => {
  const seen: Array<{ model: string; stream: boolean; hasCompactionTrigger: boolean }> = [];
  const response = await compactRequest(
    new Request("http://127.0.0.1/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m365-copilot",
        stream: true,
        input: [{ role: "user", content: "Summarize prior work" }],
      }),
    }),
    defaultConfig("browser-only"),
    () => ({
      name: "m365-stub",
      async runTurn(parsed, _incoming, emit) {
        const body = parsed._rawBody as { input?: unknown[] };
        const rawInput = Array.isArray(body.input) ? body.input : [];
        seen.push({
          model: parsed.modelId,
          stream: parsed.stream,
          hasCompactionTrigger: rawInput.some(
            item => typeof item === "object" && item !== null && (item as { type?: unknown }).type === "compaction_trigger",
          ),
        });
        emit({ type: "text_delta", text: "Compacted summary." });
        emit({ type: "done" });
      },
    }),
  );

  expect(response.status).toBe(200);
  expect(seen).toEqual([{
    model: "m365-copilot",
    stream: false,
    hasCompactionTrigger: true,
  }]);
  const body = await response.json() as { output?: Array<{ content?: Array<{ text?: string }> }> };
  expect(body.output?.[0]?.content?.[0]?.text).toBe("Compacted summary.");
});

test("compactRequest preserves canonical Codex turn metadata from the header", async () => {
  let boundIdentity: { threadId: string; turnId: string } | undefined;
  const response = await compactRequest(
    new Request("http://127.0.0.1/v1/responses/compact", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_compact_m365",
          turn_id: "turn_compact_m365",
        }),
      },
      body: JSON.stringify({
        model: "m365-copilot/gpt-5.6",
        input: [{ role: "user", content: "Compact thread" }],
      }),
    }),
    defaultConfig("browser-only"),
    () => ({
      name: "m365-stub",
      async runTurn(_parsed, _incoming, emit) {
        emit({ type: "text_delta", text: "Done." });
        emit({ type: "done" });
      },
    }),
    {
      onTurnIdentity: identity => {
        boundIdentity = identity;
      },
    },
  );

  expect(response.status).toBe(200);
  expect(boundIdentity).toEqual({
    threadId: "thread_compact_m365",
    turnId: "turn_compact_m365",
  });
});

test("compactRequest rejects missing or unsupported models with HTTP 400", async () => {
  const config = defaultConfig("browser-only");
  for (const model of ["chatgpt-web/luna", "gpt-5.6-sol"]) {
    const response = await compactRequest(
      new Request("http://127.0.0.1/v1/responses/compact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: [] }),
      }),
      config,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: `Unsupported model '${model}'. Enabled providers: m365-copilot.`,
      },
    });
  }

  const missingModel = await compactRequest(
    new Request("http://127.0.0.1/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: [] }),
    }),
    config,
  );
  expect(missingModel.status).toBe(400);
});
