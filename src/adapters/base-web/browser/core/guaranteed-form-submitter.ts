import type { Page } from "playwright-core";
import type { ChatSelectorsDto } from "../dto/chat-selectors.dto";

export interface FormSubmitterOptions {
  maxRetries?: number;
  retryDelayMs?: number;
}

/**
 * Trình kích hoạt nút gửi với cơ chế đảm bảo (Guaranteed Form Submitter).
 * Sử dụng chuỗi 4 phương án phối hợp:
 * 1. Playwright Native Pointer Click.
 * 2. DOM Full Pointer Event Sequence (pointerdown, mousedown, pointerup, mouseup, click, form.requestSubmit).
 * 3. Phím tắt ô nhập liệu: Control+Enter.
 * 4. Phím tắt ô nhập liệu: Enter.
 * Tự động dừng ngay lập tức khi phát hiện trạng thái bot đã bắt đầu sinh (Stop Button xuất hiện).
 */
export class GuaranteedFormSubmitter {
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(options?: FormSubmitterOptions) {
    this.maxRetries = options?.maxRetries ?? 10;
    this.retryDelayMs = options?.retryDelayMs ?? 250;
  }

  public async submit(page: Page, selectors: ChatSelectorsDto): Promise<boolean> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      // 1. Kiểm tra xem bot đã chuyển sang generating hay chưa
      const isAlreadyGenerating = await page.evaluate((sel) => {
        const stopBtn = document.querySelector(sel.stopButton);
        const sendBtn = document.querySelector(sel.sendButton);
        const editor = document.querySelector(sel.editor);
        const editorText = editor?.textContent?.trim() || "";
        return Boolean(stopBtn) || (!sendBtn && editorText.length === 0);
      }, selectors).catch(() => false);

      if (isAlreadyGenerating) {
        console.log(`[form-submitter] Đã xác nhận prompt được gửi thành công ở lần thử ${attempt + 1}`);
        return true;
      }

      // 2. Thử kích hoạt nút Send bằng Playwright Native Pointer Click
      try {
        const sendLocator = page.locator(selectors.sendButton).first();
        if (await sendLocator.count() > 0 && await sendLocator.isVisible()) {
          await sendLocator.click({ force: true, timeout: 500 });
          await page.waitForTimeout(150);
          const isNowGenerating = await page.evaluate((sel) => {
            return Boolean(document.querySelector(sel.stopButton));
          }, selectors).catch(() => false);
          if (isNowGenerating) {
            console.log(`[form-submitter] Playwright pointer click thành công ở lần thử ${attempt + 1}`);
            return true;
          }
        }
      } catch {}

      // 3. Dự phòng trong DOM: Dispatch Pointer Event Sequence
      const domSendSuccess = await page.evaluate((sel) => {
        const sendBtn = document.querySelector(sel.sendButton) as HTMLButtonElement | null;
        if (sendBtn && !sendBtn.disabled) {
          sendBtn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
          sendBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          sendBtn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
          sendBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
          sendBtn.click();
          const form = sendBtn.closest("form");
          if (form && typeof (form as any).requestSubmit === "function") {
            (form as any).requestSubmit(sendBtn);
          }
          return true;
        }
        return false;
      }, selectors).catch(() => false);

      if (domSendSuccess) {
        await page.waitForTimeout(150);
        const isNowGenerating = await page.evaluate((sel) => {
          return Boolean(document.querySelector(sel.stopButton));
        }, selectors).catch(() => false);
        if (isNowGenerating) {
          console.log(`[form-submitter] DOM send dispatch thành công ở lần thử ${attempt + 1}`);
          return true;
        }
      }

      // 4. Dự phòng phím tắt: Control+Enter và Enter
      const shouldPressEnter = await page.evaluate((sel) => {
        return !document.querySelector(sel.stopButton);
      }, selectors).catch(() => false);

      if (shouldPressEnter) {
        await page.evaluate((sel) => {
          const editor = document.querySelector(sel.editor) as HTMLElement | null;
          if (editor) editor.focus();
        }, selectors).catch(() => {});
        await page.keyboard.press("Control+Enter").catch(() => {});
        await page.keyboard.press("Enter").catch(() => {});
      }

      await page.waitForTimeout(this.retryDelayMs);
    }

    return false;
  }
}
