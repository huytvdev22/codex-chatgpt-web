import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import {
  BaseWebBrowserWorker,
  BrowserHardTimeoutError,
  BrowserIdleTimeoutError,
  type BaseBrowserRunOptions,
  type BaseBrowserTurnResult,
  type BrowserCompletionContext,
  type BrowserObservation,
} from "../src/adapters/web";

interface TestBaseline {
  responseIds: string[];
}

interface TestOptions extends BaseBrowserRunOptions {
  observations: BrowserObservation[];
  stopAfterObservation?: boolean;
}

class TestBrowserWorker extends BaseWebBrowserWorker<
  TestOptions,
  BaseBrowserTurnResult,
  TestBaseline
> {
  protected readonly logPrefix = "test-browser-worker";
  readonly calls: string[] = [];
  stopCalls = 0;
  private observationIndex = 0;

  protected async initializeTurnState(): Promise<void> {
    this.calls.push("initializeTurnState");
  }

  protected async cleanupTurnState(): Promise<void> {
    this.calls.push("cleanupTurnState");
  }

  protected shouldStopPolling(
    observation: BrowserObservation,
    options: TestOptions,
  ): boolean {
    this.calls.push("shouldStopPolling");
    return Boolean(
      options.stopAfterObservation &&
        !observation.isGenerating &&
        observation.text.length > 0,
    );
  }

  protected async navigate(): Promise<void> {
    this.calls.push("navigate");
  }

  protected async prepareProvider(): Promise<void> {
    this.calls.push("prepareProvider");
  }

  protected async captureResponseBaseline(): Promise<TestBaseline> {
    this.calls.push("captureResponseBaseline");
    return { responseIds: ["old-response"] };
  }

  protected async insertPrompt(
    _page: Page,
    prompt: string,
  ): Promise<void> {
    this.calls.push(`insertPrompt:${prompt}`);
  }

  protected async submitPrompt(): Promise<void> {
    this.calls.push("submitPrompt");
  }

  protected async observeResponse(
    _page: Page,
    _baseline: TestBaseline,
    options: TestOptions,
  ): Promise<BrowserObservation> {
    this.calls.push("observeResponse");
    const observation =
      options.observations[
        Math.min(this.observationIndex, options.observations.length - 1)
      ] || {
        text: "",
        isGenerating: false,
        isCompleted: false,
        activityKey: "empty",
      };
    this.observationIndex += 1;
    return observation;
  }

  protected async extractCompletedResponse(
    _page: Page,
    context: BrowserCompletionContext<TestBaseline, BrowserObservation>,
  ): Promise<string> {
    this.calls.push("extractCompletedResponse");
    expect(context.baseline.responseIds).toEqual(["old-response"]);
    return context.observation.text;
  }

  protected async resolveConversationId(): Promise<string> {
    this.calls.push("resolveConversationId");
    return "conversation-1";
  }

  protected async stopGeneration(): Promise<boolean> {
    this.calls.push("stopGeneration");
    this.stopCalls += 1;
    return true;
  }
}

function createFakePage(): Page {
  return {
    waitForTimeout: async (timeoutMs: number) => {
      await Bun.sleep(timeoutMs);
    },
  } as unknown as Page;
}

