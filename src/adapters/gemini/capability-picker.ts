import type { Page } from "playwright-core";
import { GEMINI_SELECTORS } from "./selectors";
import type {
  GeminiCapabilityTarget,
  GeminiThinkingEffort,
} from "./model-provider";

const EFFORT_LABELS: Record<GeminiThinkingEffort, RegExp> = {
  low: /^(?:low|fast)\b/i,
  medium: /^(?:medium|thinking)\b/i,
  high: /^(?:high|pro)\b/i,
};

export interface GeminiCapabilityResult {
  readonly modelSelected: boolean;
  readonly thinkingSelected: boolean;
  readonly reason?: string;
}

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
    const result = await this.ensureCapabilityDetailed(page, target);
    return result.modelSelected && result.thinkingSelected;
  }

  public async ensureCapabilityDetailed(
    page: Page,
    target: GeminiCapabilityTarget,
  ): Promise<GeminiCapabilityResult> {
    const trigger = page.locator(GEMINI_SELECTORS.modePickerTrigger).first();
    if (!(await trigger.isVisible().catch(() => false))) {
      if (target.isAccountDefault && !target.remoteModelId) {
        return { modelSelected: true, thinkingSelected: false };
      }
      return {
        modelSelected: false,
        thinkingSelected: false,
        reason: `Không tìm thấy nút Mode Picker trên giao diện Gemini để chọn '${target.modelLabel || target.modelSlug}'.`,
      };
    }

    const cacheKey = `${target.modelSlug}:${target.remoteModelId ?? ""}:${target.thinkingEffort}`;
    if (this.appliedByPage.get(page) === cacheKey) {
      return { modelSelected: true, thinkingSelected: true };
    }

    try {
      await trigger.click({ timeout: 2_500 });
      const menu = page.locator(GEMINI_SELECTORS.modeMenu).first();
      await menu.waitFor({ state: "visible", timeout: 2_500 });

      const modelOutcome = await this.ensureModelOrModeSelected(page, target);
      const thinkingSelected = modelOutcome.selected
        ? await this.ensureThinkingLevel(page, target.thinkingEffort).catch(() => false)
        : false;

      await this.closePickerIfOpen(page);
      if (modelOutcome.selected && thinkingSelected) {
        this.appliedByPage.set(page, cacheKey);
      }
      return {
        modelSelected: modelOutcome.selected,
        thinkingSelected,
        ...(modelOutcome.reason ? { reason: modelOutcome.reason } : {}),
      };
    } catch (error) {
      await this.closePickerIfOpen(page);
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[gemini-capability] Không thể chuyển model='${target.modelSlug}' effort='${target.thinkingEffort}':`,
        error,
      );
      return {
        modelSelected: false,
        thinkingSelected: false,
        reason: message,
      };
    }
  }

  private async isItemDisabled(item: ReturnType<Page["locator"]>): Promise<boolean> {
    const ariaDisabled = await item.getAttribute("aria-disabled").catch(() => null);
    if (ariaDisabled === "true") return true;
    const disabledAttr = await item.getAttribute("disabled").catch(() => null);
    if (disabledAttr !== null && disabledAttr !== "false") return true;
    return await item.isDisabled().catch(() => false);
  }

  private async ensureModelOrModeSelected(
    page: Page,
    target: GeminiCapabilityTarget,
  ): Promise<{ selected: boolean; reason?: string }> {
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
      return { selected: true };
    }

    const items = menu.locator(GEMINI_SELECTORS.modeRadioItem);
    const count = await items.count();
    if (count === 0) {
      if (target.isAccountDefault && !target.remoteModelId) {
        return { selected: true };
      }
      return {
        selected: false,
        reason: "Menu Mode Picker của Gemini không có lựa chọn model nào.",
      };
    }

    // Nếu có remoteModelId (data-mode-id từ Auto-Discovery), ưu tiên khớp chính xác.
    if (target.remoteModelId) {
      const byId = menu
        .locator(`gem-menu-item[data-mode-id="${target.remoteModelId}"]`)
        .first();
      if (await byId.isVisible().catch(() => false)) {
        const checked = await byId.getAttribute("aria-checked").catch(() => "");
        if (checked !== "true") {
          if (await this.isItemDisabled(byId)) {
            return {
              selected: false,
              reason: `Model '${target.modelLabel || target.modelSlug}' đang bị khóa/vô hiệu hóa trên tài khoản Gemini.`,
            };
          }
          await byId.click({ timeout: 2_000 });
          await page.waitForTimeout(250);
          // Click mode item thường đóng menu -> mở lại nếu còn bước Thinking level
          await this.reopenMenuIfClosed(page);
        }
        return { selected: true };
      }
    }

    // Nếu có modelLabel cụ thể (vd "4 Neon", "4 Hydrogen", "Deeper analysis", "Pro")
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
            if (await this.isItemDisabled(item)) {
              return {
                selected: false,
                reason: `Model '${target.modelLabel}' đang bị khóa/vô hiệu hóa trên tài khoản Gemini.`,
              };
            }
            await item.click({ timeout: 2_000 });
            await page.waitForTimeout(250);
            await this.reopenMenuIfClosed(page);
          }
          return { selected: true };
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
            if (await this.isItemDisabled(item)) {
              return {
                selected: false,
                reason: `Chế độ '${text}' đang bị khóa/vô hiệu hóa trên tài khoản Gemini.`,
              };
            }
            await item.click({ timeout: 2_000 });
            await page.waitForTimeout(250);
          }
          return { selected: true };
        }
      }
    }

    return {
      selected: false,
      reason: `Không tìm thấy model '${target.modelLabel || target.modelSlug}' trong menu Gemini Web.`,
    };
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

    return false;
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
