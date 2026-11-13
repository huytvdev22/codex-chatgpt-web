import { expect, test } from "bun:test";
import { createConnection } from "node:net";
import { defaultConfig } from "../src/config";
import { compactRequest, HttpTurnCounter, responseRequest, startServer } from "../src/server";

async function waitForTurnCount(turns: HttpTurnCounter, expected: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (turns.count() !== expected && Date.now() < deadline) await Bun.sleep(5);
  expect(turns.count()).toBe(expected);
}

test("HTTP turn tracking follows the response stream instead of Bun's global request count", async () => {
  const turns = new HttpTurnCounter();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = await turns.track(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
    },
  })));
  const reader = response.body!.getReader();

  expect(turns.count()).toBe(1);
  source.enqueue(new TextEncoder().encode("data"));
  expect((await reader.read()).done).toBe(false);
  expect(turns.count()).toBe(1);
  source.close();
  expect((await reader.read()).done).toBe(true);
  await waitForTurnCount(turns, 0);
});

test("HTTP turn tracking releases a cancelled response stream", async () => {
  const failures: unknown[] = [];
  const turns = new HttpTurnCounter(failure => failures.push(failure));
  const request = new AbortController();
  const response = await turns.track(
    async () => new Response(new ReadableStream<Uint8Array>()),
    request.signal,
  );

  expect(turns.count()).toBe(1);
  const cancelled = response.body!.cancel();
  request.abort("client disconnected");
  await cancelled;
  await waitForTurnCount(turns, 0);
  expect(failures).toEqual([]);
});

test("HTTP turn tracking uses a tee branch on Windows", async () => {
  const turns = new HttpTurnCounter();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const original = new ReadableStream<Uint8Array>({
    start(controller) { source = controller; },
  });
  const response = await turns.track(async () => new Response(original), undefined, "win32");
  const reader = response.body!.getReader();

  source.enqueue(new TextEncoder().encode("safe"));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("safe");
  source.close();
  expect((await reader.read()).done).toBe(true);
  await waitForTurnCount(turns, 0);
});

test("HTTP turn tracking uses direct pull and cancellation outside Windows", async () => {
  const turns = new HttpTurnCounter();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let sourceCancelled = false;
  const original = new ReadableStream<Uint8Array>({
    start(controller) { source = controller; },
    cancel() { sourceCancelled = true; },
  });
  const response = await turns.track(async () => new Response(original), undefined, "darwin");
  const reader = response.body!.getReader();

  source.enqueue(new TextEncoder().encode("native-pull"));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("native-pull");
  await reader.cancel("client disconnected");
  await waitForTurnCount(turns, 0);
  expect(sourceCancelled).toBe(true);
});

test("HTTP turn tracking records privacy-safe client stream failure evidence", async () => {
  const failures: unknown[] = [];
  const turns = new HttpTurnCounter(failure => failures.push(failure));
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = await turns.track(
    async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
    })),
    undefined,
    "darwin",
    "responses",
  );
  const reader = response.body!.getReader();

  source.enqueue(new TextEncoder().encode("safe"));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("safe");
  source.error(Object.assign(new TypeError("private upstream response fragment"), { code: "ECONNRESET" }));
  await expect(reader.read()).rejects.toThrow("private upstream response fragment");
  await waitForTurnCount(turns, 0);

  expect(failures).toEqual([{
    httpTurnId: 1,
    endpoint: "responses",
    reader: "client",
    platform: "darwin",
    chunks: 1,
    bytes: 4,
    errorName: "TypeError",
    errorCode: "ECONNRESET",
  }]);
  expect(JSON.stringify(failures)).not.toContain("private upstream response fragment");
});

