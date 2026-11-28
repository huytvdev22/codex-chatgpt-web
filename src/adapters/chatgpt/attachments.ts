import type { Page } from "playwright-core";
import type { NormalizedImageAttachment } from "../web/normalization/canonical-types";
import { CHATGPT_SELECTORS } from "./selectors";

export interface ChatGptAttachmentPayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export interface ChatGptAttachmentOptions {
  settlementTimeoutMs?: number;
  pollIntervalMs?: number;
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
    options?: ChatGptAttachmentOptions,
  ): Promise<boolean> {
    if (!images || images.length === 0) return false;
    if (signal?.aborted) {
      throw new DOMException("ChatGPT image attachment aborted", "AbortError");
    }

    const payloads = chatGptImageFilePayloads(images);
    const directInput = page.locator(CHATGPT_SELECTORS.photoFileInput).first();
    if ((await directInput.count().catch(() => 0)) > 0) {
      await directInput.setInputFiles(payloads);
      await this.waitForUploadSettlement(page, signal, options);
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
    await page.keyboard?.press("Escape").catch(() => {});
    await this.waitForUploadSettlement(page, signal, options);
    return true;
  }

  private async waitForUploadSettlement(
    page: Page,
    signal?: AbortSignal,
    options?: ChatGptAttachmentOptions,
  ): Promise<void> {
    const timeoutMs = options?.settlementTimeoutMs ?? 15_000;
    const pollIntervalMs = options?.pollIntervalMs ?? 250;
    const initialDelayMs = Math.min(
      500,
      Math.max(0, Math.floor(timeoutMs / 3)),
    );
    if (initialDelayMs > 0 && typeof page.waitForTimeout === "function") {
      await page.waitForTimeout(initialDelayMs);
    }

    const deadline = Date.now() + Math.max(0, timeoutMs);
    let instantPolls = 0;
    let lastReason = "";

    while (true) {
      if (signal?.aborted) {
        throw new DOMException("ChatGPT upload aborted", "AbortError");
      }
      if (typeof page.isClosed === "function" && page.isClosed()) {
        throw new Error(
          "[chatgpt-attachments] Trang ChatGPT đã đóng trước khi upload ảnh hoàn tất.",
        );
      }

      const status = await page
        .evaluate(
          ({ sendSelector, errorSelector }) => {
            const form = document.querySelector("form");
            if (!form) {
              return { settled: false, reason: "missing-form" };
            }

            const errorNodes = Array.from(
              form.querySelectorAll<HTMLElement>(errorSelector),
            );
            for (const node of errorNodes) {
              const rect = node.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) continue;
              const text = (node.innerText || node.textContent || "").trim();
              if (
                text &&
                /error|fail|unable|unsupported|too large|limit|lỗi|thất bại|không thể/i.test(
                  text,
                )
              ) {
                return {
                  settled: false,
                  fatalError: text.replace(/\s+/g, " ").slice(0, 240),
                };
              }
            }

            const uploading = form.querySelector(
              '[aria-busy="true"], [role="progressbar"], [data-uploading="true"]',
            );
            if (uploading) {
              return { settled: false, reason: "uploading" };
            }

            const sendBtn = form.querySelector<HTMLButtonElement>(sendSelector);
            // Nếu đang có file chưa upload xong, nút Send có thể bị disabled tạm thời.
            if (
              sendBtn &&
              (sendBtn.disabled ||
                sendBtn.getAttribute("aria-disabled") === "true")
            ) {
              return { settled: false, reason: "send-disabled" };
            }

            return { settled: true };
          },
          {
            sendSelector: CHATGPT_SELECTORS.sendButton,
            errorSelector: CHATGPT_SELECTORS.errorBanner,
          },
        )
        .catch((error) => ({
          settled: false,
          reason: error instanceof Error ? error.message : String(error),
        }));

      if (
        typeof status === "object" &&
        status !== null &&
        "fatalError" in status &&
        status.fatalError
      ) {
        throw new Error(
          `[chatgpt-attachments] Upload ảnh đính kèm lên ChatGPT thất bại: ${status.fatalError}`,
        );
      }
      if (status && status.settled === true) {
        return;
      }
      if (
        typeof status === "object" &&
        status !== null &&
        "reason" in status &&
        status.reason
      ) {
        lastReason = String(status.reason);
      }

      if (timeoutMs <= 0 || Date.now() >= deadline) {
        break;
      }
      if (typeof page.waitForTimeout !== "function") {
        break;
      }

      const before = Date.now();
      await page.waitForTimeout(pollIntervalMs);
      const elapsed = Date.now() - before;
      if (elapsed < 15) {
        instantPolls += 1;
        if (instantPolls >= 5) {
          break;
        }
      } else {
        instantPolls = 0;
      }
    }

    throw new Error(
      `[chatgpt-attachments] Không thể xác nhận upload ảnh đính kèm lên ChatGPT hoàn tất (${lastReason || "timeout"}).`,
    );
  }
}
