import type { Locator, Page } from "playwright-core";

/**
 * Nghỉ ngẫu nhiên trong khoảng `[minMs, maxMs]` để mô phỏng nhịp thao tác tự nhiên,
 * tránh chuỗi hành động đều tăm tắp dễ bị BotGuard gắn cờ.
 */
export async function humanPause(
  page: Page,
  minMs: number,
  maxMs: number,
): Promise<void> {
  const low = Math.max(0, Math.round(minMs));
  const high = Math.max(low, Math.round(maxMs));
  const duration =
    low === high ? low : low + Math.floor(Math.random() * (high - low + 1));
  await page.waitForTimeout(duration);
}

/**
 * Di chuyển chuột mượt theo nhiều bước về tâm phần tử mục tiêu để tạo quỹ đạo pointer tự nhiên cho BotGuard.
 */
export async function moveMouseToLocator(
  page: Page,
  locator: Locator,
): Promise<void> {
  if (
    typeof page.mouse?.move !== "function" ||
    typeof locator.boundingBox !== "function"
  ) {
    return;
  }
  try {
    const box = await locator.boundingBox({ timeout: 1_000 });
    if (!box || box.width <= 0 || box.height <= 0) return;
    const jitterX = (Math.random() - 0.5) * Math.min(12, box.width * 0.25);
    const jitterY = (Math.random() - 0.5) * Math.min(8, box.height * 0.25);
    await page.mouse.move(
      box.x + box.width / 2 + jitterX,
      box.y + box.height / 2 + jitterY,
      { steps: 5 },
    );
  } catch {
    // Non-fatal: locator có thể vừa di chuyển hoặc mock không có boundingBox
  }
}

/**
 * Rê chuột tự nhiên (`scrollIntoViewIfNeeded` -> `mouse.move` -> `hover` -> nghỉ ngắn) rồi mới click,
 * kèm fallback click `force` hoặc DOM click khi overlay Angular che khuất.
 */
export async function clickResilient(
  locator: Locator,
  timeoutMs = 3_000,
): Promise<void> {
  const page = locator.page();
  await locator.scrollIntoViewIfNeeded({ timeout: 1_500 }).catch(() => {});
  await moveMouseToLocator(page, locator);
  await locator.hover({ timeout: 1_000 }).catch(() => {});
  await humanPause(page, 140, 280);
  try {
    await locator.click({ timeout: timeoutMs });
  } catch (firstError) {
    try {
      await locator.click({ force: true, timeout: Math.min(timeoutMs, 1_500) });
    } catch {
      const clicked = await locator
        .evaluate((el) => {
          const node = el as HTMLElement;
          node.scrollIntoView?.({ block: "center", inline: "center" });
          node.click();
          return true;
        })
        .catch(() => false);
      if (!clicked) throw firstError;
    }
  }
}

/**
 * Điền nội dung vào input/textarea theo nhịp tự nhiên: cuộn -> hover -> click focus -> điền -> nghỉ.
 */
export async function fillFieldNatural(
  page: Page,
  selector: string,
  value: string,
  optional = false,
): Promise<boolean> {
  const loc = page.locator(selector).first();
  const visible = await loc.isVisible().catch(() => false);
  if (!visible) {
    if (optional) return false;
    throw new Error(`Input not found: ${selector}`);
  }
  await loc.scrollIntoViewIfNeeded({ timeout: 1_500 }).catch(() => {});
  await loc.hover({ timeout: 1_000 }).catch(() => {});
  await humanPause(page, 160, 300);
  await loc.click({ timeout: 2_000 }).catch(() => {});
  await humanPause(page, 260, 460);
  await loc.fill(value);
  await humanPause(page, 380, 650);
  return true;
}

/**
 * Nhập văn bản tự nhiên qua sự kiện bàn phím thật (`keyboard.type` / `keyboard.insertText`)
 * để kích hoạt đầy đủ chuỗi `keydown`/`keyup`/`input` thay vì `locator.fill()` tức thì `0ms`.
 * Trả về `false` nếu `Page` mock không hỗ trợ `keyboard` để caller rơi về `fill()` an toàn.
 */
export async function typeHumanPrompt(
  page: Page,
  locator: Locator,
  promptText: string,
): Promise<boolean> {
  if (
    typeof page.keyboard?.type !== "function" ||
    typeof page.keyboard?.insertText !== "function"
  ) {
    return false;
  }

  const existingValue = await locator.inputValue().catch(() => "");
  if (existingValue.length > 0 && typeof page.keyboard.press === "function") {
    const selectAllShortcut = process.platform === "darwin" ? "Meta+a" : "Control+a";
    await page.keyboard.press(selectAllShortcut).catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await humanPause(page, 80, 150);
  }

  if (promptText.length === 0) {
    return true;
  }

  if (promptText.length <= 180) {
    await page.keyboard.type(promptText, { delay: 14 });
    return true;
  }

  const head = promptText.slice(0, 18);
  const middle = promptText.slice(18, -10);
  const tail = promptText.slice(-10);
  await page.keyboard.type(head, { delay: 15 });
  if (middle.length > 0) {
    await page.keyboard.insertText(middle);
  }
  await page.keyboard.type(tail, { delay: 15 });
  return true;
}

export const AI_STUDIO_WELCOME_DIALOG_SELECTOR =
  "#g1-welcome-dialog, ms-g1-welcome-dialog, mat-dialog-container:has(ms-g1-welcome-dialog), mat-dialog-container:has(ms-tos-disclaimer)";

