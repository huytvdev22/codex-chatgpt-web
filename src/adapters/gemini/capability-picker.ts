import type { Page } from "playwright-core";
import type {
  GeminiCapabilityTarget,
  GeminiThinkingEffort,
} from "./model-provider";
import { GEMINI_SELECTORS } from "./selectors";

const EFFORT_LABELS: Record<GeminiThinkingEffort, RegExp> = {
  low: /^(?:low|fast)\b/i,
  medium: /^(?:medium|thinking)\b/i,
  high: /^(?:high|pro)\b/i,
};

/**
 * Điều khiển Mode Picker, Thinking level submenu và Temporary Chat trên Gemini Web (`gemini.google.com`).
 */
export class GeminiCapabilityPicker {
  private readonly appliedByPage = new WeakMap<Page, string>();

  public clearCache(page: Page): void {
    this.appliedByPage.delete(page);
  }

  /**
   * Bật Temporary Chat (best-effort) cho các lượt ephemeral (`retain: false`)
   * để không lưu rác vào lịch sử hội thoại Gemini.
   */
  public async ensureTemporaryChat(page: Page): Promise<boolean> {
    const alreadyOff = await page
      .locator(GEMINI_SELECTORS.tempChatOffButton)
      .first()
      .isVisible()
      .catch(() => false);
    if (alreadyOff) return true;

    const turnOnBtn = page.locator(GEMINI_SELECTORS.tempChatOnButton).first();
    if (!(await turnOnBtn.isVisible().catch(() => false))) {
      return false;
    }

    await turnOnBtn.click({ timeout: 2_000 }).catch(() => {});
    const confirmed = await page
      .locator(GEMINI_SELECTORS.tempChatOffButton)
      .first()
      .waitFor({ state: "visible", timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    return confirmed;
  }

  public async ensureCapability(
    page: Page,
    target: GeminiCapabilityTarget,
  ): Promise<boolean> {
    const trigger = page.locator(GEMINI_SELECTORS.modePickerTrigger).first();
    if (!(await trigger.isVisible().catch(() => false))) {
      return false;
    }

    const cacheKey = `${target.modelSlug}:${target.remoteModelId ?? ""}:${target.thinkingEffort}`;
    if (this.appliedByPage.get(page) === cacheKey) {
      return true;
    }

    try {
      await trigger.click({ timeout: 2_500 });
      const menu = page.locator(GEMINI_SELECTORS.modeMenu).first();
      await menu.waitFor({ state: "visible", timeout: 2_500 });

      const modelSelected = await this.ensureModelOrModeSelected(page, target);
      const thinkingSelected = await this.ensureThinkingLevel(
        page,
        target.thinkingEffort,
      );

      await this.closePickerIfOpen(page);
      if (modelSelected && thinkingSelected) {
        this.appliedByPage.set(page, cacheKey);
      }
      return modelSelected && thinkingSelected;
    } catch (error) {
      await this.closePickerIfOpen(page);
      console.warn(
        `[gemini-capability] Không thể chuyển model='${target.modelSlug}' effort='${target.thinkingEffort}':`,
        error,
      );
      return false;
    }
  }

  private async ensureModelOrModeSelected(
    page: Page,
    target: GeminiCapabilityTarget,
  ): Promise<boolean> {
    const menu = page.locator(GEMINI_SELECTORS.modeMenu).first();
    const hasThinkingSubmenu = await menu
      .locator(GEMINI_SELECTORS.thinkingLevelTrigger)
      .first()
      .isVisible()
      .catch(() => false);

    // Nếu dùng slug mặc định `gemini` trên giao diện có submenu Thinking level (vd 4 Hydrogen / 4 Neon),
    // giữ model hiện tại (trừ khi đang đứng ở "Auto" không có submenu Thinking level) và để bước Thinking level chỉnh độ sâu.
    if (
      target.isAccountDefault &&
      !target.remoteModelId &&
      !target.modelLabel &&
      hasThinkingSubmenu
    ) {
      return true;
    }

    const items = menu.locator(GEMINI_SELECTORS.modeRadioItem);
    const count = await items.count();
    if (count === 0) return true;

    // Nếu có remoteModelId (data-mode-id từ Auto-Discovery), ưu tiên khớp chính xác.
    if (target.remoteModelId) {
      const byId = menu
        .locator(`gem-menu-item[data-mode-id="${target.remoteModelId}"]`)
        .first();
      if (await byId.isVisible().catch(() => false)) {
        const checked = await byId.getAttribute("aria-checked").catch(() => "");
        if (checked !== "true") {
          await byId.click({ timeout: 2_000 });
          await page.waitForTimeout(250);
          // Click mode item thường đóng menu -> mở lại nếu còn bước Thinking level
          await this.reopenMenuIfClosed(page);
        }
        return true;
      }
    }

    // Nếu có modelLabel cụ thể (vd "4 Neon", "Deeper analysis", "Pro")
    const normalizedLabel = target.modelLabel?.trim().toLowerCase();
    if (normalizedLabel) {
      for (let i = 0; i < count; i += 1) {
        const item = items.nth(i);
        const text = ((await item.innerText().catch(() => "")) || "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (text.includes(normalizedLabel)) {
          const checked = await item.getAttribute("aria-checked").catch(() => "");
          if (checked !== "true") {
            await item.click({ timeout: 2_000 });
            await page.waitForTimeout(250);
            await this.reopenMenuIfClosed(page);
          }
          return true;
        }
      }
    }

    // Fallback UI Gemini dạng Fast / Thinking / Pro (không có submenu thinking_level)
    if (!hasThinkingSubmenu) {
      const effortRegex = EFFORT_LABELS[target.thinkingEffort];
      for (let i = 0; i < count; i += 1) {
        const item = items.nth(i);
        const text = ((await item.innerText().catch(() => "")) || "")
          .replace(/\s+/g, " ")
          .trim();
        if (effortRegex.test(text)) {
          const checked = await item.getAttribute("aria-checked").catch(() => "");
          if (checked !== "true") {
            await item.click({ timeout: 2_000 });
            await page.waitForTimeout(250);
          }
          return true;
        }
      }
    }

    return true;
  }

  private async ensureThinkingLevel(
    page: Page,
    effort: GeminiThinkingEffort,
  ): Promise<boolean> {
    const menu = page.locator(GEMINI_SELECTORS.modeMenu).first();
    if (!(await menu.isVisible().catch(() => false))) {
      await this.reopenMenuIfClosed(page);
    }
    const thinkingTrigger = menu
      .locator(GEMINI_SELECTORS.thinkingLevelTrigger)
      .first();
    if (!(await thinkingTrigger.isVisible().catch(() => false))) {
      return true;
    }

    const submenuId = await thinkingTrigger
      .getAttribute("aria-controls")
      .catch(() => null);
    await thinkingTrigger.hover().catch(() => {});
    await page.waitForTimeout(220);

    const submenu = submenuId
      ? page.locator(`#${submenuId}`)
      : page.locator(".submenu-container gem-menu").last();

    if (!(await submenu.isVisible().catch(() => false))) {
      await thinkingTrigger.click({ timeout: 1_500 }).catch(() => {});
      await page.waitForTimeout(220);
    }

    const subItems = submenu.locator('gem-menu-item[role="menuitemradio"]');
    const subCount = await subItems.count();
    const matcher = EFFORT_LABELS[effort];
    for (let i = 0; i < subCount; i += 1) {
      const item = subItems.nth(i);
      const text = ((await item.innerText().catch(() => "")) || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!matcher.test(text)) continue;

      const checked = await item.getAttribute("aria-checked").catch(() => "");
      if (checked !== "true") {
        await item.click({ timeout: 2_000 });
        await page.waitForTimeout(200);
      }
      return true;
    }

    return true;
  }

  private async reopenMenuIfClosed(page: Page): Promise<void> {
    const menu = page.locator(GEMINI_SELECTORS.modeMenu).first();
    if (await menu.isVisible().catch(() => false)) return;
    const trigger = page.locator(GEMINI_SELECTORS.modePickerTrigger).first();
    if (await trigger.isVisible().catch(() => false)) {
      await trigger.click({ timeout: 2_000 }).catch(() => {});
      await menu.waitFor({ state: "visible", timeout: 2_000 }).catch(() => {});
    }
  }

  private async closePickerIfOpen(page: Page): Promise<void> {
    const menu = page.locator(GEMINI_SELECTORS.modeMenu).first();
    if (await menu.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(120);
    }
  }
}
