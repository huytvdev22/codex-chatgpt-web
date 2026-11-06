import type { Page } from "playwright-core";
import {
  BaseWebBrowserWorker,
  type BaseBrowserRunOptions,
  type BaseBrowserTurnResult,
  type BrowserCompletionContext,
  type BrowserObservation,
} from "../web/browser";
import {
  AI_STUDIO_SELECTORS,
  GOOGLE_AI_STUDIO_NEW_CHAT_URL,
  buildGoogleAIStudioPromptUrl,
  parseGoogleAIStudioPromptId,
  type GoogleAIStudioDomSelectors,
} from "./selectors";
import { ensureGoogleAIStudioThinkingLevel } from "./capability-picker";

export interface GoogleAIStudioBrowserRunOptions
  extends BaseBrowserRunOptions {
  reasoningEffort?: string;
  promptId?: string;
}

export interface GoogleAIStudioTurnResult {
  rawResponse: string;
  promptId?: string;
}

interface GoogleAIStudioResponseBaseline {
  turnCount: number;
  previousLatestText: string;
  stableCount: number;
}

interface GoogleAIStudioResponseObservation
  extends BrowserObservation {
  freshTurnCount: number;
}

/**
 * Chuẩn hóa các đường link URL trong prompt để tránh kích hoạt tính năng "URL Context tool"
 * của Google AI Studio (tính năng này yêu cầu quyền bổ sung trên GCP Project và có thể gây lỗi Permission Denied).
 * LLM vẫn đọc hiểu ngữ nghĩa của đường link hoàn toàn chính xác.
 */
