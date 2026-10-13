import type { Page } from "playwright-core";
import type { IChatBrowserWorker } from "../contracts/chat-browser-worker.interface";
import type { ChatSelectorsDto } from "../dto/chat-selectors.dto";
import type { BrowserTurnOptionsDto } from "../dto/browser-turn-options.dto";
import type { IModelSelector } from "../../model-selection/contracts/model-selector.interface";

export interface BrowserAttachmentResult {
  readonly page: Page;
  readonly context?: unknown;
}

/**
 * Lớp điều phối trừu tượng hóa cho toàn bộ Web Chat Browser Workers
 * Áp dụng Template Method Pattern để chuẩn hóa quy trình 10 bước tương tác qua CDP/Playwright
 */
export abstract class BaseChatBrowserWorker implements IChatBrowserWorker {
  abstract readonly workerName: string;

  protected abstract readonly selectors: ChatSelectorsDto;
  protected abstract readonly modelSelector?: IModelSelector;

  /**
   * Lấy URL chính của dịch vụ web chat
   */
  abstract getChatUrl(): string;

  // ===========================================================================
  // TEMPLATE METHOD: Quy trình 10 bước thực thi một lượt tương tác (Turn)
  // ===========================================================================
  public async executeTurn(prompt: string, options: BrowserTurnOptionsDto): Promise<string> {
    const startTime = Date.now();
    console.log(`[${this.workerName}] Bắt đầu thực thi turn (promptChars=${prompt.length}, modelSlug=${options.modelSlug || "default"})...`);

    // BƯỚC 1: Kiểm tra tiền điều kiện (Preconditions & AbortSignal)
    this.checkPreconditions(options);

    // BƯỚC 2: Gắn kết nối với Browser Tab (CDP Connection)
    const { page } = await this.attachToBrowser(options);

    // BƯỚC 3: Đảm bảo trang web đang ở đúng URL chat
    await this.preparePageNavigation(page, options);

    // BƯỚC 4: Chờ khung soạn thảo sẵn sàng
    await this.waitForComposerReady(page, options);

    // BƯỚC 5: Đảm bảo Model mong muốn đã được kích hoạt qua ModelSelector
    await this.ensureModelSelected(page, options);

    // BƯỚC 6: Đảm bảo trạng thái Idle (Không còn sinh dở từ lượt trước)
    await this.waitForIdle(page, options);

    // BƯỚC 7: Bơm nội dung prompt và đính kèm tệp/ảnh vào khung soạn thảo
    await this.injectPromptContent(page, prompt, options);

    // BƯỚC 8: Kích hoạt nút Send (Chuỗi sự kiện con trỏ PointerEvents)
    await this.dispatchSend(page, options);

    // BƯỚC 9: Quan sát luồng phản hồi theo thời gian thực (Live DOM Streaming)
    let reply = await this.observeStreamingResponse(page, options);

    // BƯỚC 10: Cứu hộ mã nguồn nếu DOM bị ảo hóa (Virtualization Copy Salvage)
    reply = await this.salvageOutputIfNeeded(page, reply, options);

    const duration = Date.now() - startTime;
    console.log(`[${this.workerName}] Hoàn tất turn trong ${duration}ms (outputChars=${reply.length}).`);
    return reply;
  }

  // ===========================================================================
  // EXTENSION POINTS / ABSTRACT HOOKS (Bắt buộc lớp con override)
  // ===========================================================================

  /**
   * Kết nối tới Launcher Browser Host qua CDP và lấy Page
   */
  protected abstract attachToBrowser(options: BrowserTurnOptionsDto): Promise<BrowserAttachmentResult>;

  /**
   * Bơm nội dung prompt và xử lý ảnh đính kèm
   */
  protected abstract injectPromptContent(page: Page, prompt: string, options: BrowserTurnOptionsDto): Promise<void>;

  /**
   * Quan sát Live DOM và streaming text delta
   */
  protected abstract observeStreamingResponse(page: Page, options: BrowserTurnOptionsDto): Promise<string>;

  // ===========================================================================
  // VIRTUAL HOOKS (Có triển khai mặc định, lớp con có thể tùy biến)
  // ===========================================================================

  protected checkPreconditions(options: BrowserTurnOptionsDto): void {
    if (options.signal?.aborted) {
      throw new DOMException(`[${this.workerName}] Turn aborted before start`, "AbortError");
    }
  }

  protected async preparePageNavigation(page: Page, options: BrowserTurnOptionsDto): Promise<void> {
    const chatUrl = this.getChatUrl();
    if (page.url() !== chatUrl) {
      await page.goto(chatUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    }
  }

  protected async waitForComposerReady(page: Page, options: BrowserTurnOptionsDto): Promise<void> {
    await page.waitForSelector(this.selectors.editor, { timeout: 15_000 });
  }

  protected async ensureModelSelected(page: Page, options: BrowserTurnOptionsDto): Promise<void> {
    if (options.modelSlug && this.modelSelector && "ensureMode" in this.modelSelector) {
      const selector = this.modelSelector as any;
      const targetMode = selector.resolveMode(options.modelSlug, options.reasoning);
      await selector.ensureMode(page, targetMode).catch((err: unknown) => {
        console.warn(`[${this.workerName}] Cảnh báo khi chọn mode '${targetMode}':`, err);
      });
    }
  }

  protected async waitForIdle(page: Page, options: BrowserTurnOptionsDto): Promise<void> {
    await page.evaluate(async (params: { stopSelector: string; editorSelector: string }) => {
      const isIdle = () => {
        const stopBtn = document.querySelector(params.stopSelector);
        const editor = document.querySelector(params.editorSelector);
        const isEditorDisabled = editor?.getAttribute("aria-disabled") === "true";
        return !stopBtn && !isEditorDisabled;
      };

      if (isIdle()) return;
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (isIdle()) {
            clearInterval(interval);
            resolve();
          }
        }, 100);
        setTimeout(() => {
          clearInterval(interval);
          resolve();
        }, 10_000);
      });
    }, {
      stopSelector: this.selectors.stopButton,
      editorSelector: this.selectors.editor,
    }).catch(() => {});
  }

  protected async dispatchSend(page: Page, options: BrowserTurnOptionsDto): Promise<void> {
    await this.dispatchPointerClick(page, this.selectors.sendButton);
  }

  /**
   * Phát chuỗi sự kiện con trỏ đầy đủ để kích hoạt các nút bấm React / Fluent UI phức tạp
   */
  protected async dispatchPointerClick(page: Page, selector: string): Promise<boolean> {
    return page.evaluate((sel: string) => {
      const btn = document.querySelector(sel) as HTMLElement | null;
      if (!btn) return false;

      btn.scrollIntoView({ block: "nearest" });
      const rect = btn.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;

      const evtOpts = {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
      };

      btn.dispatchEvent(new PointerEvent("pointerdown", evtOpts));
      btn.dispatchEvent(new MouseEvent("mousedown", evtOpts));
      btn.dispatchEvent(new PointerEvent("pointerup", evtOpts));
      btn.dispatchEvent(new MouseEvent("mouseup", evtOpts));
      btn.dispatchEvent(new MouseEvent("click", evtOpts));
      btn.click();
      return true;
    }, selector).catch(() => false);
  }

  protected async salvageOutputIfNeeded(page: Page, currentText: string, options: BrowserTurnOptionsDto): Promise<string> {
    // Mặc định không áp dụng cứu hộ nếu lớp con không cài đặt
    return currentText;
  }
}
