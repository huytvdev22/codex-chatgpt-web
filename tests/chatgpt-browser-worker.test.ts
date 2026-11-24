import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import {
  ChatGptBrowserWorker,
  ChatGptCapabilityPicker,
  ChatGptDomObserver,
  isChatGptGenerationRequest,
  normalizeCopiedChatGptSnippet,
  selectPreferredChatGptResponse,
  type ChatGptResponseBaseline,
} from "../src/adapters/chatgpt";
import { BaseWebBrowserWorker } from "../src/adapters/web/browser";

class TestableChatGptWorker extends ChatGptBrowserWorker {
  public async callNavigate(
    page: Page,
    options: Parameters<ChatGptBrowserWorker["navigate"]>[1],
  ): Promise<void> {
    return this.navigate(page, options);
  }

  public async callSubmitPrompt(
    page: Page,
    options: Parameters<ChatGptBrowserWorker["submitPrompt"]>[1],
  ): Promise<void> {
    return this.submitPrompt(page, options);
  }

  public async callResolveConversationId(
    page: Page,
    options: Parameters<ChatGptBrowserWorker["resolveConversationId"]>[1],
  ): Promise<string | undefined> {
    return this.resolveConversationId(page, options);
  }
}

describe("ChatGptBrowserWorker, DomObserver, ClipboardSalvage & CapabilityPicker", () => {
  test("ChatGptBrowserWorker kế thừa BaseWebBrowserWorker và nhận diện đúng HTTP generation request", () => {
    const worker = new ChatGptBrowserWorker();
    expect(worker).toBeInstanceOf(BaseWebBrowserWorker);

    expect(
      isChatGptGenerationRequest("https://chatgpt.com/backend-api/conversation", "POST"),
    ).toBe(true);
    expect(
      isChatGptGenerationRequest("https://chatgpt.com/backend-api/f/conversation?v=1", "POST"),
    ).toBe(true);
    expect(
      isChatGptGenerationRequest("https://chatgpt.com/backend-api/conversation", "GET"),
    ).toBe(false);
    expect(
      isChatGptGenerationRequest("https://chatgpt.com/backend-api/composer/items/interactions", "POST"),
    ).toBe(false);
  });

  test("ChatGptDomObserver chuyển tiếp đúng qua thinking/streaming, hoàn tất khi turnState=complete và phát hiện rate limit", () => {
    const observer = new ChatGptDomObserver();
    const state = observer.createRuntimeState();
    const baseline: ChatGptResponseBaseline = {
      assistantIds: ["msg-old"],
      assistantCount: 1,
      initialLatestText: "Previous answer",
      previousLatestText: "Previous answer",
      hasSeenGenerating: false,
      stableCount: 0,
    };

    const streaming = observer.applyStatus(
      state,
      baseline,
      {
        isGenerating: true,
        hasNewResponse: true,
        responseId: "msg-new",
        turnState: "streaming",
        hasCopyControl: false,
        rawHtml: "",
        rawText: "",
        singleCodeBlockText: null,
        lightweightLength: 42,
      },
      true,
    );
    expect(streaming.isGenerating).toBe(true);
    expect(streaming.isCompleted).toBe(false);
    expect(baseline.hasSeenGenerating).toBe(true);

    const firstCompletePoll = observer.applyStatus(
      state,
      baseline,
      {
        isGenerating: false,
        hasNewResponse: true,
        responseId: "msg-new",
        turnState: "complete",
        hasCopyControl: true,
        rawHtml: "<p>PONG</p>",
        rawText: "PONG",
        singleCodeBlockText: null,
      },
      false,
    );
    expect(firstCompletePoll.isGenerating).toBe(false);
    expect(firstCompletePoll.isCompleted).toBe(false);

    const settledCompletePoll = observer.applyStatus(
      state,
      baseline,
      {
        isGenerating: false,
        hasNewResponse: true,
        responseId: "msg-new",
        turnState: "complete",
        hasCopyControl: true,
        rawHtml: "<p>PONG</p>",
        rawText: "PONG",
        singleCodeBlockText: null,
      },
      false,
    );
    expect(settledCompletePoll.isGenerating).toBe(false);
    expect(settledCompletePoll.isCompleted).toBe(true);
    expect(settledCompletePoll.text).toBe("PONG");

    expect(() =>
      observer.applyStatus(state, baseline, {
        isGenerating: false,
        hasNewResponse: false,
        hasCopyControl: false,
        rawHtml: "",
        rawText: "",
        singleCodeBlockText: null,
        detectedWebError: "You've reached your usage limit for GPT-6.2.",
      }),
    ).toThrow(/\[ChatGPT Web Error\]/);
  });

  test("ChatGptClipboardSalvage chuẩn hóa snippet code block và fallback DOM khi clipboard thiếu </webResponse>", () => {
    expect(
      normalizeCopiedChatGptSnippet("<webResponse><final_answer>OK</final_answer></webResponse>"),
    ).toBe("````markdown\n<webResponse><final_answer>OK</final_answer></webResponse>\n````");
    expect(
      normalizeCopiedChatGptSnippet("markdown\n<webResponse>PONGSOL</webResponse>"),
    ).toBe("````markdown\n<webResponse>PONGSOL</webResponse>\n````");
    expect(
      normalizeCopiedChatGptSnippet(
        "\\`\\`\\`\\`markdown\n\\<webResponse>\nPONG6_PLUS\n\\</webResponse>\n\\`\\`\\`\\`",
      ),
    ).toBe("````markdown\n<webResponse>\nPONG6_PLUS\n</webResponse>\n````");

    const domFull = "<webResponse><final_answer>Full</final_answer></webResponse>";
    expect(selectPreferredChatGptResponse("partial text", domFull)).toEqual({
      rawResponse: `\`\`\`\`markdown\n${domFull}\n\`\`\`\``,
      source: "dom",
    });
    expect(
      selectPreferredChatGptResponse(
        "partial text",
        "markdown\n<webResponse>PONGSOL</webResponse>",
      ),
    ).toEqual({
      rawResponse: "````markdown\n<webResponse>PONGSOL</webResponse>\n````",
      source: "dom",
    });
    expect(
      selectPreferredChatGptResponse(
        "````markdown\n<webResponse><final_answer>Copied</final_answer></webResponse>\n````",
        domFull,
      ).source,
    ).toBe("clipboard");
  });

  test("ChatGptCapabilityPicker chuyển model và chỉnh thanh trượt Instant/Medium/High qua DOM", async () => {
    const picker = new ChatGptCapabilityPicker();
    let menuOpen = false;
    let viewMode: "simple" | "models" = "simple";
    let currentModel = "GPT-6.2";
    let sliderValue = 1;
    const effortNames = ["none", "medium", "high"] as const;
    const pressedKeys: string[] = [];

    const makeLocator = (kind: string): any => ({
      first() { return makeLocator(kind); },
      last() { return makeLocator(kind); },
      nth(index: number) { return makeLocator(`${kind}:${index}`); },
      async count() {
        if (kind === "radios") return 3;
        return 1;
      },
      async isVisible() {
        if (kind === "trigger") return true;
        if (kind === "menu") return menuOpen;
        if (kind === "toggle") return menuOpen && viewMode === "simple";
        if (kind === "sliderRow") return menuOpen && viewMode === "simple";
        return menuOpen;
      },
      async click() {
        if (kind === "trigger") menuOpen = true;
        if (kind === "toggle") viewMode = "models";
        if (kind === "radios:1") {
          currentModel = "GPT-6";
          viewMode = "simple";
        }
      },
      async waitFor() {},
      async getAttribute(name: string) {
        if (kind === "trigger" && name === "data-selected-reasoning-effort") {
          return effortNames[sliderValue];
        }
        if (kind === "sliderThumb" && name === "aria-valuenow") {
          return String(sliderValue);
        }
        if (kind.startsWith("radios:") && name === "aria-checked") {
          const idx = Number(kind.split(":")[1]);
          const models = ["GPT-6.2", "GPT-6", "GPT-5.6 Sol"];
          return String(models[idx] === currentModel);
        }
        return null;
      },
      async innerText() {
        if (kind === "radios:0") return "GPT-6.2";
        if (kind === "radios:1") return "GPT-6";
        if (kind === "radios:2") return "GPT-5.6 Sol";
        return "";
      },
      async evaluate(fn?: (el: unknown, arg?: unknown) => unknown, arg?: unknown) {
        if (kind === "sliderThumb") {
          return { min: 0, max: 2, now: sliderValue };
        }
        if (kind === "menu" && arg && typeof arg === "object") {
          const typed = arg as { expectedShort?: string; isDefault?: boolean };
          if (typed.isDefault && currentModel === "GPT-6.2") return true;
          return typed.expectedShort === "6" && currentModel === "GPT-6";
        }
        return fn ? false : undefined;
      },
      locator(selector: string) {
        if (selector.includes("model-picker-view-toggle")) return makeLocator("toggle");
        if (selector.includes("menuitemradio")) return makeLocator("radios");
        if (selector.includes("data-reasoning-slider")) return makeLocator("sliderRow");
        if (selector.includes('role="slider"')) return makeLocator("sliderThumb");
        return makeLocator("unknown");
      },
    });

    const fakePage = {
      locator(selector: string) {
        if (selector.includes("Select ChatGPT model")) return makeLocator("trigger");
        if (selector.includes('role="menu"')) return makeLocator("menu");
        return makeLocator("unknown");
      },
      keyboard: {
        async press(key: string) {
          pressedKeys.push(key);
          if (key === "ArrowRight") sliderValue = Math.min(2, sliderValue + 1);
          if (key === "ArrowLeft") sliderValue = Math.max(0, sliderValue - 1);
          if (key === "Escape") menuOpen = false;
        },
      },
      async waitForTimeout() {},
    } as unknown as Page;

    const ok = await picker.ensureCapability(fakePage, {
      modelSlug: "chatgpt/gpt-6",
      modelLabel: "GPT-6",
      shortUiVersion: "6",
      isAccountDefault: false,
      thinkingEffort: "high",
    });

    expect(ok).toBe(true);
    expect(currentModel).toBe("GPT-6");
    expect(sliderValue).toBe(2);
    expect(pressedKeys).toContain("ArrowRight");
    expect(menuOpen).toBe(false);
  });

  test("ChatGptBrowserWorker bỏ qua chờ /c/{id} khi retain=false và chặn retained conversation mismatch", async () => {
    const worker = new TestableChatGptWorker();
    const pageAtHome = {
      url: () => "https://chatgpt.com/",
      waitForTimeout: async () => {},
    } as unknown as Page;

    const ephemeralId = await worker.callResolveConversationId(pageAtHome, {
      prompt: "Title",
      retain: false,
    });
    expect(ephemeralId).toBeUndefined();

    const pageWrongConv = {
      url: () => "https://chatgpt.com/c/6afae1f3-e4f0-83ec-8aca-7c8649cfde1c",
    } as unknown as Page;
    await expect(
      worker.callNavigate(pageWrongConv, {
        prompt: "Hi",
        existingConversationId: "6ad45b09-8c18-83ec-9b69-e6f03ab77b6b",
        launcherReused: true,
      }),
    ).rejects.toThrow(/retained conversation mismatch/i);

    const pageLogin = {
      url: () => "https://auth.openai.com/u/login",
    } as unknown as Page;
    await expect(
      worker.callNavigate(pageLogin, { prompt: "Hi", isNewConversation: true }),
    ).rejects.toThrow(/hết hạn/i);
  });

  test("ChatGptCapabilityPicker tự bật/tắt nút Think trên tài khoản Free khi không có model picker", async () => {
    const picker = new ChatGptCapabilityPicker();
    let thinkPressed = "false";
    let hiddenClicks = 0;

    const fakePage = {
      waitForTimeout: async () => {},
      locator: (selector: string) => {
        if (selector.includes("thinkToggleButton") || selector.includes('aria-pressed')) {
          return {
            count: async () => 2,
            nth: (index: number) => ({
              isVisible: async () => index === 1,
              isDisabled: async () => false,
              getAttribute: async (attr: string) =>
                attr === "aria-pressed" ? (index === 0 ? "false" : thinkPressed) : null,
              click: async () => {
                if (index === 0) {
                  hiddenClicks += 1;
                  return;
                }
                thinkPressed = thinkPressed === "true" ? "false" : "true";
              },
            }),
          };
        }
        return {
          first: () => ({
            isVisible: async () => false,
          }),
        };
      },
    } as unknown as Page;

    const enabled = await picker.ensureCapability(fakePage, {
      modelSlug: "chatgpt/gpt-6.2",
      modelLabel: "GPT-6.2",
      isAccountDefault: true,
      thinkingEffort: "high",
    });
    expect(enabled).toBe(true);
    expect(thinkPressed).toBe("true");
    expect(hiddenClicks).toBe(0);

    const disabled = await picker.ensureCapability(fakePage, {
      modelSlug: "chatgpt/gpt-6.2",
      modelLabel: "GPT-6.2",
      isAccountDefault: true,
      thinkingEffort: "none",
    });
    expect(disabled).toBe(true);
    expect(thinkPressed).toBe("false");

    // Khi SSR trigger hiện lúc đầu rồi biến mất sang Think toggle lúc hydrate
    let triggerChecks = 0;
    const hydratingPage = {
      waitForTimeout: async () => {},
      locator: (selector: string) => {
        if (selector.includes("Select ChatGPT model")) {
          return {
            first: () => ({
              isVisible: async () => {
                triggerChecks += 1;
                return triggerChecks === 1;
              },
              getAttribute: async () => "",
              click: async () => {},
            }),
          };
        }
        if (selector.includes('role="menu"')) {
          return {
            first: () => ({ isVisible: async () => false }),
            last: () => ({ waitFor: async () => { throw new Error("timeout"); } }),
          };
        }
        return fakePage.locator(selector);
      },
    } as unknown as Page;

    const hydratedOk = await picker.ensureCapability(hydratingPage, {
      modelSlug: "chatgpt/gpt-6.2",
      modelLabel: "GPT-6.2",
      isAccountDefault: true,
      thinkingEffort: "high",
    });
    expect(hydratedOk).toBe(true);
    expect(thinkPressed).toBe("true");
  });
});
