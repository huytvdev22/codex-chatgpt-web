import type { Page } from "playwright-core";
import type { NormalizedImageAttachment } from "../normalization/canonical-types";

export interface M365ImagePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/**
 * Chuyển đổi danh sách NormalizedImageAttachment sang M365ImagePayload để nạp vào Playwright
 */
export function m365ImageFilePayloads(images: NormalizedImageAttachment[]): M365ImagePayload[] {
  return images.map(img => ({
    name: img.name,
    mimeType: img.mimeType,
    buffer: img.buffer,
  }));
}

export const PLUS_MENU_SELECTORS = {
  plusButton: [
    'button[data-testid="PlusMenuButton"]',
    '#plus-menu-container button',
    'button[aria-label="Add and manage sources"]',
    'button[aria-label*="manage sources" i]',
    'button[aria-label*="Add" i][aria-haspopup="menu"]',
  ].join(", "),
  popover: [
    '[data-testid="PlusMenuPopover"]',
    '.fui-MenuPopover',
  ].join(", "),
  uploadMenuItem: [
    '[data-testid="PlusMenuPopover"] [role="menuitem"]',
    '.fui-MenuPopover [role="menuitem"]',
    '[role="menuitem"]',
  ].join(", "),
  fileInput: 'input[type="file"]',
};

export interface AttachFilesOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Đính kèm hình ảnh/tệp tin vào M365 Copilot Web thông qua Menu Plus (Phương án 1)
 * Quy trình:
 * 1. Mở menu Plus (nếu chưa mở)
 * 2. Đón chặn sự kiện filechooser bằng Playwright CDP
 * 3. Click menuitem "Upload images and files"
 * 4. Đẩy danh sách file payloads vào fileChooser
 * 5. Chờ upload và giao diện ổn định
 */
export async function attachFilesViaPlusMenu(
  page: Page,
  files: M365ImagePayload[],
  options?: AttachFilesOptions
): Promise<boolean> {
  if (!files || files.length === 0) {
    return false;
  }

  // M365 Copilot chỉ cho phép tối đa 3 ảnh/files trong 1 lần gửi
  let effectiveFiles = files;
  if (effectiveFiles.length > 3) {
    console.warn(
      `[m365-attachments] Số lượng file (${effectiveFiles.length}) vượt quá giới hạn 3 ảnh của M365 Copilot. Chỉ giữ lại 3 file.`
    );
    effectiveFiles = effectiveFiles.slice(0, 3);
  }

  console.log(`[m365-attachments] Bắt đầu quy trình đính kèm ${effectiveFiles.length} ảnh/file vào M365 Copilot...`);

  if (options?.signal?.aborted) {
    throw new DOMException("Đã hủy lượt đính kèm file do nhận tín hiệu abort", "AbortError");
  }

  const popover = page.locator(PLUS_MENU_SELECTORS.popover).first();
  const plusButton = page.locator(PLUS_MENU_SELECTORS.plusButton).first();

  // 1. Kiểm tra xem Popover đã hiển thị chưa, nếu chưa thì mở
  let isPopoverVisible = await popover.isVisible().catch(() => false);
  if (!isPopoverVisible) {
    const hasPlusButton = (await plusButton.count().catch(() => 0)) > 0;
    if (hasPlusButton) {
      console.log(`[m365-attachments] Đang click nút Plus Menu [data-testid="PlusMenuButton"]...`);
      await plusButton.click({ timeout: 4000, force: true }).catch(err => {
        console.warn(`[m365-attachments] Click Plus button thất bại hoặc đã mở:`, err?.message);
      });
      isPopoverVisible = await popover.waitFor({ state: "visible", timeout: 4000 }).then(() => true).catch(() => false);
    }
  }

  // 2. Định vị mục "Upload images and files" trong menu Popover
  let uploadTarget = popover.locator('[role="menuitem"]').filter({
    hasText: /Upload images and files/i,
  }).first();

  let targetFound = isPopoverVisible && (await uploadTarget.count().catch(() => 0)) > 0;

  // Dự phòng tìm kiếm từ khóa upload nếu ngôn ngữ giao diện khác
  if (!targetFound && isPopoverVisible) {
    const fallbackTarget = popover.locator('[role="menuitem"]').filter({
      hasText: /upload|tải lên|images and files|attach/i,
    }).first();
    if ((await fallbackTarget.count().catch(() => 0)) > 0) {
      uploadTarget = fallbackTarget;
      targetFound = true;
    }
  }

  // 3. Thực hiện kích hoạt upload
  if (targetFound) {
    try {
      console.log(`[m365-attachments] Bắt sự kiện filechooser và click "Upload images and files"...`);
      const [fileChooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 10_000 }),
        uploadTarget.click({ timeout: 4000, force: true }),
      ]);

      await fileChooser.setFiles(effectiveFiles);
      console.log(`[m365-attachments] Đã nạp thành công ${effectiveFiles.length} file vào FileChooser!`);
    } catch (err: any) {
      console.warn(`[m365-attachments] FileChooser interception thất bại: ${err?.message}, thử fallback input file...`);
      const directInput = page.locator(PLUS_MENU_SELECTORS.fileInput).first();
      if ((await directInput.count().catch(() => 0)) > 0) {
        await directInput.setInputFiles(effectiveFiles);
        console.log(`[m365-attachments] Fallback setInputFiles vào input[type="file"] thành công!`);
      } else {
        throw new Error(`Không thể đính kèm file qua Plus Menu: ${err?.message}`);
      }
    }
  } else {
    // Nếu không thấy popover hoặc menuitem, thử fallback sang thẻ input[type="file"] có sẵn
    console.log(`[m365-attachments] Popover không mở được, thử tìm thẻ input[type="file"] trực tiếp...`);
    const directInput = page.locator(PLUS_MENU_SELECTORS.fileInput).first();
    if ((await directInput.count().catch(() => 0)) > 0) {
      await directInput.setInputFiles(effectiveFiles);
      console.log(`[m365-attachments] Set trực tiếp vào input[type="file"] thành công!`);
    } else {
      throw new Error(`Không tìm thấy nút "Upload images and files" hoặc thẻ input file để đính kèm!`);
    }
  }

  // 4. Đóng popover nếu vẫn còn mở (nhấn phím Escape)
  if (await popover.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape").catch(() => {});
  }

  // 5. Chờ ngắn (600ms) để React cập nhật attachment card lên DOM
  await new Promise(r => setTimeout(r, 600));

  return true;
}
