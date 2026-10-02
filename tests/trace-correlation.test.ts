import { describe, expect, it } from "bun:test";
import {
  generateServerTraceId,
  generateSpanId,
  resolveTraceContext,
  secureToolFingerprint,
  traceStorage,
  PROCESS_INSTANCE_ID,
} from "../src/observability/trace-context";
import {
  emitStructuredEvent,
  isStructuredObservabilityEnabled,
} from "../src/observability/emitter";
import {
  rememberResponseState,
  getStoredResponseTraceState,
} from "../src/responses/state";

describe("Trace Correlation & Observability Foundation (Phase 1)", () => {
  it("TC-01: generates server-owned traceId with tr_ prefix and spanId with span_ prefix", () => {
    const traceId = generateServerTraceId();
    expect(traceId.startsWith("tr_")).toBe(true);
    expect(traceId.length).toBeGreaterThan(15);

    const spanId = generateSpanId("http");
    expect(spanId.startsWith("span_http_")).toBe(true);
    expect(spanId.length).toBeGreaterThan(12);

    // Không dùng client turnId trực tiếp làm traceId
    const res = resolveTraceContext({
      rawBody: { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ turn_id: "client_turn_xyz" }) } },
      headers: new Headers(),
      requestId: "req_123",
    });
    expect(res.context.traceId.startsWith("tr_")).toBe(true);
    expect(res.context.traceId).not.toBe("client_turn_xyz");
    expect(res.context.clientTurnId).toBe("client_turn_xyz");
    expect(res.isContinuation).toBe(false);
  });

  it("TC-02: response-state preserves and recovers trace state via getStoredResponseTraceState", () => {
    const responseId = `resp_test_${Date.now()}`;
    const traceState = {
      traceId: "tr_root_123",
      rootSpanId: "span_root_123",
      providerCallIndex: 1,
      conversationId: "conv_456",
      turnId: "turn_789",
    };

    rememberResponseState(
      { input: "hello" },
      { id: responseId, output: [], status: "completed" },
      { force: true, traceState }
    );

    const recovered = getStoredResponseTraceState(responseId);
    expect(recovered).toBeDefined();
    expect(recovered?.traceId).toBe("tr_root_123");
    expect(recovered?.rootSpanId).toBe("span_root_123");
    expect(recovered?.providerCallIndex).toBe(1);
    expect(recovered?.conversationId).toBe("conv_456");
  });

  it("TC-03: continuation recovers traceId and increments providerCallIndex", () => {
    const prevResponseId = `resp_prev_${Date.now()}`;
    rememberResponseState(
      { input: "continuation base" },
      { id: prevResponseId, output: [], status: "completed" },
      {
        force: true,
        traceState: {
          traceId: "tr_shared_turn",
          rootSpanId: "span_root_main",
          providerCallIndex: 1,
          conversationId: "thread_alpha",
        },
      }
    );

    const cachedState = getStoredResponseTraceState(prevResponseId);
    const res = resolveTraceContext({
      rawBody: {},
      headers: new Headers(),
      previousResponseId: prevResponseId,
      cachedTraceState: cachedState,
      requestId: "req_continuation",
    });

    // Cùng traceId và rootSpanId
    expect(res.context.traceId).toBe("tr_shared_turn");
    expect(res.context.rootSpanId).toBe("span_root_main");
    // providerCallIndex được tăng lên 2
    expect(res.context.providerCallIndex).toBe(2);
    expect(res.context.previousResponseId).toBe(prevResponseId);
    expect(res.isContinuation).toBe(true);
    expect(res.correlationRecovered).toBe(true);
  });

  it("TC-04: span tree establishes root turn span as parent of HTTP request spans", () => {
    const res = resolveTraceContext({
      rawBody: {},
      headers: new Headers(),
      requestId: "req_initial",
    });

    // HTTP request span có parent là root turn span
    expect(res.context.rootSpanId).toBeDefined();
    expect(res.context.spanId).toBeDefined();
    expect(res.context.parentSpanId).toBe(res.context.rootSpanId);
    expect(res.context.spanId).not.toBe(res.context.rootSpanId);
  });

  it("TC-05: feature flag CODEX_STRUCTURED_OBSERVABILITY defaults to ON in Phase 2 and disables only when set to 0", () => {
    const originalEnv = process.env.CODEX_STRUCTURED_OBSERVABILITY;
    try {
      delete process.env.CODEX_STRUCTURED_OBSERVABILITY;
      expect(isStructuredObservabilityEnabled()).toBe(true);

      // Khi người dùng tắt tường minh bằng "0"
      process.env.CODEX_STRUCTURED_OBSERVABILITY = "0";
      expect(isStructuredObservabilityEnabled()).toBe(false);

      let stdoutEmitted = false;
      const originalWrite = process.stdout.write;
      (process.stdout as any).write = () => {
        stdoutEmitted = true;
        return true;
      };

      emitStructuredEvent({
        level: "info",
        event: "test.event.disabled",
        message: "Should not be emitted",
      });

      process.stdout.write = originalWrite;
      expect(stdoutEmitted).toBe(false);
    } finally {
      if (originalEnv !== undefined) {
        process.env.CODEX_STRUCTURED_OBSERVABILITY = originalEnv;
      } else {
        delete process.env.CODEX_STRUCTURED_OBSERVABILITY;
      }
    }
  });

  it("TC-06: AsyncLocalStorage context propagates through execution hierarchy", async () => {
    const res = resolveTraceContext({
      rawBody: {},
      headers: new Headers(),
      requestId: "req_async_test",
    });

    let capturedInCallback: string | undefined;

    await traceStorage.run(res.context, async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      const current = traceStorage.getStore();
      capturedInCallback = current?.traceId;
    });

    expect(capturedInCallback).toBe(res.context.traceId);
  });

  it("TC-07: secureToolFingerprint is deterministic in process but does not leak raw payload", () => {
    const toolName = "write_file";
    const args1 = { path: "/tmp/secret.ts", content: "export const API_KEY = 'secret';" };
    const args2 = { content: "export const API_KEY = 'secret';", path: "/tmp/secret.ts" };

    const fp1 = secureToolFingerprint(toolName, args1);
    const fp2 = secureToolFingerprint(toolName, args2);

    // Bất biến thứ tự tham số (deterministic)
    expect(fp1).toBe(fp2);
    expect(fp1.length).toBe(16);

    // Không chứa raw secret hoặc path
    expect(fp1.includes("secret")).toBe(false);
    expect(fp1.includes("API_KEY")).toBe(false);

    // Process instance ID ổn định
    expect(typeof PROCESS_INSTANCE_ID).toBe("string");
    expect(PROCESS_INSTANCE_ID.length).toBeGreaterThan(8);
  });
});
