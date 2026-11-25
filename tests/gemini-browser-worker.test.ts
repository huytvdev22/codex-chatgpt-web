import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import {
  GeminiBrowserWorker,
  GeminiDomObserver,
  normalizeCopiedGeminiSnippet,
  selectPreferredGeminiResponse,
  type GeminiResponseBaseline,
} from "../src/adapters/gemini";
import { BaseWebBrowserWorker } from "../src/adapters/web/browser";

class TestableGeminiWorker extends GeminiBrowserWorker {
  public async callNavigate(
    page: Page,
    options: Parameters<GeminiBrowserWorker["navigate"]>[1],
  ): Promise<void> {
    return this.navigate(page, options);
  }

  public async callResolveConversationId(
    page: Page,
    options: Parameters<GeminiBrowserWorker["resolveConversationId"]>[1],
  ): Promise<string | undefined> {
    return this.resolveConversationId(page, options);
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
});