export const AI_STUDIO_WELCOME_DIALOG_ACTION_SELECTOR = [
  "#g1-welcome-dialog [mat-dialog-actions] button.ms-button-primary",
  "#g1-welcome-dialog button.ms-button-primary",
  "#g1-welcome-dialog [mat-dialog-actions] button",
  "ms-g1-welcome-dialog [mat-dialog-actions] button.ms-button-primary",
  "ms-g1-welcome-dialog button.ms-button-primary",
  "ms-g1-welcome-dialog [mat-dialog-actions] button",
  "mat-dialog-container:has(ms-tos-disclaimer) [mat-dialog-actions] button.ms-button-primary",
  "mat-dialog-container:has(ms-tos-disclaimer) [mat-dialog-actions] button",
].join(", ");

/**
 * Tự động phát hiện và bấm nút `Continue` trên hộp thoại chào mừng/điều khoản
 * Google AI Studio (`#g1-welcome-dialog` / `ms-g1-welcome-dialog` / `ms-tos-disclaimer`)
 * để gỡ lớp backdrop chặn mọi thao tác chọn model, nhập prompt hoặc bấm Run.
 * Trả về `true` nếu đã đóng ít nhất một hộp thoại, `false` nếu không xuất hiện (chi phí gần như 0ms).
 */
export async function dismissAiStudioWelcomeDialogs(
  page: Page,
): Promise<boolean> {
  if (typeof (page as { locator?: unknown }).locator !== "function") {
    return false;
  }

  let dismissedAny = false;
  const dialog = page.locator(AI_STUDIO_WELCOME_DIALOG_SELECTOR).first();
  const actionBtn = page.locator(AI_STUDIO_WELCOME_DIALOG_ACTION_SELECTOR).first();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dialogVisible = await dialog.isVisible().catch(() => false);
    if (!dialogVisible) break;

    let clicked = false;
    const btnVisible = await actionBtn.isVisible().catch(() => false);
    if (btnVisible) {
      const ariaDisabled = await actionBtn
        .getAttribute?.("aria-disabled")
        .catch(() => null);
      if (ariaDisabled !== "true") {
        await clickResilient(actionBtn, 2_000).catch(async () => {
          await actionBtn.click({ force: true, timeout: 1_500 }).catch(() => {});
        });
        clicked = true;
      }
    }

    if (!clicked && typeof page.evaluate === "function") {
      clicked = await page
        .evaluate(() => {
          const container =
            document.querySelector<HTMLElement>("#g1-welcome-dialog") ||
            document.querySelector<HTMLElement>("ms-g1-welcome-dialog") ||
            document
              .querySelector<HTMLElement>("ms-tos-disclaimer")
              ?.closest<HTMLElement>("mat-dialog-container");
          if (!container) return false;
          const btn =
            container.querySelector<HTMLButtonElement>(
              "[mat-dialog-actions] button.ms-button-primary:not([disabled]):not([aria-disabled='true'])",
            ) ||
            container.querySelector<HTMLButtonElement>(
              "button.ms-button-primary:not([disabled]):not([aria-disabled='true'])",
            ) ||
            container.querySelector<HTMLButtonElement>(
              "[mat-dialog-actions] button:not([disabled]):not([aria-disabled='true'])",
            ) ||
            container.querySelector<HTMLButtonElement>(
              'button[aria-label="Close dialog"]:not([disabled]):not([aria-disabled="true"])',
            );
          if (!btn) return false;
          btn.click();
          return true;
        })
        .catch(() => false);
    }

    if (!clicked) break;
    dismissedAny = true;

    await dialog
      .waitFor?.({ state: "hidden", timeout: 2_500 })
      .catch(() => {});
    await humanPause(page, 180, 320);

    const stillVisible = await dialog.isVisible().catch(() => false);
    if (stillVisible) {
      // Nếu modal chưa tắt ngay sau lần click đầu, đợi ngắn trước khi thử lại vòng tiếp theo
      await page.waitForTimeout(200);
    }
  }

  return dismissedAny;
}

/**
 * Chờ script BotGuard (`waa-pa.clients6.google.com` & `www.google.com/js/bg/...` hoặc `/js/th`) nạp xong
 * và trang đạt độ tuổi tối thiểu trước khi gửi `GenerateContent`.
 */
export async function waitForBotGuardReady(
  page: Page,
  minPageAgeMs: number,
  maxWaitMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const probe = await page
      .evaluate(() => {
        const resources = performance.getEntriesByType("resource") || [];
        let waaDone = false;
        let bgScriptDone = false;
        for (const entry of resources) {
          const name = String(entry?.name || "");
          const responseEnd = (entry as PerformanceResourceTiming)?.responseEnd;
          const loaded = !Number.isFinite(responseEnd) || responseEnd > 0;
          if (!loaded) continue;
          if (/waa-pa\.clients6\.google\.com/i.test(name)) {
            waaDone = true;
          }
          if (/www\.google\.com\/js\/(?:bg|th)\/|google\.com\/js\/th/i.test(name)) {
            bgScriptDone = true;
          }
        }
        return {
          waaReady: waaDone,
          bgScriptDone,
          pageAgeMs: performance.now(),
        };
      })
      .catch(() => ({ waaReady: false, bgScriptDone: false, pageAgeMs: 0 }));

    if (probe.waaReady && probe.pageAgeMs >= minPageAgeMs) {
      return;
    }
    await page.waitForTimeout(150);
  }
}
