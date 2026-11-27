import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import {
  GEMINI_SELECTORS,
  GeminiBrowserWorker,
  GeminiCapabilityPicker,
  GeminiDomObserver,
  normalizeCopiedGeminiSnippet,
  selectPreferredGeminiResponse,
  type GeminiResponseBaseline,
} from "../src/adapters/gemini";
import { BaseWebBrowserWorker } from "../src/adapters/web/browser";
import { BrowserIdleTimeoutError } from "../src/adapters/web/browser/base-browser-worker";
import { focusGeminiComposer } from "../src/adapters/gemini/composer-input";

class TestableGeminiWorker extends GeminiBrowserWorker {
  public async callNavigate(
    page: Page,
    options: Parameters<GeminiBrowserWorker["navigate"]>[1],
  ): Promise<void> {
    return this.navigate(page, options);
  }

  public callResolveGeneratingStallTimeoutMs(
    observation: Parameters<GeminiBrowserWorker["resolveGeneratingStallTimeoutMs"]>[0],
  ): number | undefined {
    return this.resolveGeneratingStallTimeoutMs(observation);
  }

  public async callWaitForCompletion(
    page: Page,
    baseline: Parameters<GeminiBrowserWorker["waitForCompletion"]>[1],
    options: Parameters<GeminiBrowserWorker["waitForCompletion"]>[2],
  ): Promise<Awaited<ReturnType<GeminiBrowserWorker["waitForCompletion"]>>> {
    return this.waitForCompletion(page, baseline, options);
  }

  public async callResolveConversationId(
    page: Page,
    options: Parameters<GeminiBrowserWorker["resolveConversationId"]>[1],
  ): Promise<string | undefined> {
    return this.resolveConversationId(page, options);
  }

  public async callInsertPrompt(
    page: Page,
    promptText: string,
    options: Parameters<GeminiBrowserWorker["insertPrompt"]>[2],
  ): Promise<void> {
    return this.insertPrompt(page, promptText, options);
  }
}

