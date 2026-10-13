import { describe, expect, test } from "bun:test";
import {
  ChatSelectorsDto,
  BrowserTurnOptionsDto,
  BrowserTurnResultDto,
  BaseChatBrowserWorker,
  type BrowserAttachmentResult,
} from "../src/adapters/base-web/browser";
import type { Page } from "playwright-core";

describe("Base Web Browser - Enterprise DTO Layer", () => {
  test("ChatSelectorsDto: Khởi tạo hợp lệ và kiểm tra Immutability", () => {
    const selectors = new ChatSelectorsDto({
      editor: "#chat-editor",
      sendButton: ".send-btn",
      stopButton: ".stop-btn",
      inputWrapper: ".input-wrapper",
      actions: ".actions-bar",
      dictationButton: ".dictate-btn",
    });

    expect(selectors.editor).toBe("#chat-editor");
    expect(selectors.sendButton).toBe(".send-btn");
    expect(selectors.stopButton).toBe(".stop-btn");
    expect(selectors.inputWrapper).toBe(".input-wrapper");
    expect(selectors.actions).toBe(".actions-bar");
    expect(selectors.dictationButton).toBe(".dictate-btn");
    expect(Object.isFrozen(selectors)).toBe(true);
  });

  test("ChatSelectorsDto: Báo lỗi khi thiếu selector cốt lõi", () => {
    expect(() => new ChatSelectorsDto({
      editor: "",
      sendButton: ".send",
      stopButton: ".stop",
    })).toThrow();
  });

  test("BrowserTurnOptionsDto: Khởi tạo và kiểm tra Immutability của images", () => {
    const opts = BrowserTurnOptionsDto.of({
      modelSlug: "m365-copilot/think",
      reasoning: "high",
      isNewConversation: true,
      images: [
        {
          filename: "test.png",
          mimeType: "image/png",
          buffer: Buffer.from("image-bytes"),
        },
      ],
    });

    expect(opts.modelSlug).toBe("m365-copilot/think");
    expect(opts.reasoning).toBe("high");
    expect(opts.isNewConversation).toBe(true);
    expect(opts.images.length).toBe(1);
    expect(Object.isFrozen(opts)).toBe(true);
    expect(Object.isFrozen(opts.images)).toBe(true);
  });

  test("BrowserTurnResultDto: Khởi tạo và kiểm tra giá trị", () => {
    const res = BrowserTurnResultDto.of({
      text: "Xin chào từ AI",
      durationMs: 1250,
      wasSalvaged: true,
    });

    expect(res.text).toBe("Xin chào từ AI");
    expect(res.durationMs).toBe(1250);
    expect(res.wasSalvaged).toBe(true);
    expect(Object.isFrozen(res)).toBe(true);
  });
});

describe("BaseChatBrowserWorker - Template Method Execution", () => {
  class TestBrowserWorker extends BaseChatBrowserWorker {
    readonly workerName = "test-browser-worker";
    public stepHistory: string[] = [];

    protected readonly selectors = new ChatSelectorsDto({
      editor: "#editor",
      sendButton: "#send",
      stopButton: "#stop",
    });
    protected readonly modelSelector = undefined;

    getChatUrl(): string {
      return "https://test.chat.url/app";
    }

    protected async attachToBrowser(options: BrowserTurnOptionsDto): Promise<BrowserAttachmentResult> {
      this.stepHistory.push("attachToBrowser");
      const mockPage = {
        url: () => "https://test.chat.url/app",
        goto: async () => {},
        waitForSelector: async () => {},
        evaluate: async () => true,
      } as unknown as Page;
      return { page: mockPage };
    }

    protected async preparePageNavigation(page: Page, options: BrowserTurnOptionsDto): Promise<void> {
      this.stepHistory.push("preparePageNavigation");
    }

    protected async waitForComposerReady(page: Page, options: BrowserTurnOptionsDto): Promise<void> {
      this.stepHistory.push("waitForComposerReady");
    }

    protected async ensureModelSelected(page: Page, options: BrowserTurnOptionsDto): Promise<void> {
      this.stepHistory.push("ensureModelSelected");
    }

    protected async waitForIdle(page: Page, options: BrowserTurnOptionsDto): Promise<void> {
      this.stepHistory.push("waitForIdle");
    }

    protected async injectPromptContent(page: Page, prompt: string, options: BrowserTurnOptionsDto): Promise<void> {
      this.stepHistory.push(`injectPromptContent:${prompt}`);
    }

    protected async dispatchSend(page: Page, options: BrowserTurnOptionsDto): Promise<void> {
      this.stepHistory.push("dispatchSend");
    }

    protected async observeStreamingResponse(page: Page, options: BrowserTurnOptionsDto): Promise<string> {
      this.stepHistory.push("observeStreamingResponse");
      return "Phản hồi mẫu hoàn tất";
    }

    protected async salvageOutputIfNeeded(page: Page, currentText: string, options: BrowserTurnOptionsDto): Promise<string> {
      this.stepHistory.push("salvageOutputIfNeeded");
      return currentText;
    }
  }

  test("Thực thi tuần tự đầy đủ 10 bước của Template Method executeTurn", async () => {
    const worker = new TestBrowserWorker();
    const options = BrowserTurnOptionsDto.of({
      modelSlug: "test/pro",
    });

    const reply = await worker.executeTurn("Lệnh lập trình", options);

    expect(reply).toBe("Phản hồi mẫu hoàn tất");
    expect(worker.stepHistory).toEqual([
      "attachToBrowser",
      "preparePageNavigation",
      "waitForComposerReady",
      "ensureModelSelected",
      "waitForIdle",
      "injectPromptContent:Lệnh lập trình",
      "dispatchSend",
      "observeStreamingResponse",
      "salvageOutputIfNeeded",
    ]);
  });

  test("Từ chối thực thi khi AbortSignal đã bị aborted", async () => {
    const worker = new TestBrowserWorker();
    const controller = new AbortController();
    controller.abort();

    const options = BrowserTurnOptionsDto.of({
      signal: controller.signal,
    });

    await expect(worker.executeTurn("Test", options)).rejects.toThrow("Turn aborted before start");
    expect(worker.stepHistory.length).toBe(0);
  });
});
