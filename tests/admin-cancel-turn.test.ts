import { describe, expect, test } from "bun:test";
import {
  activeWebTurnRegistry,
  WebTurnEngine,
  type WebProviderDefinition,
  type WebRuntimeLifecycleOps,
} from "../src/adapters/web";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";
import type { CodexParsedRequest } from "../src/types";

function makeParsedRequest(): CodexParsedRequest {
  return {
    modelId: "qwen-web/qwen3.5-plus",
    stream: true,
    options: { reasoning: "medium" } as any,
    context: {
      systemPrompt: ["System prompt"],
      messages: [{ role: "user", content: "Ping", timestamp: Date.now() }] as any,
      tools: [],
    },
    _rawBody: {
      model: "qwen-web/qwen3.5-plus",
      input: [{ role: "user", content: "Ping" }],
    },
  };
}

function captureOutcome(promise: Promise<void>): Promise<{ ok: true } | { ok: false; error: unknown }> {
  return promise.then(
    () => ({ ok: true as const }),
    error => ({ ok: false as const, error }),
  );
}

describe("POST /admin/cancel-turn & /admin/cancel-turns Contract Tests", () => {
  test("1. Từ chối request không hợp lệ (401 auth / 400 invalid traceId) và xác nhận traceId không còn chạy (cancelled_browser_turns=0)", async () => {
    const config = { ...defaultConfig("browser-only"), port: 0 };
    const server = startServer(config);

    try {
      const unauth = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ traceId: "trace_valid_123" }),
      });
      expect(unauth.status).toBe(401);

      const invalid = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.controlToken}`,
        },
        body: JSON.stringify({ traceId: "bad" }),
      });
      expect(invalid.status).toBe(400);

      const orphan = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.controlToken}`,
        },
        body: JSON.stringify({ traceId: "s9eoSh5z5rGaon01", reason: "helper_heartbeat_expired" }),
      });
      expect(orphan.status).toBe(200);
      expect(await orphan.json()).toEqual({
        status: "ok",
        trace_id: "s9eoSh5z5rGaon01",
        cancelled_browser_turns: 0,
        cancelled_broker_turns: 0,
        cancelled_compaction_runs: 0,
        active_http_turns: 0,
        active_browser_turns: 0,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("2. POST /admin/cancel-turn hủy đúng WebTurnEngine turn theo traceId và vẫn giữ peer turn chạy bình thường", async () => {
    const config = { ...defaultConfig("browser-only"), port: 0 };
    const server = startServer(config);

    const endStatuses: Record<string, string> = {};
    let resolveTargetEntered!: () => void;
    const targetEntered = new Promise<void>(resolve => {
      resolveTargetEntered = resolve;
    });
    let releasePeer!: () => void;
    const peerGate = new Promise<void>(resolve => {
      releasePeer = resolve;
    });

    const createEngine = (tag: "target" | "peer") => {
      const ops: Partial<WebRuntimeLifecycleOps> = {
        resolveDescriptorPath: () => "/tmp/mock-descriptor.json",
        startTurn: async () => ({
          connection: { page: {} } as any,
          surfaceId: `${tag}-surface`,
          conversationId: undefined,
          reused: false,
          connectorBound: false,
        }),
        endTurn: async opts => {
          endStatuses[tag] = opts.activity.status;
        },
        closeTurn: async () => {},
      };
      const definition: WebProviderDefinition = {
        id: "qwen-web",
        assistantName: "Qwen",
        logPrefix: "qwen-adapter",
        policies: {
          emitErrorEventOnFailure: false,
          rethrowError: true,
        },
        conversation: {
          resolveConversationKey: () => `conv-${tag}`,
        },
        browser: {
          launcherProviderId: "qwen",
          connectorIdentity: "qwen-web",
          executeTurn: async ({ incoming }) => {
            if (tag === "target") {
              resolveTargetEntered();
              return await new Promise((_resolve, reject) => {
                if (incoming.abortSignal?.aborted) {
                  reject(incoming.abortSignal.reason ?? new DOMException("aborted", "AbortError"));
                  return;
                }
                incoming.abortSignal?.addEventListener(
                  "abort",
                  () => reject(incoming.abortSignal?.reason ?? new DOMException("aborted", "AbortError")),
                  { once: true },
                );
              });
            }
            await peerGate;
            return {
              rawResponse: "````markdown\n<webResponse>\nPeer ok\n</webResponse>\n````",
            };
          },
        },
      };
      return new WebTurnEngine(definition, undefined, ops);
    };

    const targetTraceId = "trace_qwen_target_1";
    const peerTraceId = "trace_qwen_peer_2";

    const targetOutcome = captureOutcome(
      createEngine("target").runTurn(
        makeParsedRequest(),
        { headers: new Headers({ "x-codex-trace-id": targetTraceId }) },
        () => {},
      ),
    );
    const peerOutcome = captureOutcome(
      createEngine("peer").runTurn(
        makeParsedRequest(),
        { headers: new Headers({ "x-codex-trace-id": peerTraceId }) },
        () => {},
      ),
    );

    try {
      await targetEntered;
      expect(activeWebTurnRegistry.activeCount()).toBe(2);

      const response = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.controlToken}`,
        },
        body: JSON.stringify({ traceId: targetTraceId, reason: "user_tab_close" }),
      });

      expect(response.status).toBe(200);
      const receipt = await response.json();
      expect(receipt).toMatchObject({
        status: "ok",
        trace_id: targetTraceId,
        cancelled_browser_turns: 1,
        cancelled_broker_turns: 0,
        cancelled_compaction_runs: 0,
      });

      const resolvedTarget = await targetOutcome;
      expect(resolvedTarget.ok).toBe(false);
      if (!resolvedTarget.ok) {
        expect(String(resolvedTarget.error)).toContain("user_tab_close");
      }
      expect(endStatuses.target).toBe("aborted");
      expect(activeWebTurnRegistry.activeCount()).toBe(1);

      releasePeer();
      const resolvedPeer = await peerOutcome;
      expect(resolvedPeer.ok).toBe(true);
      expect(endStatuses.peer).toBe("completed");
      expect(activeWebTurnRegistry.activeCount()).toBe(0);
    } finally {
      releasePeer?.();
      await Promise.all([targetOutcome, peerOutcome]);
      await server.stop(true);
    }
  });

  test("3. POST /admin/cancel-turns hủy cả turn đang chờ acquireWebTurnSurface và chờ settle sạch sẽ", async () => {
    const config = { ...defaultConfig("browser-only"), port: 0 };
    const server = startServer(config);

    let signalAborted = false;
    let resolveAcquireEntered!: () => void;
    const acquireEntered = new Promise<void>(resolve => {
      resolveAcquireEntered = resolve;
    });

    const engine = new WebTurnEngine(
      {
        id: "qwen-web",
        assistantName: "Qwen",
        logPrefix: "qwen-adapter",
        policies: {
          emitErrorEventOnFailure: false,
          rethrowError: true,
        },
        conversation: {
          resolveConversationKey: () => "conv-acquire-wait",
        },
        browser: {
          launcherProviderId: "qwen",
          connectorIdentity: "qwen-web",
          executeTurn: async () => ({ rawResponse: "" }),
        },
      },
      undefined,
      {
        resolveDescriptorPath: () => "/tmp/mock-descriptor.json",
        startTurn: async ({ signal }) => {
          resolveAcquireEntered();
          return await new Promise((_resolve, reject) => {
            if (signal?.aborted) {
              signalAborted = true;
              reject(signal.reason ?? new DOMException("aborted", "AbortError"));
              return;
            }
            signal?.addEventListener(
              "abort",
              () => {
                signalAborted = true;
                reject(signal.reason ?? new DOMException("aborted", "AbortError"));
              },
              { once: true },
            );
          });
        },
      },
    );

    const turnOutcome = captureOutcome(
      engine.runTurn(
        makeParsedRequest(),
        { headers: new Headers({ "x-codex-trace-id": "trace_acquire_wait_1" }) },
        () => {},
      ),
    );

    try {
      await acquireEntered;
      expect(activeWebTurnRegistry.activeCount()).toBe(1);

      const response = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-turns`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.controlToken}`,
        },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: "ok",
        cancelled_http_turns: 0,
        cancelled_browser_turns: 1,
        cancelled_compaction_runs: 0,
        active_http_turns: 0,
        active_browser_turns: 0,
      });
      expect(signalAborted).toBe(true);
      const outcome = await turnOutcome;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(String(outcome.error)).toContain("Active turn cancelled by launcher");
      }
      expect(activeWebTurnRegistry.activeCount()).toBe(0);
    } finally {
      await turnOutcome;
      await server.stop(true);
    }
  });
});
