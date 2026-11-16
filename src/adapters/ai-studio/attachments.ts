import type { Page } from "playwright-core";
import type { NormalizedImageAttachment } from "../web/normalization/canonical-types";

export interface AiStudioImagePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

const MAX_AI_STUDIO_INPUT_IMAGES = 3;

export const AI_STUDIO_MEDIA_SELECTORS = {
  insertButton: 'button[aria-label="Insert images, videos, audio, or files"]',
  menuPanel: 'div.mat-mdc-menu-panel[role="menu"]',
  uploadMenuItem: 'button.mat-mdc-menu-item.upload-file-menu-item',
};

/**
 * Chuyển đổi danh sách ảnh chuẩn hóa sang payload file upload của Playwright.
 */
export function aiStudioImageFilePayloads(
  images: NormalizedImageAttachment[],
): AiStudioImagePayload[] {
  return images.map(img => ({
    name: img.name,
    mimeType: img.mimeType,
    buffer: img.buffer,
  }));
}

/**
 * Đính kèm hình ảnh vào Google AI Studio thông qua nút Insert (+) -> "Upload files" -> filechooser.
 */
export async function attachAiStudioFiles(
  page: Page,
  files: AiStudioImagePayload[],
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<boolean> {
  if (!files || files.length === 0) return false;
  if (options?.signal?.aborted) {
    throw new DOMException("AI Studio file attachment aborted", "AbortError");
  }

  const effectiveFiles = files.length > MAX_AI_STUDIO_INPUT_IMAGES
    ? files.slice(0, MAX_AI_STUDIO_INPUT_IMAGES)
    : files;

  const insertButton = page.locator(AI_STUDIO_MEDIA_SELECTORS.insertButton).first();
  await insertButton.waitFor({ state: "visible", timeout: options?.timeoutMs ?? 8_000 });
  await insertButton.click({ timeout: 3_000 });

  const uploadItem = page.locator(AI_STUDIO_MEDIA_SELECTORS.uploadMenuItem).first();
  await uploadItem.waitFor({ state: "visible", timeout: 4_000 });

  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: options?.timeoutMs ?? 8_000 }),
    uploadItem.click({ timeout: 3_000 }),
  ]);

  await fileChooser.setFiles(effectiveFiles);
  await page.waitForTimeout(500);
  return true;
}