function sanitizePromptUrlsForAIStudio(prompt: string): string {
  return prompt.replace(/\b(https?):\/\//gi, "$1 ://");
}

/**
 * Worker điều khiển trình duyệt Playwright tương tác với Google AI Studio (aistudio.google.com).
 * Bám sát cấu trúc của Browser Worker trong M365 Copilot và Qwen Web.
 */
export class GoogleAIStudioBrowserWorker extends BaseWebBrowserWorker<
  GoogleAIStudioBrowserRunOptions,
  GoogleAIStudioTurnResult,
  GoogleAIStudioResponseBaseline,
  GoogleAIStudioResponseObservation
> {
  protected readonly logPrefix = "ai-studio-worker";

  private selectors: GoogleAIStudioDomSelectors;

  constructor(customSelectors?: Partial<GoogleAIStudioDomSelectors>) {
    super();
    this.selectors = { ...AI_STUDIO_SELECTORS, ...customSelectors };
  }

  /**
   * Đảm bảo trình duyệt đang ở đúng URL đích (New Chat với model param hoặc tiếp tục Prompt ID cũ)
   */
  public async ensureTargetPage(
    page: Page,
    options: { promptId?: string; isNewConversation?: boolean }
  ): Promise<void> {
    const currentUrl = page.url();
    const currentPromptId = parseGoogleAIStudioPromptId(currentUrl);

    // 1. Nếu không phải là hội thoại mới (multi-turn tiếp nối)
    if (!options.isNewConversation) {
      if (options.promptId && currentPromptId === options.promptId) {
        console.log(`[ai-studio-worker] Đang ở sẵn trang hội thoại promptId: ${options.promptId}`);
        return;
      }
      // Khi tab được reuse cho multi-turn, giữ nguyên tab hiện tại, KHÔNG chuyển hướng hoặc reload
      if (currentUrl.includes("aistudio.google.com")) {
        console.log(`[ai-studio-worker] Giữ nguyên tab hiện tại cho multi-turn (${currentUrl})`);
        return;
      }
      if (options.promptId) {
        const targetUrl = buildGoogleAIStudioPromptUrl(options.promptId);
        console.log(`[ai-studio-worker] Điều hướng đến hội thoại cũ: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        return;
      }
    }

    // 2. Hội thoại mới: Đảm bảo trang sạch sẽ 100%, không còn turn cũ hoặc thông báo lỗi từ phiên trước
    const hasOldTurns = await page.evaluate(() => {
      return document.querySelectorAll("ms-chat-turn").length > 0;
    }).catch(() => false);

    if (!currentUrl.includes("aistudio.google.com") || hasOldTurns || currentPromptId) {
      console.log(`[ai-studio-worker] Điều hướng / Reset về New Chat sạch sẽ: ${GOOGLE_AI_STUDIO_NEW_CHAT_URL}`);
      await page.goto(GOOGLE_AI_STUDIO_NEW_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      // Chờ trang khởi tạo và Angular render hoàn tất
      await page.waitForTimeout(2000);
    }

    // Đóng bất kỳ banner lỗi hoặc dialog cũ còn sót lại trên giao diện
    await page.evaluate(() => {
      const closeButtons = document.querySelectorAll(
        '.cdk-overlay-pane button[aria-label*="Close" i], ms-alert button, [role="alert"] button, button[aria-label="Dismiss"]'
      );
      closeButtons.forEach((btn) => (btn as HTMLElement).click());
    }).catch(() => {});
  }

  /**
   * Nhập nội dung prompt vào ô textarea an toàn bằng OS Clipboard Paste kết hợp sự kiện Angular/DOM
   */
  private async insertPromptSafely(page: Page, promptText: string): Promise<void> {
    console.log(`[ai-studio-worker] Đang nhập prompt an toàn (${promptText.length} ký tự)...`);

    // Chờ ô composer hiển thị
    const composer = await page.waitForSelector(this.selectors.composer, {
      timeout: 15_000,
      state: "visible",
    }).catch(() => null);

    if (!composer) {
      // Fallback selector nếu giao diện thay đổi
      const fallback = await page.waitForSelector(this.selectors.composerFallback, {
        timeout: 5_000,
        state: "visible",
      }).catch(() => null);
      if (!fallback) {
        throw new Error(`[AI_STUDIO_SELECTOR_ERROR] Không tìm thấy ô nhập prompt trên Google AI Studio.`);
      }
    }

    const composerLocator = page.locator(this.selectors.composer).first();
    await composerLocator.click();

    // 1. Xóa nội dung cũ nếu có
    const isMac = process.platform === "darwin";
    const selectAllKey = isMac ? "Meta+a" : "Control+a";
    await page.keyboard.press(selectAllKey);
    await page.keyboard.press("Backspace");

    // 2. Ghi prompt vào Clipboard (đã chuẩn hóa link URL để tránh lỗi URL Context của AI Studio)
    const sanitizedText = sanitizePromptUrlsForAIStudio(promptText);
    let clipboardSuccess = false;
    try {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
      await page.evaluate((text) => {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          return navigator.clipboard.writeText(text);
        }
        return Promise.reject(new Error("Clipboard API không khả dụng"));
      }, sanitizedText);
      clipboardSuccess = true;
    } catch {
      clipboardSuccess = false;
    }

    if (clipboardSuccess) {
      // Dán bằng phím tắt Native
      const pasteKey = isMac ? "Meta+v" : "Control+v";
      await page.keyboard.press(pasteKey);
    } else {
      // Fallback: tiêm giá trị trực tiếp và kích hoạt sự kiện input
      console.warn("[ai-studio-worker] Fallback tiêm giá trị trực tiếp vào textarea...");
      await page.evaluate(
        ({ sel, text }) => {
          const ta = document.querySelector(sel) as HTMLTextAreaElement | null;
          if (ta) {
            ta.focus();
            ta.value = text;
            ta.dispatchEvent(new Event("input", { bubbles: true }));
            ta.dispatchEvent(new Event("change", { bubbles: true }));
          }
        },
        { sel: this.selectors.composer, text: sanitizedText }
      );
    }

    await page.waitForTimeout(300);

    // Kích hoạt thêm sự kiện input để Angular Change Detection nhận diện và enable nút Run
    await page.evaluate((sel) => {
      const ta = document.querySelector(sel) as HTMLTextAreaElement | null;
      if (ta) {
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
      }
      // Tự động đóng popup Enable URL Context nếu xuất hiện
      const dialogs = Array.from(document.querySelectorAll('.cdk-overlay-pane, div.enable-url-context-dialog, [role="dialog"]'));
      for (const d of dialogs) {
        if ((d.textContent || '').includes('URL Context')) {
          const closeBtn = d.querySelector('button[aria-label*="Close" i], button.close-button') as HTMLButtonElement | null;
          if (closeBtn) closeBtn.click();
        }
      }
    }, this.selectors.composer);
  }

  protected async navigate(
    page: Page,
    options: GoogleAIStudioBrowserRunOptions,
  ): Promise<void> {
    await this.ensureTargetPage(page, {
      promptId: options.promptId,
      isNewConversation: options.isNewConversation,
    });
  }

  protected async prepareProvider(
    page: Page,
    options: GoogleAIStudioBrowserRunOptions,
  ): Promise<void> {
    if (!options.reasoningEffort) return;

    await ensureGoogleAIStudioThinkingLevel(page, {
      level: options.reasoningEffort,
      selectors: this.selectors,
    });
  }

  protected async captureResponseBaseline(
    page: Page,
  ): Promise<GoogleAIStudioResponseBaseline> {
    const turnCount = await page.evaluate(
      () => document.querySelectorAll("ms-chat-turn").length,
    );

    return {
      turnCount,
      previousLatestText: "",
      stableCount: 0,
    };
  }

  protected async insertPrompt(
    page: Page,
    prompt: string,
  ): Promise<void> {
    await this.insertPromptSafely(page, prompt);
  }

  /**
   * Nhấn nút Run (hoặc phím tắt Control+Enter) và xác nhận tin nhắn đã được gửi
   */
  protected async submitPrompt(
    page: Page,
    options: GoogleAIStudioBrowserRunOptions,
  ): Promise<void> {
    console.log("[ai-studio-worker] Đang kích hoạt lệnh Run...");

    const runBtn = page.locator(this.selectors.runButton).first();
    let canClickRun = false;
    try {
      await runBtn.waitFor({ state: "visible", timeout: 3000 });
      canClickRun = await runBtn.isEnabled({ timeout: 1000 }).catch(() => false);
    } catch {
      canClickRun = false;
    }

    if (canClickRun) {
      await runBtn.click().catch(() => {});
    } else {
      // Dùng phím tắt chuẩn của Google AI Studio: Ctrl+Enter
      console.log("[ai-studio-worker] Nút Run chưa enabled, nhấn phím tắt Control+Enter...");
      const composerLocator = page.locator(this.selectors.composer).first();
      await composerLocator.press("Control+Enter").catch(() => {});
    }

    // Vòng lặp xác nhận đã gửi: Chờ nút Stop xuất hiện hoặc composer sạch
    const submitDeadline = Date.now() + 10_000;
    while (Date.now() < submitDeadline) {
      if (options.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const isSubmitted = await page.evaluate(
        ({ composerSel }) => {
          const genericBtn = document.querySelector('ms-run-button button');
          if (genericBtn && (genericBtn.classList.contains('stoppable') || (genericBtn.textContent || '').includes('Stop'))) {
            return true;
          }
          const ta = document.querySelector(composerSel) as HTMLTextAreaElement | null;
          return ta ? ta.value.trim().length === 0 : false;
        },
        { composerSel: this.selectors.composer },
      );

      if (isSubmitted) {
        console.log("[ai-studio-worker] Tin nhắn đã được gửi thành công sang Google AI Studio!");
        return;
      }

      await page.waitForTimeout(200);
    }

    console.warn("[ai-studio-worker] Hết thời gian chờ xác nhận gửi, tiếp tục theo dõi phản hồi...");
  }

  /**
   * Đọc phản hồi mới nhất từ DOM của Google AI Studio:
   * 1. Chỉ nhắm vào turn của model MỚI NHẤT (turn cuối cùng không có data-codex-turn-baseline).
   * 2. Lọc bỏ hoàn toàn ms-thought-chunk (Thinking chunk).
   * 3. Xóa bỏ toàn bộ rác giao diện Angular / Material (mat-expansion-panel-header, buttons, icons, actions-container).
   * 4. Trích xuất text sạch nguyên bản từ code block (pre code) và các đoạn văn bản.
   */
  private async readLatestCleanResponse(
    page: Page,
    baseline: GoogleAIStudioResponseBaseline,
  ): Promise<string> {
    return await page.evaluate((baselineTurnCount) => {
      // 1. Tìm tất cả các ms-chat-turn
      const allTurns = Array.from(document.querySelectorAll("ms-chat-turn"));
      const freshTurns = allTurns.slice(baselineTurnCount);
      const candidateTurns = freshTurns;

      // Lọc turn của model (chứa .model-prompt-container hoặc không chứa user input/editor)
      let modelTurns = candidateTurns.filter(
        (t) => t.querySelector(".model-prompt-container") || !t.querySelector(".user-prompt-container, ms-prompt-editor, textarea")
      );
      if (modelTurns.length === 0) {
        modelTurns = candidateTurns;
      }
      if (modelTurns.length === 0) {
        const standaloneContainer = document.querySelector(".model-prompt-container");
        if (!standaloneContainer) return "";
        modelTurns = [standaloneContainer as HTMLElement];
      }

      // Lấy turn model cuối cùng
      const targetTurn = modelTurns[modelTurns.length - 1];
      if (!targetTurn) return "";

      // 2. Clone turn để bóc tách rác mà không làm ảnh hưởng DOM trang thật
      const clone = targetTurn.cloneNode(true) as HTMLElement;

      // 3. Xóa bỏ hoàn toàn các thành phần rác của Angular / Material / AI Studio:
      // - ms-thought-chunk: Suy nghĩ nội tâm của model
      // - mat-expansion-panel-header: Header của code block chứa các nút download, copy, icons
      // - buttons & actions-container: Nút tải về, copy, toggle mở/đóng
      // - icons: Material symbols icon rác
      // - footer: Nút feedback, share
      const junkSelectors = [
        "ms-thought-chunk",
        "mat-expansion-panel-header",
        ".mat-expansion-panel-header",
        ".actions-container",
        ".projected-actions-wrapper",
        ".header-content",
        "button",
        ".mat-expansion-indicator",
        ".title-icon",
        "mat-icon",
        ".material-symbols-outlined",
        "ms-chat-turn-footer",
        ".turn-footer",
        ".error-container",
        "ms-alert",
      ];

      for (const sel of junkSelectors) {
        const junkNodes = clone.querySelectorAll(sel);
        junkNodes.forEach((node) => node.remove());
      }

      // 4. Lấy nội dung text sạch
      return (clone.textContent || "").trim();
    }, baseline.turnCount);
  }

  protected async observeResponse(
    page: Page,
    baseline: GoogleAIStudioResponseBaseline,
  ): Promise<GoogleAIStudioResponseObservation> {
    const status = await page.evaluate(
      (baselineTurnCount) => {
        const btn = document.querySelector('ms-run-button button');
        const isGenerating = btn
          ? btn.classList.contains("stoppable") ||
            (btn.textContent || "").includes("Stop")
          : false;

        const allTurns = Array.from(
          document.querySelectorAll("ms-chat-turn"),
        );
        const freshTurns = allTurns.slice(baselineTurnCount);

        let pageError: string | null = null;
        const errorSelector = [
          ".error-container",
          ".error-message",
          "ms-alert",
          '[role="alert"]',
        ].join(",");

        for (const turn of freshTurns) {
          const errorNodes = Array.from(
            turn.querySelectorAll(errorSelector),
          );
          for (const node of errorNodes) {
            const text = (node.textContent || "").trim();
            if (text) {
              pageError = text;
              break;
            }
          }
          if (pageError) break;

          const turnText = turn.textContent || "";
          if (turnText.includes("Permission denied")) {
            pageError =
              "Permission denied. Please check your account permissions and project settings.";
            break;
          }
        }

        return {
          isGenerating,
          freshTurnCount: freshTurns.length,
          pageError,
        };
      },
      baseline.turnCount,
    );

    const currentText = await this.readLatestCleanResponse(page, baseline);

    if (status.pageError && !status.isGenerating && currentText.length === 0) {
      throw new Error(
        `[AI_STUDIO_ERROR] Google AI Studio từ chối yêu cầu: ${status.pageError}`,
      );
    }

    if (
      currentText.length > 0 &&
      currentText !== baseline.previousLatestText
    ) {
      baseline.previousLatestText = currentText;
      baseline.stableCount = 0;
    } else if (currentText.length > 0) {
      baseline.stableCount += 1;
    }

    const isCompleted =
      status.freshTurnCount > 0 &&
      !status.isGenerating &&
      currentText.length > 0 &&
      baseline.stableCount >= 2;

    if (isCompleted) {
      console.log(
        `[ai-studio-worker] Model đã sinh xong hoàn tất (${currentText.length} ký tự).`,
      );
    }

    return {
      text: currentText,
      isGenerating: status.isGenerating,
      isCompleted,
      freshTurnCount: status.freshTurnCount,
      activityKey: [
        status.freshTurnCount,
        status.isGenerating,
        currentText.length,
      ].join(":"),
    };
  }

  protected async extractCompletedResponse(
    page: Page,
    context: BrowserCompletionContext<
      GoogleAIStudioResponseBaseline,
      GoogleAIStudioResponseObservation
    >,
  ): Promise<string> {
    const finalText = await this.readLatestCleanResponse(
      page,
      context.baseline,
    );

    return finalText || context.observation.text;
  }

  protected async resolveConversationId(
    page: Page,
  ): Promise<string | undefined> {
    const deadline = Date.now() + 3_000;

    while (Date.now() < deadline) {
      const promptId = parseGoogleAIStudioPromptId(page.url());
      if (promptId) return promptId;
      await page.waitForTimeout(100);
    }

    return undefined;
  }

  protected async stopGeneration(page: Page): Promise<boolean> {
    const stopLocator = page.locator(this.selectors.stopButton).first();
    const clickedConfiguredStop = await stopLocator
      .click({ timeout: 1_000 })
      .then(() => true)
      .catch(() => false);

    if (clickedConfiguredStop) return true;

    return await page
      .locator("ms-run-button button.stoppable")
      .first()
      .click({ timeout: 1_000 })
      .then(() => true)
      .catch(() => false);
  }

  protected override createResult(
    result: BaseBrowserTurnResult,
  ): GoogleAIStudioTurnResult {
    return {
      rawResponse: result.rawResponse,
      promptId: result.conversationId,
    };
  }
}

export const googleAIStudioBrowserWorker = new GoogleAIStudioBrowserWorker();
