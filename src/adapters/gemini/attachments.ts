import type { Page } from "playwright-core";
import type { NormalizedImageAttachment } from "../web/normalization/canonical-types";
import { GEMINI_SELECTORS } from "./selectors";

export interface GeminiAttachmentPayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export function geminiImageFilePayloads(
  images: readonly NormalizedImageAttachment[],
): GeminiAttachmentPayload[] {
  return images.slice(0, 3).map((image) => ({
    name: image.name,
    mimeType: image.mimeType,
    buffer: image.buffer,
  }));
}

/**
 * Đính kèm hình ảnh vào composer Gemini Web (`gemini.google.com`), tối đa 3 ảnh/lượt.
 * Gemini mount `<input type="file">` ẩn sau khi mở menu `Upload & tools`.
 */
export class GeminiAttachments {
  public async attachImages(
    page: Page,
    images: readonly NormalizedImageAttachment[],
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!images || images.length === 0) return false;
    if (signal?.aborted) {
      throw new DOMException("Gemini image attachment aborted", "AbortError");
    }

    const payloads = geminiImageFilePayloads(images);
    const menuOverlay = page.locator(
      '.cdk-overlay-pane gem-menu, .cdk-overlay-pane [role="menu"]',
    );
    const isMenuOpen = (await menuOverlay.count().catch(() => 0)) > 0;
    if (!isMenuOpen) {
      const uploadBtn = page.locator(GEMINI_SELECTORS.uploadAndToolsButton).first();
      if (!(await uploadBtn.isVisible().catch(() => false))) {
        throw new Error(
          "[gemini-attachments] Không tìm thấy nút Upload & tools trên Gemini.",
        );
      }
      await uploadBtn.click({ timeout: 3_000 });
    }

    const imageInput = page.locator(GEMINI_SELECTORS.imageFileInput).first();
    await imageInput
      .waitFor({ state: "attached", timeout: 3_000 })
      .catch(() => {});

    if ((await imageInput.count().catch(() => 0)) > 0) {
      await imageInput.setInputFiles(payloads);
      await page.waitForTimeout(300);
      if ((await menuOverlay.count().catch(() => 0)) > 0) {
        await page.keyboard.press("Escape").catch(() => {});
      }
      await this.waitForUploadSettlement(page, signal);
      return true;
    }

    const uploadFilesItem = page
      .locator('[role="menuitem"]')
      .filter({ hasText: /upload files|upload image|tải tệp/i })
      .first();
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 8_000 }),
      uploadFilesItem.click({ timeout: 3_000 }),
    ]);
    await fileChooser.setFiles(payloads);
    await page.waitForTimeout(300);
    if ((await menuOverlay.count().catch(() => 0)) > 0) {
      await page.keyboard.press("Escape").catch(() => {});
    }
    await this.waitForUploadSettlement(page, signal);
    return true;
  }

  private async waitForUploadSettlement(
    page: Page,
    signal?: AbortSignal,
  ): Promise<void> {
    await page.waitForTimeout(350);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new DOMException("Gemini upload aborted", "AbortError");
      }
      const settled = await page
        .evaluate(
          ({ previewSel, loadingSel, sendSel }) => {
            const hasPreview = Boolean(document.querySelector(previewSel));
            if (!hasPreview) return false;
            const stillLoading = Boolean(document.querySelector(loadingSel));
            if (stillLoading) return false;
            const sendBtn = document.querySelector<HTMLButtonElement>(sendSel);
            return !sendBtn || !sendBtn.disabled;
          },
          {
            previewSel: GEMINI_SELECTORS.attachmentPreview,
            loadingSel: GEMINI_SELECTORS.attachmentLoading,
            sendSel: GEMINI_SELECTORS.sendButton,
          },
        )
        .catch(() => false);
      if (settled) return;
      await page.waitForTimeout(250);
    }
    throw new Error(
      "[gemini-attachments] Không thấy preview ảnh đính kèm hoàn tất sau 15 giây.",
    );
  }
}