describe("GeminiBrowserWorker, DomObserver & ClipboardSalvage", () => {
  test("GeminiBrowserWorker kế thừa BaseWebBrowserWorker", () => {
    const worker = new GeminiBrowserWorker();
    expect(worker).toBeInstanceOf(BaseWebBrowserWorker);
  });

  test("GeminiDomObserver chờ hết isBusy/stopButton, hoàn tất khi có Copy control và phát hiện rate limit", () => {
    const observer = new GeminiDomObserver();
    const state = observer.createRuntimeState();
    const baseline: GeminiResponseBaseline = {
      responseIds: ["model-response-message-contentr_old"],
      responseCount: 1,
      initialLatestText: "Old response",
      previousLatestText: "Old response",
      hasSeenGenerating: false,
      stableCount: 0,
    };

    const streaming = observer.applyStatus(state, baseline, {
      isGenerating: true,
      isBusy: true,
      hasNewResponse: true,
      responseId: "model-response-message-contentr_new",
      hasCopyControl: false,
      rawHtml: "",
      rawText: "",
      singleCodeBlockText: null,
      lightweightLength: 24,
    });
    expect(streaming.isGenerating).toBe(true);
    expect(streaming.isCompleted).toBe(false);
    expect(baseline.hasSeenGenerating).toBe(true);

    const firstComplete = observer.applyStatus(state, baseline, {
      isGenerating: false,
      isBusy: false,
      hasNewResponse: true,
      responseId: "model-response-message-contentr_new",
      hasCopyControl: true,
      rawHtml: "<p>READY</p>",
      rawText: "READY",
      singleCodeBlockText: null,
    });
    expect(firstComplete.isGenerating).toBe(false);
    expect(firstComplete.isCompleted).toBe(false);

    const settled = observer.applyStatus(state, baseline, {
      isGenerating: false,
      isBusy: false,
      hasNewResponse: true,
      responseId: "model-response-message-contentr_new",
      hasCopyControl: true,
      rawHtml: "<p>READY</p>",
      rawText: "READY",
      singleCodeBlockText: null,
    });
    expect(settled.isCompleted).toBe(true);
    expect(settled.text).toBe("READY");

    expect(() =>
      observer.applyStatus(state, baseline, {
        isGenerating: false,
        isBusy: false,
        hasNewResponse: false,
        hasCopyControl: false,
        rawHtml: "",
        rawText: "",
        singleCodeBlockText: null,
        detectedWebError: "Something went wrong. Please try again later.",
      }),
    ).toThrow(/\[Gemini Web Error\]/);
  });

  test("GeminiClipboardSalvage chuẩn hóa code block và fallback DOM khi clipboard thiếu </webResponse>", () => {
    expect(
      normalizeCopiedGeminiSnippet("<webResponse><final_answer>OK</final_answer></webResponse>"),
    ).toBe("````markdown\n<webResponse><final_answer>OK</final_answer></webResponse>\n````");
    expect(
      normalizeCopiedGeminiSnippet("markdown\n<webResponse>GEMINI_OK</webResponse>"),
    ).toBe("````markdown\n<webResponse>GEMINI_OK</webResponse>\n````");

    const domFull = "<webResponse><final_answer>Full</final_answer></webResponse>";
    expect(selectPreferredGeminiResponse("partial", domFull)).toEqual({
      rawResponse: `\`\`\`\`markdown\n${domFull}\n\`\`\`\``,
      source: "dom",
    });
  });

  test("TestableGeminiWorker điều hướng về /app/{id} khi có existingConversationId và giữ retain=false không chờ URL", async () => {
    const worker = new TestableGeminiWorker();
    const gotoCalls: string[] = [];
    const fakePage = {
      url: () => "https://gemini.google.com/app",
      goto: async (target: string) => {
        gotoCalls.push(target);
      },
    } as unknown as Page;

    await worker.callNavigate(fakePage, {
      prompt: "hi",
      onChunk: () => {},
      existingConversationId: "722895cc1dfdbb27",
    });
    expect(gotoCalls).toEqual(["https://gemini.google.com/app/722895cc1dfdbb27"]);

    const ephemeralPage = {
      url: () => "https://gemini.google.com/app",
      goto: async () => {},
    } as unknown as Page;
    const ephemeralId = await worker.callResolveConversationId(ephemeralPage, {
      prompt: "hi",
      onChunk: () => {},
      retain: false,
    });
    expect(ephemeralId).toBeUndefined();
  });

  test("focusGeminiComposer thoát .cdk-overlay-container bằng Escape và focus lại khi click thường bị che", async () => {
    const events: string[] = [];
    const fakePage = {
      keyboard: {
        press: async (key: string) => {
          events.push(`key:${key}`);
        },
      },
      waitForTimeout: async () => {},
    } as unknown as Page;
    let clickCount = 0;
    const fakeComposer = {
      click: async (opts?: { force?: boolean }) => {
        clickCount += 1;
        events.push(`click:${opts?.force ? "force" : "normal"}#${clickCount}`);
        if (clickCount === 1) {
          throw new Error("cdk-overlay-container subtree intercepts pointer events");
        }
      },
      focus: async () => {
        events.push("focus");
      },
    } as unknown as Parameters<typeof focusGeminiComposer>[1];

    await focusGeminiComposer(fakePage, fakeComposer);
    expect(events).toEqual(["click:normal#1", "key:Escape", "click:normal#2", "focus"]);
  });

  test("insertPrompt bỏ qua .fill() với prompt dài > 1500 ký tự và chèn thẳng qua DOM Fragment", async () => {
    const worker = new TestableGeminiWorker();
    let fillCalled = false;
    let evaluateCalled = false;
    const longPrompt = "A".repeat(2_000) + "\n" + "B".repeat(500);

    const fakeComposer = {
      isVisible: async () => true,
      click: async () => {},
      focus: async () => {},
      fill: async () => {
        fillCalled = true;
      },
      textContent: async () => "",
    };
    const fakeSend = {
      isVisible: async () => true,
      isEnabled: async () => true,
    };

    const fakePage = {
      bringToFront: async () => {},
      waitForTimeout: async () => {},
      keyboard: { press: async () => {} },
      evaluate: async () => {
        evaluateCalled = true;
      },
      locator: (selector: string) => {
        const target = selector.includes("Send") ? fakeSend : fakeComposer;
        return {
          count: async () => 1,
          nth: () => target,
        };
      },
    } as unknown as Page;

    await worker.callInsertPrompt(fakePage, longPrompt, {
      prompt: longPrompt,
      onChunk: () => {},
    });

    expect(fillCalled).toBe(false);
    expect(evaluateCalled).toBe(true);
  });

  test("resolveGeneratingStallTimeoutMs áp giới hạn 60s khi kẹt không có text và 120s khi đang có text", () => {
    const worker = new TestableGeminiWorker();

    expect(
      worker.callResolveGeneratingStallTimeoutMs({
        isGenerating: true,
        isCompleted: false,
        text: "   \n",
        hasCopyControl: false,
        timedOut: false,
      }),
    ).toBe(60_000);

    expect(
      worker.callResolveGeneratingStallTimeoutMs({
        isGenerating: true,
        isCompleted: false,
        text: "đoạn mở đầu",
        hasCopyControl: false,
        timedOut: false,
      }),
    ).toBe(120_000);

    expect(
      worker.callResolveGeneratingStallTimeoutMs({
        isGenerating: false,
        isCompleted: true,
        text: "",
        hasCopyControl: false,
        timedOut: false,
      }),
    ).toBeUndefined();
  });

  test("waitForCompletion tự ngắt sớm sau 60s khi Gemini kẹt isGenerating=true mà không có text mới", async () => {
    class StalledGeminiWorker extends TestableGeminiWorker {
      protected override async beforeObserveResponse(): Promise<void> {}

      protected override async observeResponse(): Promise<
        Awaited<ReturnType<GeminiBrowserWorker["observeResponse"]>>
      > {
        return {
          isGenerating: true,
          isCompleted: false,
          text: "",
          hasCopyControl: false,
          timedOut: false,
        };
      }

      protected override onWaitTimeout(): undefined {
        return undefined;
      }
    }

    const worker = new StalledGeminiWorker();
    let now = 1_000;
    const realDateNow = Date.now;
    Date.now = () => now;

    const fakePage = {
      waitForTimeout: async () => {
        now += 35_000;
      },
    } as unknown as Page;

    try {
      await expect(
        worker.callWaitForCompletion(
          fakePage,
          {
            responseIds: [],
            responseCount: 1,
            initialLatestText: "",
            previousLatestText: "",
            hasSeenGenerating: true,
            stableCount: 0,
          },
          {
            prompt: "test stall",
            onChunk: () => {},
            idleTimeoutMs: 0,
          },
        ),
      ).rejects.toThrow(BrowserIdleTimeoutError);
    } finally {
      Date.now = realDateNow;
    }
  });

  test("GEMINI_SELECTORS chứa selector cấu trúc độc lập ngôn ngữ và fallback tiếng Việt cho Send/Stop/Copy/Redo", () => {
    expect(GEMINI_SELECTORS.sendButton).toContain("gem-icon-button.send-button.submit button");
    expect(GEMINI_SELECTORS.sendButton).toContain('button[aria-label="Gửi tin nhắn"]');
    expect(GEMINI_SELECTORS.stopButton).toContain("gem-icon-button.send-button.stop button");
    expect(GEMINI_SELECTORS.stopButton).toContain('button[aria-label="Ngừng tạo câu trả lời"]');
    expect(GEMINI_SELECTORS.copyAssistantResponseButton).toContain("copy-button button");
    expect(GEMINI_SELECTORS.redoButton).toContain("regenerate-button button");
    expect(GEMINI_SELECTORS.tempChatOnButton).toContain('button[aria-label="Bật cuộc trò chuyện tạm thời"]');
    expect(GEMINI_SELECTORS.tempChatOffButton).toContain('button[aria-label="Tắt cuộc trò chuyện tạm thời"]');
  });

  test("GeminiCapabilityPicker chọn được mức Thinking level tiếng Việt (Thấp / Trung bình / Cao)", async () => {
    const picker = new GeminiCapabilityPicker();
    let clickedText = "";
    const viSubItems = [
      { text: "Thấp Nhanh và hiệu quả", checked: "true" },
      { text: "Trung bình Độ sâu cân bằng", checked: "false" },
      { text: "Cao Cực kỳ kỹ lưỡng", checked: "false" },
    ];
    const makeItem = (entry: { text: string; checked: string }) => ({
      isVisible: async () => true,
      innerText: async () => entry.text,
      getAttribute: async (name: string) => (name === "aria-checked" ? entry.checked : null),
      click: async () => {
        clickedText = entry.text;
      },
    });
    const fakePage = {
      waitForTimeout: async () => {},
      keyboard: { press: async () => {} },
      locator: (selector: string) => {
        if (selector.includes("bard-mode-menu-button")) {
          return { first: () => ({ isVisible: async () => true, click: async () => {} }) };
        }
        if (selector.includes("gem-mode-menu")) {
          return {
            first: () => ({
              isVisible: async () => true,
              waitFor: async () => {},
              locator: (inner: string) => {
                if (inner.includes("thinking_level")) {
                  return {
                    first: () => ({
                      isVisible: async () => true,
                      getAttribute: async () => "sub-id",
                      hover: async () => {},
                      click: async () => {},
                    }),
                  };
                }
                return {
                  count: async () => 1,
                  nth: () => ({
                    isVisible: async () => true,
                    innerText: async () => "Trợ giúp hằng ngày 4 Hydrogen",
                    getAttribute: async (n: string) => (n === "aria-checked" ? "true" : null),
                  }),
                };
              },
            }),
          };
        }
        if (selector === "#sub-id") {
          return {
            isVisible: async () => true,
            locator: () => ({
              count: async () => viSubItems.length,
              nth: (i: number) => makeItem(viSubItems[i]!),
            }),
          };
        }
        return { first: () => ({ isVisible: async () => false }) };
      },
    } as unknown as Page;

    const result = await picker.ensureCapabilityDetailed(fakePage, {
      modelSlug: "gemini/4-hydrogen",
      modelLabel: "4 Hydrogen",
      thinkingEffort: "high",
      isAccountDefault: true,
    });
    expect(result.modelSelected).toBe(true);
    expect(result.thinkingSelected).toBe(true);
    expect(clickedText).toBe("Cao Cực kỳ kỹ lưỡng");
  });
});
