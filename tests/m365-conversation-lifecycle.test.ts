import { describe, expect, it } from "bun:test";
import { AsyncEventQueue } from "../src/event-queue";
import { bridgeToResponsesSSE } from "../src/bridge";
import {
  rememberResponseState,
  expandPreviousResponseInput,
  pruneResponses,
} from "../src/responses/state";
import type { AdapterEvent } from "../src/types";

describe("M365 Conversation Lifecycle & Queue State Cleanup", () => {
  it("completes normal turn and cleanly closes queue and SSE stream", async () => {
    const queue = new AsyncEventQueue<AdapterEvent>();
    let cancelled = false;

    const stream = bridgeToResponsesSSE(
      queue,
      "chatgpt-web/pro",
      undefined,
      undefined,
      undefined,
      () => {
        cancelled = true;
      },
      15_000
    );

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";

    // Đẩy sự kiện text_delta và done vào queue
    queue.push({ type: "text_delta", text: "Xin chào từ M365 Copilot!" });
    queue.push({
      type: "done",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });
    queue.close();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value, { stream: true });
    }

    expect(accumulated).toContain("response.output_item.added");
    expect(accumulated).toContain("Xin chào từ M365 Copilot!");
    expect(accumulated).toContain("response.completed");
    expect(accumulated).toContain("data: [DONE]");
    expect(queue.isClosed()).toBe(true);
    expect(queue.size()).toBe(0);
    // Bridge luôn gọi onCancel hook khi gặp terminal event để đảm bảo adapter cleanup tài nguyên
    expect(cancelled).toBe(true);
  });

  it("handles previous_response_id continuation state persistence", () => {
    const testRespId = "resp_test_m365_continuation_123";
    const prevRequestBody = {
      model: "chatgpt-web/pro",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Câu hỏi trước đó" }],
        },
      ],
    };
    const testResponse = {
      id: testRespId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model: "chatgpt-web/pro",
      output: [
        {
          type: "message",
          id: "msg_out_123",
          role: "assistant",
          content: [{ type: "output_text", text: "Câu trả lời trước đó" }],
        },
      ],
      usage: null,
    };

    rememberResponseState(prevRequestBody, testResponse, { force: true });

    // Lượt tiếp theo gửi previous_response_id
    const nextRequestBody = {
      model: "chatgpt-web/pro",
      previous_response_id: testRespId,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Câu hỏi tiếp theo" }],
        },
      ],
    };

    const expanded = expandPreviousResponseInput(nextRequestBody) as any;
    expect(expanded).toBeDefined();
    expect(expanded.input).toBeDefined();
    expect(expanded.input.length).toBe(3); // user prev + assistant prev + user next
    expect(expanded.input[0].role).toBe("user");
    expect(expanded.input[1].role).toBe("assistant");
    expect(expanded.input[2].role).toBe("user");
  });

  it("cleans up resources and closes stream on client abort", async () => {
    const queue = new AsyncEventQueue<AdapterEvent>();
    let cancelled = false;

    const stream = bridgeToResponsesSSE(
      queue,
      "chatgpt-web/pro",
      undefined,
      undefined,
      undefined,
      () => {
        cancelled = true;
      },
      15_000
    );

    const reader = stream.getReader();

    queue.push({ type: "text_delta", text: "Đang sinh dở dang..." });
    const firstRead = await reader.read();
    expect(firstRead.done).toBe(false);

    // Client hủy bỏ stream
    await reader.cancel("Client navigated away or cancelled");
    queue.close();

    expect(cancelled).toBe(true);
    expect(queue.isClosed()).toBe(true);
  });

  it("handles adapter error event cleanly with response.failed and DONE frame", async () => {
    const queue = new AsyncEventQueue<AdapterEvent>();
    let cancelled = false;

    const stream = bridgeToResponsesSSE(
      queue,
      "chatgpt-web/pro",
      undefined,
      undefined,
      undefined,
      () => {
        cancelled = true;
      },
      15_000
    );

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";

    queue.push({
      type: "error",
      message: "[M365 Copilot] Kết nối tới Launcher browser bị ngắt",
    });
    queue.close();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value, { stream: true });
    }

    expect(accumulated).toContain("response.failed");
    expect(accumulated).toContain("data: [DONE]");
    expect(queue.isClosed()).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("stall timeout fires and terminates stream cleanly when adapter stalls", async () => {
    const queue = new AsyncEventQueue<AdapterEvent>();
    let cancelled = false;

    let firstRead = true;
    const coalescedClock = () => {
      if (firstRead) {
        firstRead = false;
        return 0;
      }
      return 3_000;
    };

    const stream = bridgeToResponsesSSE(
      queue,
      "chatgpt-web/test",
      undefined,
      undefined,
      undefined,
      () => {
        cancelled = true;
      },
      10, // beat 10ms
      {
        stallTimeoutSec: 1,
        now: coalescedClock,
      }
    );

    const text = await new Response(stream).text();

    expect(text).toContain("upstream_stall_timeout");
    expect(text).toContain("data: [DONE]");
    expect(cancelled).toBe(true);
  });

  it("isolates responses-state memory budgets between codex and assistant scopes", () => {
    const codexId = `resp_codex_scope_${Date.now()}`;
    const asstId1 = `resp_asst_scope_1_${Date.now()}`;
    const asstId2 = `resp_asst_scope_2_${Date.now()}`;

    rememberResponseState(
      { model: "m365-copilot/gpt-5.6", input: "codex keep" },
      {
        id: codexId,
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "codex reply" }] }],
      },
      { force: true, scope: "codex" },
    );

    rememberResponseState(
      { model: "gemini/4-hydrogen", input: "A".repeat(400) },
      {
        id: asstId1,
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "B".repeat(400) }] }],
      },
      { force: true, scope: "assistant" },
    );
    rememberResponseState(
      { model: "gemini/4-hydrogen", input: "C".repeat(400) },
      {
        id: asstId2,
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "D".repeat(400) }] }],
      },
      { force: true, scope: "assistant" },
    );

    // Siết trần scope assistant -> chỉ evict entry assistant cũ, giữ nguyên entry codex
    pruneResponses(Date.now(), { assistant: 950 });

    const codexExpanded = expandPreviousResponseInput({
      previous_response_id: codexId,
      input: "next codex",
    }) as { input?: unknown[] };
    const asst1Expanded = expandPreviousResponseInput({
      previous_response_id: asstId1,
      input: "next asst1",
    }) as { previous_response_id?: string; input?: unknown };
    const asst2Expanded = expandPreviousResponseInput({
      previous_response_id: asstId2,
      input: "next asst2",
    }) as { input?: unknown[] };

    expect(Array.isArray(codexExpanded.input)).toBe(true);
    expect((codexExpanded.input as unknown[]).length).toBe(3);
    expect(asst1Expanded.input).toBe("next asst1"); // evicted
    expect(Array.isArray(asst2Expanded.input)).toBe(true); // newest kept
  });
});
