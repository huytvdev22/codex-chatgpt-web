import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import {
  GeminiImageRefusalError,
  GeminiImageWorker,
  GEMINI_HOME_URL,
  GEMINI_SELECTORS,
} from "../src/adapters/gemini";

const PNG_1X1_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

interface MockImagePageOptions {
  initialUrl?: string;
  imagesModeAlreadyActive?: boolean;
  initialAspectLabel?: string;
  pollMode?: "image" | "refusal" | "delayed_image_after_intro";
}

function createMockGeminiImagePage(opts: MockImagePageOptions = {}) {
  let currentUrl = opts.initialUrl ?? GEMINI_HOME_URL;
  let imagesActive = opts.imagesModeAlreadyActive ?? false;
  let aspectAria = opts.initialAspectLabel ?? "";
  let composerText = "";
  let submittedPrompt = "";
  let promptSubmitted = false;
  let pollStep = 0;
  let tempChatClicked = false;
  let clickedAspectOption: string | undefined;
  let attachedFilesCount = 0;
  const gotoUrls: string[] = [];

  const makeSimpleLoc = (sel: string) => {
    const loc: Record<string, unknown> = {
      first: () => loc,
      nth: () => loc,
      count: async () => {
        if (sel.includes(".cdk-overlay-pane")) return 0;
        if (sel === GEMINI_SELECTORS.assistantResponse) {
          return promptSubmitted ? 1 : 0;
        }
        if (sel === GEMINI_SELECTORS.imageFileInput) {
          return 1;
        }
        return 1;
      },
      isVisible: async () => {
        if (sel === GEMINI_SELECTORS.tempChatOnButton) return true;
        if (sel === GEMINI_SELECTORS.deselectImagesChip) return imagesActive;
        if (sel === GEMINI_SELECTORS.stopButton) return false;
        if (sel === GEMINI_SELECTORS.modePickerTrigger) return false;
        if (sel === GEMINI_SELECTORS.aspectRatioChipButton) return Boolean(aspectAria);
        if (sel === GEMINI_SELECTORS.formatChipButton) return false;
        return true;
      },
      isEnabled: async () => true,
      waitFor: async () => {},
      click: async () => {
        if (sel === GEMINI_SELECTORS.tempChatOnButton) {
          tempChatClicked = true;
        }
        if (sel === GEMINI_SELECTORS.sendButton) {
          promptSubmitted = true;
          submittedPrompt = composerText;
          composerText = "";
          if (currentUrl === GEMINI_HOME_URL) {
            currentUrl = "https://gemini.google.com/app/newimgconv123";
          }
        }
      },
      focus: async () => {},
      fill: async (val: string) => {
        composerText = val;
      },
      textContent: async () => composerText,
      innerText: async () => aspectAria || "Aspect ratio",
      getAttribute: async (name: string) => {
        if (sel === GEMINI_SELECTORS.aspectRatioChipButton && name === "aria-label") {
          return aspectAria || null;
        }
        return null;
      },
      setInputFiles: async (files: unknown[]) => {
        attachedFilesCount = files.length;
      },
      filter: ({ hasText }: { hasText?: RegExp }) => {
        const filtered: Record<string, unknown> = {
          first: () => filtered,
          isVisible: async () => {
            if (sel === GEMINI_SELECTORS.createImageMenuItem) {
              return Boolean(hasText?.test("Create image"));
            }
            if (sel === GEMINI_SELECTORS.companionMenuRadioItem) {
              return true;
            }
            return false;
          },
          getAttribute: async (attr: string) => {
            if (attr === "aria-checked") {
              return imagesActive ? "true" : "false";
            }
            return null;
          },
          click: async () => {
            if (sel === GEMINI_SELECTORS.createImageMenuItem) {
              imagesActive = true;
            }
            if (sel === GEMINI_SELECTORS.companionMenuRadioItem && hasText) {
              clickedAspectOption = hasText.source;
              aspectAria = `Aspect ratio, ${hasText.source}`;
            }
          },
        };
        return filtered;
      },
    };
    return loc;
  };

  const page = {
    url: () => currentUrl,
    goto: async (target: string) => {
      gotoUrls.push(target);
      currentUrl = target;
    },
    bringToFront: async () => {},
    waitForTimeout: async () => {},
    keyboard: {
      press: async () => {},
    },
    locator: (sel: string) => {
      if (sel.startsWith(GEMINI_SELECTORS.companionMenuRadioItem) && sel.includes("aria-label=")) {
        const match = /aria-label="([^"]+)"/.exec(sel);
        const ratio = match?.[1] || "";
        const optLoc: Record<string, unknown> = {
          first: () => optLoc,
          isVisible: async () => true,
          getAttribute: async (attr: string) =>
            attr === "aria-checked" ? (aspectAria.endsWith(ratio) ? "true" : "false") : null,
          click: async () => {
            clickedAspectOption = ratio;
            aspectAria = `Aspect ratio, ${ratio}`;
          },
        };
        return optLoc;
      }
      if (sel === GEMINI_SELECTORS.companionChipButtons) {
        const aspectBtn: Record<string, unknown> = {
          isVisible: async () => true,
          getAttribute: async () => aspectAria || null,
          innerText: async () => aspectAria || "Aspect ratio",
          click: async () => {},
        };
        return {
          count: async () => 1,
          nth: () => aspectBtn,
        };
      }
      return makeSimpleLoc(sel);
    },
    evaluate: async (fn: (...args: any[]) => unknown, arg?: any) => {
      const src = fn.toString();
      if (src.includes("previewSel")) return true;
      if (src.includes("toDataURL")) {
        return PNG_1X1_DATA_URL;
      }
      if (src.includes("stopSel")) {
        pollStep += 1;
        if (opts.pollMode === "refusal") {
          return {
            hasNewResponse: true,
            isGenerating: false,
            detectedWebError: "",
            hasPendingImage: false,
            hasReadyImage: false,
            imageSrc: "",
            hasCopyControl: true,
            responseText: "I cannot generate images of that subject.",
          };
        }
        if (opts.pollMode === "delayed_image_after_intro") {
          const isReady = pollStep >= 8;
          return {
            hasNewResponse: true,
            isGenerating: false,
            detectedWebError: "",
            hasPendingImage: pollStep >= 5 && !isReady,
            hasReadyImage: isReady,
            imageSrc: isReady ? "blob:https://gemini.google.com/delayed-image" : "",
            hasCopyControl: true,
            responseText:
              "Đây là ảnh thumbnail 16:9 được thiết kế cho tập podcast của bạn:",
          };
        }
        return {
          hasNewResponse: true,
          isGenerating: pollStep === 1,
          detectedWebError: "",
          hasPendingImage: false,
          hasReadyImage: pollStep > 1,
          imageSrc: "blob:https://gemini.google.com/mock-image",
          hasCopyControl: pollStep > 1,
          responseText: "Gemini said",
        };
      }
      void arg;
      return undefined;
    },
  } as unknown as Page;

  return {
    page,
    getState: () => ({
      gotoUrls,
      imagesActive,
      tempChatClicked,
      clickedAspectOption,
      attachedFilesCount,
      submittedPrompt,
      promptSubmitted,
    }),
  };
}