test("HTTP turn tracking records privacy-safe Windows lifecycle failure evidence", async () => {
  const failures: unknown[] = [];
  const turns = new HttpTurnCounter(failure => failures.push(failure));
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = await turns.track(
    async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
    })),
    undefined,
    "win32",
    "responses",
  );
  const reader = response.body!.getReader();

  source.enqueue(new TextEncoder().encode("event"));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("event");
  source.error(Object.assign(new TypeError("sensitive socket detail"), { code: "ECONNRESET" }));
  await expect(reader.read()).rejects.toThrow("sensitive socket detail");
  await waitForTurnCount(turns, 0);

  expect(failures).toEqual([{
    httpTurnId: 1,
    endpoint: "responses",
    reader: "windows_lifecycle",
    platform: "win32",
    chunks: 1,
    bytes: 5,
    errorName: "TypeError",
    errorCode: "ECONNRESET",
  }]);
  expect(JSON.stringify(failures)).not.toContain("sensitive socket detail");
});

test("HTTP stream diagnostics cannot replace the source failure or retain turn ownership", async () => {
  const turns = new HttpTurnCounter(() => { throw new Error("diagnostic sink failed"); });
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = await turns.track(
    async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
    })),
    undefined,
    "darwin",
    "responses",
  );
  const reader = response.body!.getReader();

  source.error(new TypeError("source connection reset"));
  await expect(reader.read()).rejects.toThrow("source connection reset");
  await waitForTurnCount(turns, 0);
});

test("HTTP turn tracking releases a stream whose client disconnected without cancelling", async () => {
  const turns = new HttpTurnCounter();
  const client = new AbortController();
  let cancelled = false;
  const response = await turns.track(
    async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    })),
    client.signal,
  );

  expect(turns.count()).toBe(1);
  client.abort();
  await Bun.sleep(0);
  expect(turns.count()).toBe(0);
  expect(cancelled).toBe(true);
  expect(response.body).not.toBeNull();
});

test("HTTP turn tracking releases a stream requested by an already disconnected client", async () => {
  const turns = new HttpTurnCounter();
  const client = new AbortController();
  client.abort();
  const response = await turns.track(async () => new Response(new ReadableStream<Uint8Array>()), client.signal);

  expect(turns.count()).toBe(0);
  expect(response.status).toBe(499);
  expect(response.body).toBeNull();
});

test("a real HTTP peer disconnect releases a streaming turn", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  let sourceCancelled = false;
  let markSourceReady!: () => void;
  const sourceReady = new Promise<void>(resolve => { markSourceReady = resolve; });
  const server = startServer(config, {
    adapterFactory: () => ({
      name: "m365-disconnect-stub",
      async runTurn(_parsed, incoming, emit) {
        emit({ type: "text_delta", text: "stream-open" });
        markSourceReady();
        await new Promise<void>(resolve => {
          if (incoming.abortSignal?.aborted) {
            sourceCancelled = true;
            resolve();
            return;
          }
          incoming.abortSignal?.addEventListener("abort", () => {
            sourceCancelled = true;
            resolve();
          }, { once: true });
        });
      },
    }),
  });
  const port = server.port;
  if (port === undefined) throw new Error("test server did not bind a TCP port");
  const endpoint = `http://127.0.0.1:${port}`;
  const socket = createConnection({ host: "127.0.0.1", port });

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const body = JSON.stringify({ model: "m365-copilot", stream: true, input: [{ role: "user", content: "disconnect lifecycle proof" }] });
    socket.write([
      "POST /v1/responses HTTP/1.1",
      "Host: 127.0.0.1",
      "Authorization: Bearer test-codex-session",
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: keep-alive",
      "",
      body,
    ].join("\r\n"));
    await sourceReady;
    await new Promise<void>((resolve, reject) => {
      socket.once("data", () => resolve());
      socket.once("error", reject);
    });

    expect(await (await fetch(`${endpoint}/healthz`)).json()).toMatchObject({ active_http_turns: 1 });
    socket.destroy();

    const deadline = Date.now() + 1_000;
    let activeHttpTurns = 1;
    while (Date.now() < deadline && activeHttpTurns !== 0) {
      const health = await (await fetch(`${endpoint}/healthz`)).json() as { active_http_turns: number };
      activeHttpTurns = health.active_http_turns;
      if (activeHttpTurns !== 0) await Bun.sleep(10);
    }
    expect(activeHttpTurns).toBe(0);
    expect(sourceCancelled).toBe(true);
  } finally {
    socket.destroy();
    await server.stop(true);
  }
});

