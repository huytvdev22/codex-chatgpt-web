import type { Locator, Page } from "playwright-core";
import type {
  ImageAspectRatio,
  ImageTurnResult,
  RawTurnImageInput,
} from "../base";
import type { NormalizedImageAttachment } from "../web/normalization/canonical-types";
import { GeminiAttachments } from "./attachments";
import { GeminiCapabilityPicker } from "./capability-picker";
import {
  buildGeminiConversationUrl,
  GEMINI_HOME_URL,
  GEMINI_ORIGIN,
  isGeminiAuthUrl,
  parseGeminiConversationId,
  waitForGeminiConversationId,
} from "./conversation-url";
import {
  GEMINI_DEFAULT_MODEL_SLUG,
  GeminiModelProvider,
} from "./model-provider";
import { GEMINI_SELECTORS } from "./selectors";

export interface GeminiImageRunOptions {
  modelSlug?: string;
  reasoning?: string;
  prompt: string;
  aspectRatio?: ImageAspectRatio;
  images?: RawTurnImageInput[];
  outputFormat?: "png" | "jpeg" | "webp";
  existingConversationId?: string;
  signal?: AbortSignal;
  heartbeat?: () => Promise<void>;
  hardTimeoutMs?: number;
}

/**
 * Lỗi chuyên biệt khi Gemini Web từ chối tạo ảnh (policy/safety) hoặc chỉ trả về phản hồi văn bản.
 */
export class GeminiImageRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiImageRefusalError";
  }
}

const GEMINI_WEB_ERROR_REGEX =
  /something went wrong|you['’]ve reached.*limit|rate limit|too many requests|try again later|network error|session has expired|couldn['’]t generate|unavailable/i;

/**
 * Worker Playwright điều khiển chế độ `Create image` trên Gemini Web (`gemini.google.com`)
 * thông qua tab Launcher độc lập: bật mode `Images`, chọn tỉ lệ khung hình, đính kèm ảnh sửa,
 * gửi prompt, phát hiện lỗi/từ chối và trích xuất ảnh PNG độ phân giải gốc qua `<canvas>`.
 */
