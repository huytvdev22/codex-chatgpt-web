import { describe, expect, test } from "bun:test";
import {
  BaseWebChatAdapter,
  TurnExecutionMetaDto,
  ResponseTranslationResultDto,
  LoopGuardResultDto,
  BrowserTurnOptionsDto,
  type IChatBrowserWorker,
} from "../src/adapters/base-web";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";
import type { IncomingMeta } from "../src/adapters/base";

class MockChatBrowserWorker implements IChatBrowserWorker {
  readonly workerName = "mock-browser-worker";
  public executeCallCount = 0;
  public replies: string[] = ["Xin chào"];

  async executeTurn(prompt: string, options: BrowserTurnOptionsDto): Promise<string> {
    const reply = this.replies[this.executeCallCount] ?? this.replies[this.replies.length - 1];
    this.executeCallCount++;
    return reply;
  }
}

class TestWebChatAdapter extends BaseWebChatAdapter {
  readonly name = "test-web-adapter";
  readonly mockWorker = new MockChatBrowserWorker();
  readonly browserWorker = this.mockWorker;
  readonly modelSelector = undefined;

  public titleHandled = false;

  protected resolveExecutionMeta(parsed: CodexParsedRequest, incoming: IncomingMeta): TurnExecutionMetaDto {
    return TurnExecutionMetaDto.of({
      conversationKey: "conv-123",
      isNewConversation: true,
      traceId: "trace-999",
    });
  }

  protected buildTurnPrompt(parsed: CodexParsedRequest, meta: TurnExecutionMetaDto): string {
    return "Test prompt";
  }

  protected override async handleTitleGuardFastPath(
    parsed: CodexParsedRequest,
    prompt: string,
    meta: TurnExecutionMetaDto,
    emit: (event: AdapterEvent) => void
  ): Promise<boolean> {
    if (this.titleHandled) {
      emit({ type: "text_delta", text: "Generated Title" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } });
      return true;
    }
    return false;
  }

  protected translateResponse(rawReply: string, parsed: CodexParsedRequest): ResponseTranslationResultDto {
    if (rawReply.includes("ERROR_FORMAT")) {
      return ResponseTranslationResultDto.protocolError("INVALID_ENVELOPE", "Sai format envelope", rawReply);
    }
    if (rawReply.includes("TOOL_CALL")) {
      return ResponseTranslationResultDto.toolCalls([
        { id: "call_1", name: "read_file", arguments: { path: "package.json" } },
      ]);
    }
    return ResponseTranslationResultDto.finalAnswer(rawReply);
  }

  protected buildFormatRetryPrompt(code: string, message: string): string {
    return `Retry prompt: ${code} - ${message}`;
  }
}

describe("BaseWebChatAdapter - Template Method Execution", () => {
  const baseParsed: CodexParsedRequest = {
    modelId: "test-model",
    stream: true,
    context: {
      messages: [{ role: "user", content: "Viết mã", timestamp: 1000 }],
      tools: [],
    },
    options: {},
  };

  test("Fast-path: Assistant already completed terminates turn immediately", async () => {
    const adapter = new TestWebChatAdapter();
    const events: AdapterEvent[] = [];

    const completedParsed: CodexParsedRequest = {
      modelId: "test-model",
      stream: true,
      context: {
        messages: [
          { role: "user", content: "Làm gì đó", timestamp: 1000 },
          { role: "assistant", content: [{ type: "text", text: "Tôi đã làm xong" }], timestamp: 2000 },
        ],
        tools: [],
      },
      options: {},
    };

    await adapter.runTurn(completedParsed, { headers: new Headers() }, e => events.push(e));

    expect(adapter.mockWorker.executeCallCount).toBe(0);
    const doneEvent = events.find(e => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent && doneEvent.type === "done") {
      expect(doneEvent.stopReason).toBe("stop");
      expect(doneEvent.endTurn).toBe(true);
    }
  });

  test("Title Guard Fast-path: Ngắt lượt tức thì khi handleTitleGuardFastPath trả về true", async () => {
    const adapter = new TestWebChatAdapter();
    adapter.titleHandled = true;
    const events: AdapterEvent[] = [];

    await adapter.runTurn(baseParsed, { headers: new Headers() }, e => events.push(e));

    expect(adapter.mockWorker.executeCallCount).toBe(0);
    const textDelta = events.find(e => e.type === "text_delta");
    expect(textDelta).toBeDefined();
    if (textDelta && textDelta.type === "text_delta") {
      expect(textDelta.text).toBe("Generated Title");
    }
  });

  test("Vòng lặp Format Retry: Tự động retry khi gặp protocol_error và thành công ở lần sau", async () => {
    const adapter = new TestWebChatAdapter();
    adapter.mockWorker.replies = ["ERROR_FORMAT_1", "Phản hồi chuẩn sau retry"];
    const events: AdapterEvent[] = [];

    await adapter.runTurn(baseParsed, { headers: new Headers() }, e => events.push(e));

    expect(adapter.mockWorker.executeCallCount).toBe(2);
    const textDelta = events.find(e => e.type === "text_delta");
    expect(textDelta).toBeDefined();
    if (textDelta && textDelta.type === "text_delta") {
      expect(textDelta.text).toBe("Phản hồi chuẩn sau retry");
    }
  });

  test("Phát Tool Call chuẩn xác khi nhận kind = tool_calls", async () => {
    const adapter = new TestWebChatAdapter();
    adapter.mockWorker.replies = ["TOOL_CALL: read_file"];
    const events: AdapterEvent[] = [];

    await adapter.runTurn(baseParsed, { headers: new Headers() }, e => events.push(e));

    const toolStart = events.find(e => e.type === "tool_call_start");
    expect(toolStart).toBeDefined();
    if (toolStart && toolStart.type === "tool_call_start") {
      expect(toolStart.name).toBe("read_file");
    }

    const doneEvent = events.find(e => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent && doneEvent.type === "done") {
      expect(doneEvent.stopReason).toBe("tool_use");
      expect(doneEvent.endTurn).toBe(false);
    }
  });

  test("Từ chối lượt trước khi bắt đầu nếu AbortSignal đã bị aborted", async () => {
    const adapter = new TestWebChatAdapter();
    const controller = new AbortController();
    controller.abort();

    await expect(
      adapter.runTurn(baseParsed, { headers: new Headers(), abortSignal: controller.signal }, () => {})
    ).rejects.toThrow("Turn aborted before start");
    expect(adapter.mockWorker.executeCallCount).toBe(0);
  });
});
