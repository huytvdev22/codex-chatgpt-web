import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web";
import { BaseWebBrowserWorker } from "../src/adapters/web";

class TestableChatGptBrowserWorker extends ChatGptBrowserWorker {
  public captureBaseline(page: Page) {
    return this.captureResponseBaseline(page);
  }

  public observe(page: Page, baseline: any) {
    return this.observeResponse(page, baseline);
  }

  public submit(page: Page, signal?: AbortSignal) {
    return this.submitPrompt(page, {
      prompt: "test",
      signal,
    });
  }
}

function createEvaluatePage(documentMock: unknown): Page {
  return {
    evaluate: async (callback: (...args: any[]) => unknown, argument: unknown) => {
      const originalDocument = globalThis.document;
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: documentMock,
      });
      try {
        return await callback(argument);
      } finally {
        Object.defineProperty(globalThis, "document", {
          configurable: true,
          value: originalDocument,
        });
      }
    },
  } as unknown as Page;
}

describe("ChatGptBrowserWorker shared lifecycle", () => {
  test("kế thừa BaseWebBrowserWorker", () => {
    expect(new ChatGptBrowserWorker()).toBeInstanceOf(BaseWebBrowserWorker);
  });

  test("nhận diện assistant response mới không có message ID bằng message count", async () => {
    const oldMessage = {
      textContent: "Phản hồi cũ",
      closest: () => null,
      querySelector: () => null,
      parentElement: null,
    };
    const newWrapper = {
      getAttribute: () => null,
      querySelector: () => null,
    };
    const newMessage = {
      textContent: "Phản hồi mới",
      closest: () => newWrapper,
      querySelector: () => null,
      parentElement: newWrapper,
    };
    let messages = [oldMessage];
    const documentMock = {
      querySelector: () => null,
      querySelectorAll: () => messages,
    };
    const page = createEvaluatePage(documentMock);
    const worker = new TestableChatGptBrowserWorker();

    const baseline = await worker.captureBaseline(page);
    messages = [oldMessage, newMessage];
    const observation = await worker.observe(page, baseline);

    expect(observation.text).toBe("Phản hồi mới");
    expect(observation.activityKey).toContain("new-response-without-id");
    expect(observation.isCompleted).toBe(false);
  });

  test("nhận diện response khi ChatGPT tái sử dụng DOM node nhưng thay đổi nội dung", async () => {
    const wrapper = {
      getAttribute: () => "stable-message-id",
      querySelector: () => null,
    };
    const message = {
      textContent: "Nội dung ban đầu",
      closest: () => wrapper,
      querySelector: () => null,
      parentElement: wrapper,
    };
    const documentMock = {
      querySelector: () => null,
      querySelectorAll: () => [message],
    };
    const page = createEvaluatePage(documentMock);
    const worker = new TestableChatGptBrowserWorker();

    const baseline = await worker.captureBaseline(page);
    message.textContent = "Nội dung mới đang stream";
    const observation = await worker.observe(page, baseline);

    expect(observation.text).toBe("Nội dung mới đang stream");
    expect(observation.responseId).toBe("stable-message-id");
    expect(observation.isGenerating).toBe(false);
  });

  test("fail-fast khi không thể xác nhận prompt đã gửi", async () => {
    const createLocator = (visible: boolean) => {
      const locator = {
        first: () => locator,
        nth: () => locator,
        count: async () => 1,
        isVisible: async () => visible,
        isEnabled: async () => false,
        focus: async () => {},
        textContent: async () => "tool_result vẫn chưa được gửi",
      };
      return locator;
    };
    const composerLocator = createLocator(true);
    const hiddenControlLocator = createLocator(false);
    const page = {
      locator: (selector: string) =>
        selector.includes("ProseMirror") || selector.includes("prompt-textarea")
          ? composerLocator
          : hiddenControlLocator,
      keyboard: {
        press: async () => {},
      },
      evaluate: async () => false,
      waitForTimeout: async () => {},
    } as unknown as Page;
    const worker = new TestableChatGptBrowserWorker();
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => {
      now += 4_000;
      return now;
    };

    try {
      await expect(worker.submit(page)).rejects.toThrow(
        "Không thể xác nhận prompt đã được gửi trong 15 giây",
      );
    } finally {
      Date.now = originalNow;
    }
  });
});