export class GeminiImageWorker {
  private readonly defaultHardTimeoutMs = 5 * 60_000;
  private readonly defaultHeartbeatIntervalMs = 10_000;
  private readonly capabilityPicker = new GeminiCapabilityPicker();
  private readonly attachments = new GeminiAttachments();

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new DOMException("Gemini image turn aborted", "AbortError");
    }
  }

  private assertNotAuthRedirect(url: string): void {
    if (isGeminiAuthUrl(url)) {
      throw new Error(
        "[Gemini] Phiên đăng nhập đã hết hạn hoặc bị chuyển sang trang đăng nhập Google. Vui lòng Sign in with Chrome lại trên Launcher.",
      );
    }
  }

  private async findVisibleLocator(
    page: Page,
    selector: string,
  ): Promise<Locator | undefined> {
    const locators = page.locator(selector);
    const count = await locators.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locators.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }
    return undefined;
  }

  public async executeImageTurn(
    page: Page,
    options: GeminiImageRunOptions,
  ): Promise<ImageTurnResult> {
    this.throwIfAborted(options.signal);

    const currentUrl = page.url();
    this.assertNotAuthRedirect(currentUrl);
    const currentConversationId = parseGeminiConversationId(currentUrl);

    if (options.existingConversationId) {
      if (currentConversationId !== options.existingConversationId) {
        this.capabilityPicker.clearCache(page);
        await page.goto(
          buildGeminiConversationUrl(options.existingConversationId),
          {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          },
        );
      }
    } else if (!currentUrl.startsWith(GEMINI_ORIGIN) || currentConversationId) {
      this.capabilityPicker.clearCache(page);
      await page.goto(GEMINI_HOME_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    }
    this.assertNotAuthRedirect(page.url());

    await this.waitForVisibleComposer(page, 20_000, options.signal);
    await this.waitForComposerIdle(page);

    // Đồng bộ model & thinking effort khớp với phiên Gemini đang chat, KHÔNG bật Temporary Chat
    // để người dùng vẫn giữ lại lịch sử ảnh trên tài khoản Gemini.
    const target = GeminiModelProvider.getInstance().resolveCapabilityTarget(
      options.modelSlug || GEMINI_DEFAULT_MODEL_SLUG,
      options.reasoning,
    );
    await this.capabilityPicker
      .ensureCapability(page, target)
      .catch((error) => {
        console.warn(
          "[gemini-image-worker] Không thể đồng bộ Mode/Thinking level:",
          error,
        );
      });

    await this.ensureImageCreationMode(page, options.signal);
    await this.ensureImageFormat(page);
    if (options.aspectRatio) {
      await this.ensureAspectRatio(page, options.aspectRatio);
    }

    if (options.images && options.images.length > 0) {
      const normalizedImages: NormalizedImageAttachment[] = options.images
        .slice(0, 3)
        .map((image, index) => ({
          ref: `gemini-edit-img-${index}`,
          name: image.name || `image-${index + 1}.png`,
          mimeType: image.mimeType,
          dataUrl: image.dataUrl,
          buffer: image.buffer,
        }));
      await this.attachments.attachImages(page, normalizedImages, options.signal);
    }

    const baselineResponseCount = await page
      .locator(GEMINI_SELECTORS.assistantResponse)
      .count()
      .catch(() => 0);

    await this.insertPrompt(page, options.prompt, options.signal);
    await this.submitPrompt(page, options.signal);

    const imageResult = await this.waitForGeneratedImage(
      page,
      baselineResponseCount,
      options,
    );
    const resolvedConversationId =
      options.existingConversationId ||
      parseGeminiConversationId(page.url()) ||
      (await waitForGeminiConversationId(page, 6_000, options.signal));

    return {
      ...imageResult,
      ...(resolvedConversationId ? { conversationId: resolvedConversationId } : {}),
    };
  }

  private async ensureImageCreationMode(
    page: Page,
    signal?: AbortSignal,
  ): Promise<void> {
    this.throwIfAborted(signal);
    const alreadyActive = await page
      .locator(GEMINI_SELECTORS.deselectImagesChip)
      .first()
      .isVisible()
      .catch(() => false);
    if (alreadyActive) return;

    const uploadBtn = page.locator(GEMINI_SELECTORS.uploadAndToolsButton).first();
    if (!(await uploadBtn.isVisible().catch(() => false))) {
      throw new Error(
        "[gemini-image-worker] Không tìm thấy nút Upload & tools để bật chế độ tạo ảnh.",
      );
    }

    await uploadBtn.click({ timeout: 3_000 });
    await page.waitForTimeout(350);

    const createImageItem = page
      .locator(GEMINI_SELECTORS.createImageMenuItem)
      .filter({ hasText: /create\s+image|tạo\s+hình\s+ảnh/i })
      .first();

    if (!(await createImageItem.isVisible().catch(() => false))) {
      await page.keyboard.press("Escape").catch(() => {});
      throw new Error(
        "[gemini-image-worker] Không tìm thấy tùy chọn 'Create image' trong menu Upload & tools.",
      );
    }

    const checked = await createImageItem.getAttribute("aria-checked").catch(() => "");
    if (checked !== "true") {
      await createImageItem.click({ timeout: 3_000 });
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }

    await page
      .locator(GEMINI_SELECTORS.deselectImagesChip)
      .first()
      .waitFor({ state: "visible", timeout: 5_000 });
  }

  private async findCompanionChipButton(
    page: Page,
    kind: "aspectRatio" | "format",
  ): Promise<Locator | undefined> {
    const primarySelector =
      kind === "aspectRatio"
        ? GEMINI_SELECTORS.aspectRatioChipButton
        : GEMINI_SELECTORS.formatChipButton;
    const byAria = await this.findVisibleLocator(page, primarySelector);
    if (byAria) return byAria;

    const textMatcher =
      kind === "aspectRatio"
        ? /^(?:aspect\s*ratio|tỉ\s*lệ(?:\s*khung\s*hình)?|1:1|16:9|9:16|4:3|3:4)$/i
        : /^(?:format|định\s*dạng|image|gif)$/i;

    const candidates = page.locator(GEMINI_SELECTORS.companionChipButtons);
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const btn = candidates.nth(index);
      if (!(await btn.isVisible().catch(() => false))) continue;
      const aria = ((await btn.getAttribute("aria-label").catch(() => "")) || "").trim();
      const text = ((await btn.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (
        (kind === "aspectRatio" && /^aspect\s*ratio/i.test(aria)) ||
        (kind === "format" && /^format/i.test(aria)) ||
        textMatcher.test(text)
      ) {
        return btn;
      }
    }
    return undefined;
  }

  private async ensureImageFormat(page: Page): Promise<void> {
    const formatBtn = await this.findCompanionChipButton(page, "format");
    if (!formatBtn) return;

    const aria = ((await formatBtn.getAttribute("aria-label").catch(() => "")) || "").trim();
    const text = ((await formatBtn.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (/^format,\s*image$/i.test(aria) || /^image$/i.test(text)) {
      return;
    }
    // Khi mới bật Create image lần đầu, button hiển thị "Format" và Gemini mặc định chọn sẵn Image;
    // chỉ mở menu nếu hiện đang bị chuyển sang GIF để tránh thao tác thừa.
    if (!/gif/i.test(aria) && !/^gif$/i.test(text)) {
      return;
    }

    await formatBtn.click({ timeout: 2_500 }).catch(() => {});
    await page.waitForTimeout(250);
    const imageOption = page
      .locator(GEMINI_SELECTORS.companionMenuRadioItem)
      .filter({ hasText: /^image$/i })
      .first();
    if (await imageOption.isVisible().catch(() => false)) {
      await imageOption.click({ timeout: 2_000 }).catch(() => {});
      await page.waitForTimeout(200);
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }
  }

  private async ensureAspectRatio(
    page: Page,
    aspectRatio: ImageAspectRatio,
  ): Promise<void> {
    let aspectBtn = await this.findCompanionChipButton(page, "aspectRatio");
    if (!aspectBtn) {
      for (let waitAttempt = 0; waitAttempt < 3; waitAttempt += 1) {
        await page.waitForTimeout(300);
        aspectBtn = await this.findCompanionChipButton(page, "aspectRatio");
        if (aspectBtn) break;
      }
    }
    if (!aspectBtn) {
      console.warn(
        `[gemini-image-worker] Không tìm thấy nút Aspect ratio để đặt tỉ lệ ${aspectRatio}; dùng mặc định của Gemini.`,
      );
      return;
    }

    const aria = ((await aspectBtn.getAttribute("aria-label").catch(() => "")) || "").trim();
    const text = ((await aspectBtn.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (
      aria.toLowerCase() === `aspect ratio, ${aspectRatio}`.toLowerCase() ||
      text === aspectRatio
    ) {
      return;
    }

    await aspectBtn.click({ timeout: 2_500 });
    await page.waitForTimeout(250);

    const byAria = page
      .locator(`${GEMINI_SELECTORS.companionMenuRadioItem}[aria-label="${aspectRatio}"]`)
      .first();
    const targetOption = (await byAria.isVisible().catch(() => false))
      ? byAria
      : page
          .locator(GEMINI_SELECTORS.companionMenuRadioItem)
          .filter({ hasText: aspectRatio })
          .first();

    if (!(await targetOption.isVisible().catch(() => false))) {
      await page.keyboard.press("Escape").catch(() => {});
      console.warn(
        `[gemini-image-worker] Menu Aspect ratio không có lựa chọn ${aspectRatio}; dùng mặc định của Gemini.`,
      );
      return;
    }

    const checked = await targetOption.getAttribute("aria-checked").catch(() => "");
    if (checked !== "true") {
      await targetOption.click({ timeout: 2_000 });
      await page.waitForTimeout(250);
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }
  }

  private async insertPrompt(
    page: Page,
    promptText: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.throwIfAborted(signal);
    await this.waitForVisibleComposer(page, 15_000, signal);
    await page.bringToFront().catch(() => {});

    const composerLocator = await this.findVisibleLocator(
      page,
      GEMINI_SELECTORS.composer,
    );
    if (!composerLocator) {
      throw new Error(
        "[gemini-image-worker] Không tìm thấy ô nhập liệu đang hiển thị để chèn prompt.",
      );
    }

    await composerLocator.click({ timeout: 3_000 });
    await composerLocator.focus({ timeout: 2_000 }).catch(() => {});

    const selectAllKey = process.platform === "darwin" ? "Meta+a" : "Control+a";
    await page.keyboard.press(selectAllKey);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(80);

    let fillSuccess = false;
    try {
      await composerLocator.fill(promptText, { timeout: 10_000 });
      fillSuccess = true;
    } catch {
      fillSuccess = false;
    }

    const expectedCompactLen = promptText.replace(/\r?\n/g, "").trim().length;
    const actualLength = fillSuccess
      ? ((await composerLocator.textContent({ timeout: 2_000 }).catch(() => "")) ?? "").trim().length
      : 0;
    if (!fillSuccess || actualLength < expectedCompactLen * 0.9) {
      await page.evaluate(
        ({ selector, text }) => {
          const candidates = Array.from(
            document.querySelectorAll<HTMLElement>(selector),
          );
          const editor =
            candidates.find((el) => {
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            }) ?? candidates[0];
          if (!editor) return;
          editor.focus();
          editor.replaceChildren();
          for (const line of text.split(/\r?\n/)) {
            const p = document.createElement("p");
            if (line.length > 0) {
              p.textContent = line;
            } else {
              p.appendChild(document.createElement("br"));
            }
            editor.appendChild(p);
          }
          editor.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              inputType: "insertText",
            }),
          );
          editor.dispatchEvent(new Event("input", { bubbles: true }));
          editor.dispatchEvent(new Event("change", { bubbles: true }));
        },
        { selector: GEMINI_SELECTORS.composer, text: promptText },
      );
      await page.waitForTimeout(250);
    }

    const sendLocator = await this.findVisibleLocator(
      page,
      GEMINI_SELECTORS.sendButton,
    );
    const isSendEnabled = sendLocator
      ? await sendLocator.isEnabled({ timeout: 500 }).catch(() => false)
      : false;
    if (!isSendEnabled) {
      await composerLocator.focus({ timeout: 1_500 }).catch(() => {});
      await page.keyboard.press("Space").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
      await page.waitForTimeout(180);
    }
  }

  private async submitPrompt(page: Page, signal?: AbortSignal): Promise<void> {
    const composerLocator = await this.findVisibleLocator(
      page,
      GEMINI_SELECTORS.composer,
    );
    if (!composerLocator) {
      throw new Error(
        "[gemini-image-worker] Không tìm thấy composer đang hiển thị để gửi prompt.",
      );
    }

    const submitDeadline = Date.now() + 15_000;
    let attempt = 0;
    let clickedAtLeastOnce = false;

    while (Date.now() < submitDeadline) {
      this.throwIfAborted(signal);
      attempt += 1;

      const stopVisible = await this.findVisibleLocator(
        page,
        GEMINI_SELECTORS.stopButton,
      );
      const composerText = (
        (await composerLocator.textContent({ timeout: 1_500 }).catch(() => "")) ?? ""
      ).trim();

      if (
        Boolean(stopVisible) ||
        (clickedAtLeastOnce && composerText.length === 0)
      ) {
        return;
      }

      if (!clickedAtLeastOnce && composerText.length === 0) {
        throw new Error(
          "[gemini-image-worker] Composer trống trước khi bấm nút Send.",
        );
      }

      const sendLocator = await this.findVisibleLocator(
        page,
        GEMINI_SELECTORS.sendButton,
      );
      const canClickSend = sendLocator
        ? await sendLocator.isEnabled({ timeout: 300 }).catch(() => false)
        : false;

      if (sendLocator && canClickSend) {
        const clickOk = await sendLocator
          .click({ timeout: 1_500 })
          .then(() => true)
          .catch(() => false);
        if (clickOk) {
          clickedAtLeastOnce = true;
        }
      } else if (attempt >= 2 && attempt % 2 === 0) {
        await composerLocator.focus().catch(() => {});
        await page.keyboard.press("Space").catch(() => {});
        await page.keyboard.press("Backspace").catch(() => {});
      }

      await page.waitForTimeout(350);
    }

    throw new Error(
      "[gemini-image-worker] Không thể xác nhận prompt tạo ảnh đã được gửi trong 15 giây.",
    );
  }

  private async waitForGeneratedImage(
    page: Page,
    baselineResponseCount: number,
    options: GeminiImageRunOptions,
  ): Promise<ImageTurnResult> {
    const hardTimeoutMs = options.hardTimeoutMs ?? this.defaultHardTimeoutMs;
    const deadline = Date.now() + hardTimeoutMs;
    let lastHeartbeatAt = Date.now();
    let seenGenerating = false;
    let textOnlyStableCycles = 0;

    while (Date.now() < deadline) {
      if (options.signal?.aborted) {
        await this.stopGeneration(page).catch(() => {});
        throw new DOMException("Gemini image turn aborted", "AbortError");
      }

      if (
        options.heartbeat &&
        Date.now() - lastHeartbeatAt >= this.defaultHeartbeatIntervalMs
      ) {
        lastHeartbeatAt = Date.now();
        await options.heartbeat().catch(() => {});
      }

      const snapshot = await page.evaluate(
        ({
          responseSel,
          stopSel,
          errorSel,
          copyBtnSel,
          redoBtnSel,
          thinkingSel,
          baselineCount,
        }) => {
          const isVisible = (el: Element): boolean => {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            const style = window.getComputedStyle(el);
            return style.display !== "none" && style.visibility !== "hidden";
          };

          const stopVisible = Array.from(
            document.querySelectorAll(stopSel),
          ).some(isVisible);

          let detectedWebError = "";
          for (const banner of document.querySelectorAll<HTMLElement>(errorSel)) {
            if (banner.closest(responseSel)) continue;
            if (!isVisible(banner)) continue;
            const txt = (banner.innerText || banner.textContent || "").trim();
            if (
              txt &&
              /something went wrong|limit|error|expired|too many|try again|unavailable/i.test(
                txt,
              )
            ) {
              detectedWebError = txt.replace(/\s+/g, " ").slice(0, 300);
              break;
            }
          }

          const responses = Array.from(
            document.querySelectorAll<HTMLElement>(responseSel),
          );
          if (responses.length <= baselineCount) {
            return {
              hasNewResponse: false,
              isGenerating: stopVisible,
              detectedWebError,
              hasReadyImage: false,
              imageSrc: "",
              hasCopyControl: false,
              responseText: "",
            };
          }

          const latest = responses[responses.length - 1]!;
          const panel =
            latest.querySelector<HTMLElement>(
              "message-content .markdown-main-panel",
            ) ||
            latest.querySelector<HTMLElement>("message-content") ||
            latest;
          const isBusy = panel.getAttribute("aria-busy") === "true";
          const isGenerating = stopVisible || isBusy;

          const images = Array.from(
            latest.querySelectorAll<HTMLImageElement>(
              "generated-image img, single-image img, img.image",
            ),
          );
          const readyImg = images.find(
            (img) =>
              Boolean(img.src) &&
              img.complete &&
              img.naturalWidth > 100 &&
              img.naturalHeight > 100,
          );

          const hasCopyControl = Boolean(
            latest.querySelector(copyBtnSel) ||
              latest.querySelector(redoBtnSel),
          );

          const clone = panel.cloneNode(true) as HTMLElement;
          for (const noise of clone.querySelectorAll(`${thinkingSel}, button`)) {
            noise.remove();
          }
          const responseText = (clone.textContent || "").trim();

          return {
            hasNewResponse: true,
            isGenerating,
            detectedWebError,
            hasReadyImage: Boolean(readyImg),
            imageSrc: readyImg?.src || "",
            hasCopyControl,
            responseText,
          };
        },
        {
          responseSel: GEMINI_SELECTORS.assistantResponse,
          stopSel: GEMINI_SELECTORS.stopButton,
          errorSel: GEMINI_SELECTORS.errorBanner,
          copyBtnSel: GEMINI_SELECTORS.copyAssistantResponseButton,
          redoBtnSel: GEMINI_SELECTORS.redoButton,
          thinkingSel: GEMINI_SELECTORS.thinkingContainers,
          baselineCount: baselineResponseCount,
        },
      );

      if (
        snapshot.detectedWebError &&
        GEMINI_WEB_ERROR_REGEX.test(snapshot.detectedWebError)
      ) {
        throw new Error(`[Gemini Web Error] ${snapshot.detectedWebError}`);
      }

      if (snapshot.isGenerating) {
        seenGenerating = true;
      }

      if (snapshot.hasReadyImage && !snapshot.isGenerating) {
        const extracted = await this.extractLatestImageAsPng(
          page,
          baselineResponseCount,
          snapshot.imageSrc,
        );
        if (extracted) {
          return extracted;
        }
      }

      if (
        snapshot.hasNewResponse &&
        !snapshot.isGenerating &&
        !snapshot.hasReadyImage &&
        snapshot.responseText
      ) {
        textOnlyStableCycles += 1;
        if (
          snapshot.hasCopyControl ||
          textOnlyStableCycles >= (seenGenerating ? 3 : 6)
        ) {
          throw new GeminiImageRefusalError(
            `Gemini Web không trả về hình ảnh: ${snapshot.responseText.slice(0, 400)}`,
          );
        }
      } else {
        textOnlyStableCycles = 0;
      }

      await page.waitForTimeout(300);
    }

    throw new Error(
      `Gemini Web image generation timed out after ${hardTimeoutMs}ms`,
    );
  }

  private async extractLatestImageAsPng(
    page: Page,
    baselineResponseCount: number,
    imageSrc: string,
  ): Promise<ImageTurnResult | null> {
    const canvasDataUrl = await page
      .evaluate(
        ({ responseSel, baselineCount }) => {
          const responses = Array.from(
            document.querySelectorAll<HTMLElement>(responseSel),
          );
          if (responses.length <= baselineCount) return null;
          const latest = responses[responses.length - 1]!;
          const images = Array.from(
            latest.querySelectorAll<HTMLImageElement>(
              "generated-image img, single-image img, img.image",
            ),
          );
          const readyImg = images.find(
            (img) =>
              Boolean(img.src) &&
              img.complete &&
              img.naturalWidth > 100 &&
              img.naturalHeight > 100,
          );
          if (!readyImg) return null;
          try {
            const canvas = document.createElement("canvas");
            canvas.width = readyImg.naturalWidth;
            canvas.height = readyImg.naturalHeight;
            const ctx = canvas.getContext("2d");
            if (!ctx) return null;
            ctx.drawImage(readyImg, 0, 0);
            const dataUrl = canvas.toDataURL("image/png");
            return dataUrl.startsWith("data:image/png;base64,") ? dataUrl : null;
          } catch {
            return null;
          }
        },
        {
          responseSel: GEMINI_SELECTORS.assistantResponse,
          baselineCount: baselineResponseCount,
        },
      )
      .catch(() => null);

    if (canvasDataUrl) {
      const base64 = canvasDataUrl.slice("data:image/png;base64,".length);
      if (base64.length > 0) {
        return {
          imageBase64: base64,
          mimeType: "image/png",
        };
      }
    }

    if (imageSrc && /^https?:\/\//i.test(imageSrc)) {
      const response = await page.request.get(imageSrc).catch(() => null);
      if (response && response.ok()) {
        const body = await response.body();
        if (body.length > 0) {
          const contentType =
            response.headers()["content-type"]?.split(";")[0]?.trim() ||
            "image/png";
          return {
            imageBase64: body.toString("base64"),
            mimeType: contentType,
          };
        }
      }
    }

    return null;
  }

  private async stopGeneration(page: Page): Promise<boolean> {
    const stopBtn = await this.findVisibleLocator(
      page,
      GEMINI_SELECTORS.stopButton,
    );
    if (!stopBtn) return false;
    return await stopBtn
      .click({ timeout: 1_500 })
      .then(() => true)
      .catch(() => false);
  }

  private async waitForVisibleComposer(
    page: Page,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.throwIfAborted(signal);
      const visible = await this.findVisibleLocator(
        page,
        GEMINI_SELECTORS.composer,
      );
      if (visible) return;
      await page.waitForTimeout(100);
    }
    throw new Error(
      `[gemini-image-worker] Không tìm thấy ô nhập liệu Gemini hiển thị sau ${timeoutMs}ms.`,
    );
  }

  private async waitForComposerIdle(page: Page): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const stopBtn = await this.findVisibleLocator(
        page,
        GEMINI_SELECTORS.stopButton,
      );
      if (!stopBtn) return;
      await page.waitForTimeout(250);
    }
  }
}
