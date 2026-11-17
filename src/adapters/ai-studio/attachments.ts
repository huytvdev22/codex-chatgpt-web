import type { ElectronSurfaceClient } from "../web/electron-surface-client";
import type { NormalizedImageAttachment } from "../web/normalization/canonical-types";
import { AI_STUDIO_DOM_SELECTORS } from "./ai-studio-dom-observer";

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
 * Chuyển đổi danh sách ảnh chuẩn hóa sang payload ảnh cho AI Studio.
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
 * Đính kèm hình ảnh vào Google AI Studio qua sự kiện dán trên Electron surface
 * (tránh dùng CDP filechooser hay mở hộp thoại Finder).
 */
export async function attachAiStudioFiles(
  client: ElectronSurfaceClient,
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

  const result = await client.pasteImages(
    effectiveFiles.map(file => ({
      name: file.name,
      mimeType: file.mimeType,
      dataBase64: file.buffer.toString("base64"),
    })),
    AI_STUDIO_DOM_SELECTORS.composer,
    options?.signal,
  );
  return result.attachedCount > 0;
}