test("HTTP turn cancellation aborts the tracked request and waits for lifecycle release", async () => {
  const turns = new HttpTurnCounter();
  let observedAbort = false;
  const tracked = turns.track(signal => new Promise<Response>((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      observedAbort = true;
      reject(signal.reason);
    }, { once: true });
  }));

  await waitForTurnCount(turns, 1);
  expect(await turns.cancelAll("launcher quit")).toBe(1);
  await expect(tracked).rejects.toBe("launcher quit");
  expect(observedAbort).toBe(true);
  expect(turns.count()).toBe(0);
});

test("native Codex interrupt cancels only HTTP streams owned by the exact thread and turn", async () => {
  const turns = new HttpTurnCounter();
  const started: Promise<Response>[] = [];
  const aborted: string[] = [];
  for (const identity of [
    { threadId: "thread_exact", turnId: "turn_exact" },
    { threadId: "thread_other", turnId: "turn_other" },
  ]) {
    started.push(turns.track((signal, bindIdentity) => {
      bindIdentity(identity);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted.push(identity.turnId);
          reject(signal.reason);
        }, { once: true });
      });
    }));
  }
  await waitForTurnCount(turns, 2);

  expect(await turns.cancelTurn({ threadId: "thread_exact", turnId: "turn_exact" })).toBe(1);
  expect(aborted).toEqual(["turn_exact"]);
  expect(turns.count()).toBe(1);
  await expect(started[0]!).rejects.toHaveProperty("name", "AbortError");

  expect(await turns.cancelAll()).toBe(1);
  await expect(started[1]!).rejects.toThrow("Active HTTP turns cancelled");
});

test("native Codex interrupt remains authoritative when it arrives before HTTP identity binding", async () => {
  const turns = new HttpTurnCounter();
  const identity = { threadId: "thread_interrupt_race", turnId: "turn_interrupt_race" };
  let bind!: () => void;
  const mayBind = new Promise<void>(resolve => { bind = resolve; });
  let observedAbort = false;
  const response = turns.track(async (signal, bindIdentity) => {
    await mayBind;
    bindIdentity(identity);
    observedAbort = signal.aborted;
    return new Response(new ReadableStream<Uint8Array>());
  });
  await waitForTurnCount(turns, 1);

  expect(await turns.cancelTurn(identity)).toBe(0);
  bind();
  expect((await response).status).toBe(499);
  expect(observedAbort).toBeTrue();
  await waitForTurnCount(turns, 0);
});

test("response and compaction requests expose their exact interrupt identity", async () => {
  const config = defaultConfig("browser-only");
  const responseIdentity = { threadId: "thread_native_response", turnId: "turn_native_response" };
  let boundResponseIdentity: typeof responseIdentity | undefined;
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: responseIdentity.threadId,
          turn_id: responseIdentity.turnId,
        }),
      },
      input: [],
    }),
  }), config, undefined, {
    onTurnIdentity: identity => { boundResponseIdentity = identity; },
  });
  expect(boundResponseIdentity).toEqual(responseIdentity);
  expect(response.status).toBe(400);

  const compactIdentity = { threadId: "thread_native_compact", turnId: "turn_native_compact" };
  let boundCompactIdentity: typeof compactIdentity | undefined;
  const compact = await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: compactIdentity.threadId,
        turn_id: compactIdentity.turnId,
      }),
    },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
  }), config, undefined, {
    onTurnIdentity: identity => { boundCompactIdentity = identity; },
  });
  expect(boundCompactIdentity).toEqual(compactIdentity);
  expect(compact.status).toBe(400);
});

