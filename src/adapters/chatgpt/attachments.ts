import type { Page } from "playwright-core";
import type { NormalizedImageAttachment } from "../web/normalization/canonical-types";
import { CHATGPT_SELECTORS } from "./selectors";

export interface ChatGptAttachmentPayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export function chatGptImageFilePayloads(
  images: readonly NormalizedImageAttachment[],
): ChatGptAttachmentPayload[] {
  return images.slice(0, 3).map((image) => ({
    name: image.name,
    mimeType: image.mimeType,
    buffer: image.buffer,
  }));
}

/**
 * Đính kèm hình ảnh vào composer ChatGPT Web (`chatgpt.com`) tối đa 3 ảnh mỗi lượt,
 * ưu tiên nạp trực tiếp qua `<input type="file">` ẩn của composer và chờ upload xong.
 */
export class ChatGptAttachments {
  public async attachImages(
    page: Page,
    images: readonly NormalizedImageAttachment[],
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!images || images.length === 0) return false;
    if (signal?.aborted) {
      throw new DOMException("ChatGPT image attachment aborted", "AbortError");
    }

    const payloads = chatGptImageFilePayloads(images);
    const directInput = page.locator(CHATGPT_SELECTORS.photoFileInput).first();
    if ((await directInput.count().catch(() => 0)) > 0) {
      await directInput.setInputFiles(payloads);
      await this.waitForUploadSettlement(page, signal);
      return true;
    }

    const addButton = page.locator(CHATGPT_SELECTORS.addFilesButton).first();
    if (!(await addButton.isVisible().catch(() => false))) {
      throw new Error(
        "[chatgpt-attachments] Không tìm thấy thẻ input ảnh hoặc nút đính kèm trên ChatGPT.",
      );
    }

    await addButton.click({ timeout: 3_000 });
    const uploadMenuItem = page
      .locator('[role="menuitem"], button')
      .filter({ hasText: /add photos|upload from computer|tải lên/i })
      .first();

    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 8_000 }),
      uploadMenuItem.click({ timeout: 3_000 }),
    ]);
    await fileChooser.setFiles(payloads);
    await page.keyboard.press("Escape").catch(() => {});
    await this.waitForUploadSettlement(page, signal);
    return true;
  }

  private async waitForUploadSettlement(
    page: Page,
    signal?: AbortSignal,
  ): Promise<void> {
    await page.waitForTimeout(500);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new DOMException("ChatGPT upload aborted", "AbortError");
      }
      const settled = await page
        .evaluate(() => {
          const form = document.querySelector("form");
          if (!form) return true;
          const uploading = form.querySelector(
            '[aria-busy="true"], [role="progressbar"], [data-uploading="true"]',
          );
          if (uploading) return false;
          const sendBtn = form.querySelector<HTMLButtonElement>(
            'button[type="submit"][aria-label="Send"], button[data-testid="send-button"]',
          );
          // Nếu đang có file chưa upload xong, nút Send có thể bị disabled tạm thời.
          return !sendBtn || !sendBtn.disabled;
        })
        .catch(() => true);
      if (settled) return;
      await page.waitForTimeout(250);
    }
  }
}