describe("BaseWebBrowserWorker", () => {
  test("thực thi đúng Template Method lifecycle và emit delta tăng dần", async () => {
    const worker = new TestBrowserWorker();
    const chunks: string[] = [];

    const result = await worker.executeTurn(createFakePage(), {
      prompt: "Xin chào",
      onChunk: chunk => chunks.push(chunk),
      pollingIntervalMs: 1,
      observations: [
        {
          text: "Xin",
          isGenerating: true,
          isCompleted: false,
          activityKey: "response-1:streaming:3",
        },
        {
          text: "Xin chào",
          isGenerating: false,
          isCompleted: true,
          activityKey: "response-1:completed:8",
        },
      ],
    });

    expect(result).toEqual({
      rawResponse: "Xin chào",
      conversationId: "conversation-1",
    });
    expect(chunks).toEqual(["Xin", " chào"]);
    expect(worker.calls).toEqual([
      "initializeTurnState",
      "navigate",
      "prepareProvider",
      "captureResponseBaseline",
      "insertPrompt:Xin chào",
      "submitPrompt",
      "observeResponse",
      "shouldStopPolling",
      "observeResponse",
      "extractCompletedResponse",
      "resolveConversationId",
      "cleanupTurnState",
    ]);
  });

  test("provider có thể dừng shared polling an toàn qua shouldStopPolling", async () => {
    const worker = new TestBrowserWorker();

    const result = await worker.executeTurn(createFakePage(), {
      prompt: "Early stop",
      stopAfterObservation: true,
      pollingIntervalMs: 1,
      observations: [
        {
          text: "Kết quả đủ dùng",
          isGenerating: false,
          isCompleted: false,
          activityKey: "response-ready",
        },
      ],
    });

    expect(result).toEqual({
      rawResponse: "Kết quả đủ dùng",
      conversationId: "conversation-1",
    });
    expect(worker.calls).toContain("shouldStopPolling");
    expect(
      worker.calls.filter(call => call === "observeResponse"),
    ).toHaveLength(1);
    expect(worker.calls.at(-1)).toBe("cleanupTurnState");
  });

  test("luôn cleanup turn state khi lifecycle thất bại", async () => {
    class FailingBrowserWorker extends TestBrowserWorker {
      protected async submitPrompt(): Promise<void> {
        this.calls.push("submitPrompt");
        throw new Error("submit failed");
      }
    }

    const worker = new FailingBrowserWorker();

    await expect(
      worker.executeTurn(createFakePage(), {
        prompt: "Cleanup",
        observations: [],
      }),
    ).rejects.toThrow("submit failed");

    expect(worker.calls).toEqual([
      "initializeTurnState",
      "navigate",
      "prepareProvider",
      "captureResponseBaseline",
      "insertPrompt:Cleanup",
      "submitPrompt",
      "cleanupTurnState",
    ]);
  });

  test("gửi heartbeat trong polling loop mà không làm hỏng lượt khi heartbeat lỗi", async () => {
    const worker = new TestBrowserWorker();
    let heartbeatCalls = 0;

    const result = await worker.executeTurn(createFakePage(), {
      prompt: "Heartbeat",
      heartbeatIntervalMs: 1,
      pollingIntervalMs: 2,
      heartbeat: async () => {
        heartbeatCalls += 1;
        throw new Error("Launcher tạm thời không khả dụng");
      },
      observations: [
        {
          text: "",
          isGenerating: true,
          isCompleted: false,
          activityKey: "generating-1",
        },
        {
          text: "Hoàn tất",
          isGenerating: false,
          isCompleted: true,
          activityKey: "completed-1",
        },
      ],
    });

    expect(result.rawResponse).toBe("Hoàn tất");
    expect(heartbeatCalls).toBeGreaterThanOrEqual(1);
  });

  test("click Stop và ném AbortError khi signal bị hủy trong lúc polling", async () => {
    const worker = new TestBrowserWorker();
    const controller = new AbortController();

    const execution = worker.executeTurn(createFakePage(), {
      prompt: "Abort",
      signal: controller.signal,
      pollingIntervalMs: 5,
      observations: [
        {
          text: "",
          isGenerating: true,
          isCompleted: false,
          activityKey: "generating",
        },
      ],
    });
    await Bun.sleep(2);
    controller.abort();

    await expect(execution).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(worker.stopCalls).toBe(1);
  });

  test("hard deadline không bị reset bởi activity", async () => {
    const worker = new TestBrowserWorker();

    await expect(
      worker.executeTurn(createFakePage(), {
        prompt: "Hard timeout",
        hardTimeoutMs: 8,
        idleTimeoutMs: 100,
        pollingIntervalMs: 2,
        observations: Array.from({ length: 20 }, (_, index) => ({
          text: `progress-${index}`,
          isGenerating: true,
          isCompleted: false,
          activityKey: `activity-${index}`,
        })),
      }),
    ).rejects.toBeInstanceOf(BrowserHardTimeoutError);
    expect(worker.stopCalls).toBe(1);
  });

  test("idle deadline được reset khi activityKey thay đổi và ném lỗi khi đứng yên", async () => {
    const worker = new TestBrowserWorker();

    await expect(
      worker.executeTurn(createFakePage(), {
        prompt: "Idle timeout",
        hardTimeoutMs: 100,
        idleTimeoutMs: 7,
        pollingIntervalMs: 2,
        observations: [
          {
            text: "Đang xử lý",
            isGenerating: true,
            isCompleted: false,
            activityKey: "phase-1",
          },
          {
            text: "Đang xử lý",
            isGenerating: true,
            isCompleted: false,
            activityKey: "phase-2",
          },
          {
            text: "Đang xử lý",
            isGenerating: true,
            isCompleted: false,
            activityKey: "phase-2",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BrowserIdleTimeoutError);
    expect(worker.stopCalls).toBe(1);
  });
});