test("a drained runtime rejects new model-catalog work before shutdown", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  const endpoint = `http://127.0.0.1:${server.port}`;
  const authorization = { authorization: `Bearer ${config.controlToken}` };
  try {
    const drain = await fetch(`${endpoint}/admin/drain`, {
      method: "POST",
      headers: authorization,
    });
    expect(drain.status).toBe(200);

    const models = await fetch(`${endpoint}/v1/models`);
    expect(models.status).toBe(503);
    expect(await models.json()).toMatchObject({
      error: {
        type: "server_error",
        message: "codex-chatgpt-web is draining for a requested service operation",
      },
    });

    const resume = await fetch(`${endpoint}/admin/resume`, {
      method: "POST",
      headers: authorization,
    });
    expect(resume.status).toBe(200);
  } finally {
    await server.stop(true);
  }
});

test("health proves that Codex received a successful augmented model catalog", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  const endpoint = `http://127.0.0.1:${server.port}`;
  try {
    expect(await (await fetch(`${endpoint}/healthz`)).json()).toMatchObject({
      successful_model_catalog_requests: 0,
      last_successful_model_catalog_request_at: null,
    });

    const models = await fetch(`${endpoint}/v1/models`, {
      headers: { authorization: "Bearer test-codex-session" },
    });
    expect(models.status).toBe(200);

    const health = await (await fetch(`${endpoint}/healthz`)).json() as Record<string, unknown>;
    expect(health.successful_model_catalog_requests).toBe(1);
    expect(typeof health.last_successful_model_catalog_request_at).toBe("string");
  } finally {
    await server.stop(true);
  }
});

test("authenticated shutdown requires a verified idle drain", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  const endpoint = `http://127.0.0.1:${server.port}`;
  const authorization = { authorization: `Bearer ${config.controlToken}` };

  try {
    const unauthorized = await fetch(`${endpoint}/admin/shutdown`, {
      method: "POST",
      headers: { authorization: "Bearer invalid" },
    });
    expect(unauthorized.status).toBe(401);

    const undrained = await fetch(`${endpoint}/admin/shutdown`, {
      method: "POST",
      headers: authorization,
    });
    expect(undrained.status).toBe(409);

    const drain = await fetch(`${endpoint}/admin/drain`, {
      method: "POST",
      headers: authorization,
    });
    expect(drain.status).toBe(200);

    const shutdown = await fetch(`${endpoint}/admin/shutdown`, {
      method: "POST",
      headers: authorization,
    });
    expect(shutdown.status).toBe(200);
    expect(await shutdown.json()).toMatchObject({
      status: "ok",
      accepting_turns: false,
      active_http_turns: 0,
      active_browser_turns: 0,
    });

    const deadline = Date.now() + 2_000;
    let stopped = false;
    while (Date.now() < deadline && !stopped) {
      await Bun.sleep(20);
      try {
        await fetch(`${endpoint}/healthz`);
      } catch {
        stopped = true;
      }
    }
    expect(stopped).toBe(true);
  } finally {
    await server.stop(true);
  }
});

test("model catalog health tracks local requests without secrets", async () => {
  const server = startServer({ ...defaultConfig("browser-only"), port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const health = async () => await (await fetch(`${base}/healthz`)).json() as Record<string, any>;
  try {
    expect(await health()).toMatchObject({ model_catalog_requests: 0, last_model_catalog_result: null });
    const response = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer private-session-token" } });
    expect(response.status).toBe(200);
    await response.text();
    const snapshot = await health();
    expect(snapshot.last_model_catalog_result).toMatchObject({ status: 200 });
    expect(JSON.stringify(snapshot)).not.toContain("private");
    expect(snapshot.successful_model_catalog_requests).toBe(1);
    expect(snapshot.model_catalog_requests).toBe(1);
  } finally {
    await server.stop(true);
  }
});
