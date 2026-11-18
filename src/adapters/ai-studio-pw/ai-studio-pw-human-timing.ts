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
 * Rê chuột tự nhiên (`scrollIntoViewIfNeeded` -> `hover` -> nghỉ ngắn) rồi mới click,
 * kèm fallback click `force` hoặc DOM click khi overlay Angular che khuất.
 */
export async function clickResilient(
  locator: Locator,
  timeoutMs = 3_000,
): Promise<void> {
  const page = locator.page();
  await locator.scrollIntoViewIfNeeded({ timeout: 1_500 }).catch(() => {});
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
 * Chờ script BotGuard (`waa-pa.clients6.google.com` / `google.com/js/th`) nạp xong
 * và trang đạt độ tuổi tối thiểu trước khi gửi request GenerateContent.
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
        const waaReady = resources.some((entry) => {
          const name = String(entry?.name || "");
          return (
            /waa-pa\.clients6\.google\.com|google\.com\/js\/th/i.test(name) &&
            (!Number.isFinite((entry as PerformanceResourceTiming)?.responseEnd) ||
              (entry as PerformanceResourceTiming).responseEnd > 0)
          );
        });
        return { waaReady, pageAgeMs: performance.now() };
      })
      .catch(() => ({ waaReady: false, pageAgeMs: 0 }));

    if (probe.waaReady && probe.pageAgeMs >= minPageAgeMs) return;
    await page.waitForTimeout(150);
  }
}