describe("GeminiImageWorker", () => {
  test("mở phiên mới không bật Temporary Chat, bật Create image, không bấm chip Aspect ratio, chèn gợi ý tỉ lệ nếu thiếu, đính kèm ảnh và trích xuất PNG", async () => {
    const { page, getState } = createMockGeminiImagePage({
      initialUrl: "https://gemini.google.com/app/existing-chat-123",
    });
    const worker = new GeminiImageWorker();

    const result = await worker.executeImageTurn(page, {
      modelSlug: "gemini/4-hydrogen",
      reasoning: "high",
      prompt: "Make this sunset glow",
      aspectRatio: "16:9",
      images: [
        {
          name: "ref.png",
          mimeType: "image/png",
          dataUrl: PNG_1X1_DATA_URL,
          buffer: Buffer.from("mock-png"),
        },
      ],
    });

    const state = getState();
    expect(state.gotoUrls).toEqual([GEMINI_HOME_URL]);
    expect(state.tempChatClicked).toBe(false);
    expect(state.imagesActive).toBe(true);
    expect(state.clickedAspectOption).toBeUndefined();
    expect(state.submittedPrompt).toContain("Make this sunset glow");
    expect(state.submittedPrompt).toContain("Preferred aspect ratio: 16:9.");
    expect(state.attachedFilesCount).toBe(1);
    expect(state.promptSubmitted).toBe(true);
    expect(result.mimeType).toBe("image/png");
    expect(result.imageBase64.length).toBeGreaterThan(20);
    expect(result.conversationId).toBe("newimgconv123");
  });

  test("ném GeminiImageRefusalError ngay khi Gemini chỉ trả lời text từ chối không có ảnh", async () => {
    const { page } = createMockGeminiImagePage({ pollMode: "refusal" });
    const worker = new GeminiImageWorker();

    await expect(
      worker.executeImageTurn(page, {
        prompt: "restricted content",
      }),
    ).rejects.toBeInstanceOf(GeminiImageRefusalError);
  });

  test("đợi được ảnh tải trễ sau khi Gemini đã stream xong text dẫn và hiện hasCopyControl", async () => {
    const { page } = createMockGeminiImagePage({
      pollMode: "delayed_image_after_intro",
    });
    const worker = new GeminiImageWorker();

    const result = await worker.executeImageTurn(page, {
      prompt: "tạo 1 ảnh làm ảnh thumbnail cho tập podcast",
      aspectRatio: "16:9",
    });

    expect(result.mimeType).toBe("image/png");
    expect(result.imageBase64.length).toBeGreaterThan(20);
    expect(result.revisedPrompt).toContain("Đây là ảnh thumbnail 16:9");
  });

  test("điều hướng tới đúng existingConversationId khi sửa ảnh cùng conversation", async () => {
    const { page, getState } = createMockGeminiImagePage({
      initialUrl: GEMINI_HOME_URL,
    });
    const worker = new GeminiImageWorker();

    const result = await worker.executeImageTurn(page, {
      prompt: "Change background to night",
      existingConversationId: "abc123456789",
    });

    const state = getState();
    expect(state.gotoUrls).toEqual(["https://gemini.google.com/app/abc123456789"]);
    expect(result.conversationId).toBe("abc123456789");
  });
});
