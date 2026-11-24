import type { Page } from "playwright-core";
import type {
  ChatGptCapabilityTarget,
  ChatGptThinkingEffort,
} from "./model-provider";
import { CHATGPT_SELECTORS } from "./selectors";

const EFFORT_TO_SLIDER_STEP: Record<ChatGptThinkingEffort, number> = {
  none: 0,
  medium: 1,
  high: 2,
};

/**
 * Điều khiển popover Model Switcher & Power/Thinking Slider của ChatGPT Web (`chatgpt.com`).
 */
export class ChatGptCapabilityPicker {
  private readonly appliedByPage = new WeakMap<Page, string>();

  public clearCache(page: Page): void {
    this.appliedByPage.delete(page);
  }

  public async ensureCapability(
    page: Page,
    target: ChatGptCapabilityTarget,
  ): Promise<boolean> {
    const trigger = page.locator(CHATGPT_SELECTORS.modelPickerTrigger).first();
    const triggerVisible = await trigger.isVisible().catch(() => false);
    if (!triggerVisible) {
      return await this.ensureFreeThinkToggle(page, target.thinkingEffort);
    }

    const cacheKey = `${target.modelSlug}:${target.thinkingEffort}`;
    const currentEffortAttr = (
      (await trigger.getAttribute("data-selected-reasoning-effort").catch(() => "")) ||
      ""
    )
      .trim()
      .toLowerCase();

    if (
      this.appliedByPage.get(page) === cacheKey &&
      currentEffortAttr === target.thinkingEffort
    ) {
      return true;
    }

    try {
      await trigger.click({ timeout: 2_000 });
      const menu = page.locator(CHATGPT_SELECTORS.openPickerMenu).last();
      await menu.waitFor({ state: "visible", timeout: 2_000 });

      const modelSelected = await this.ensureModelSelected(page, target);
      const effortAdjusted = await this.ensureThinkingEffort(page, target.thinkingEffort);

      await this.closePickerMenuIfOpen(page);
      if (modelSelected && effortAdjusted) {
        this.appliedByPage.set(page, cacheKey);
      }
      return modelSelected && effortAdjusted;
    } catch (error) {
      await this.closePickerMenuIfOpen(page);
      if (!(await trigger.isVisible().catch(() => false))) {
        return await this.ensureFreeThinkToggle(page, target.thinkingEffort);
      }
      console.warn(
        `[chatgpt-capability] Không thể chuyển model='${target.modelLabel}' effort='${target.thinkingEffort}':`,
        error,
      );
      return false;
    }
  }

  private async ensureModelSelected(
    page: Page,
    target: ChatGptCapabilityTarget,
  ): Promise<boolean> {
    const menu = page.locator(CHATGPT_SELECTORS.openPickerMenu).last();

    // Kiểm tra nhanh khi đang ở view simple:
    // - Nếu là model mặc định của tài khoản, nút "Reset to default" sẽ không xuất hiện.
    // - Nếu là model có shortUiVersion (vd: "6", "5.6"), toggle text sẽ bắt đầu bằng tiền tố đó.
    const quickMatch = await menu
      .evaluate(
        (menuEl, { toggleSel, expectedShort, isDefault }) => {
          const toggle = menuEl.querySelector<HTMLElement>(toggleSel);
          const hasReset = Array.from(
            menuEl.querySelectorAll<HTMLElement>('[role="menuitem"]'),
          ).some((el) => /reset to default/i.test(el.textContent || ""));
          if (isDefault && !hasReset) {
            return true;
          }
          if (!toggle || !expectedShort) return false;
          const firstLine = (toggle.innerText || toggle.textContent || "")
            .trim()
            .split(/\r?\n/)[0]
            ?.trim();
          return firstLine?.toLowerCase() === expectedShort.toLowerCase();
        },
        {
          toggleSel: CHATGPT_SELECTORS.modelViewToggle,
          expectedShort: target.shortUiVersion ?? "",
          isDefault: Boolean(target.isAccountDefault),
        },
      )
      .catch(() => false);

    if (quickMatch) {
      return true;
    }

    const viewToggle = menu.locator(CHATGPT_SELECTORS.modelViewToggle).first();
    if (!(await viewToggle.isVisible().catch(() => false))) {
      return false;
    }

    await viewToggle.click({ timeout: 2_500 });
    await page.waitForTimeout(180);

    const radios = menu.locator(CHATGPT_SELECTORS.modelRadioItem);
    await radios.first().waitFor({ state: "visible", timeout: 2_500 }).catch(() => {});

    const radioCount = await radios.count();
    let matchedIndex = -1;
    let alreadyChecked = false;
    const normalizedTarget = target.modelLabel.trim().toLowerCase();

    for (let index = 0; index < radioCount; index += 1) {
      const radio = radios.nth(index);
      const label = ((await radio.innerText().catch(() => "")) || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (!label) continue;
      if (label === normalizedTarget || label.startsWith(`${normalizedTarget} `)) {
        matchedIndex = index;
        alreadyChecked =
          (await radio.getAttribute("aria-checked").catch(() => "")) === "true";
        break;
      }
    }

    if (matchedIndex < 0) {
      for (let index = 0; index < radioCount; index += 1) {
        const radio = radios.nth(index);
        const label = ((await radio.innerText().catch(() => "")) || "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (label.includes(normalizedTarget)) {
          matchedIndex = index;
          alreadyChecked =
            (await radio.getAttribute("aria-checked").catch(() => "")) === "true";
          break;
        }
      }
    }

    if (matchedIndex < 0) {
      console.warn(
        `[chatgpt-capability] Không tìm thấy model '${target.modelLabel}' trong danh sách ChatGPT.`,
      );
      return false;
    }

    const targetRadio = radios.nth(matchedIndex);
    await targetRadio.click({ timeout: 2_500 });
    await page.waitForTimeout(220);

    // Nếu chọn radio làm đóng hẳn menu thì mở lại trigger để bước tiếp theo chỉnh slider.
    const menuStillOpen = await menu.isVisible().catch(() => false);
    if (!menuStillOpen) {
      const trigger = page.locator(CHATGPT_SELECTORS.modelPickerTrigger).first();
      if (await trigger.isVisible().catch(() => false)) {
        await trigger.click({ timeout: 2_500 });
        await menu.waitFor({ state: "visible", timeout: 2_500 }).catch(() => {});
      }
    }

    if (alreadyChecked) {
      // Nếu menu vẫn đang ở danh sách radio vì model đã checked từ trước, bấm lại nếu cần quay về simple view.
      const sliderVisible = await menu
        .locator(CHATGPT_SELECTORS.reasoningSliderItem)
        .first()
        .isVisible()
        .catch(() => false);
      if (!sliderVisible) {
        await this.closePickerMenuIfOpen(page);
        const trigger = page.locator(CHATGPT_SELECTORS.modelPickerTrigger).first();
        if (await trigger.isVisible().catch(() => false)) {
          await trigger.click({ timeout: 2_500 });
          await menu.waitFor({ state: "visible", timeout: 2_500 }).catch(() => {});
        }
      }
    }

    return true;
  }

  private async ensureThinkingEffort(
    page: Page,
    targetEffort: ChatGptThinkingEffort,
  ): Promise<boolean> {
    const trigger = page.locator(CHATGPT_SELECTORS.modelPickerTrigger).first();
    const currentAttr = (
      (await trigger.getAttribute("data-selected-reasoning-effort").catch(() => "")) ||
      ""
    )
      .trim()
      .toLowerCase();
    if (currentAttr === targetEffort) {
      return true;
    }

    const menu = page.locator(CHATGPT_SELECTORS.openPickerMenu).last();
    if (!(await menu.isVisible().catch(() => false))) {
      return false;
    }

    const sliderRow = menu.locator(CHATGPT_SELECTORS.reasoningSliderItem).first();
    const sliderThumb = menu.locator(CHATGPT_SELECTORS.reasoningSliderThumb).first();
    if (!(await sliderRow.isVisible().catch(() => false))) {
      return true;
    }

    const bounds = await sliderThumb
      .evaluate((el) => ({
        min: Number(el.getAttribute("aria-valuemin") ?? "0"),
        max: Number(el.getAttribute("aria-valuemax") ?? "2"),
        now: Number(el.getAttribute("aria-valuenow") ?? "1"),
      }))
      .catch(() => ({ min: 0, max: 2, now: 1 }));

    const desiredRaw = EFFORT_TO_SLIDER_STEP[targetEffort] ?? 1;
    const clampedTarget = Math.max(
      bounds.min,
      Math.min(bounds.max, desiredRaw),
    );
    if (bounds.now === clampedTarget) {
      return true;
    }

    await sliderRow.click({ timeout: 2_000 }).catch(() => {});
    for (let step = 0; step < 5; step += 1) {
      const nowValue = await sliderThumb
        .getAttribute("aria-valuenow")
        .then((val) => Number(val))
        .catch(() => Number.NaN);
      if (nowValue === clampedTarget) {
        return true;
      }
      if (!Number.isFinite(nowValue)) break;
      const key = nowValue < clampedTarget ? "ArrowRight" : "ArrowLeft";
      await page.keyboard.press(key);
      await page.waitForTimeout(90);
    }

    const updatedAttr = (
      (await trigger.getAttribute("data-selected-reasoning-effort").catch(() => "")) ||
      ""
    )
      .trim()
      .toLowerCase();
    return updatedAttr === targetEffort;
  }

  private async closePickerMenuIfOpen(page: Page): Promise<void> {
    const menu = page.locator(CHATGPT_SELECTORS.openPickerMenu).first();
    if (await menu.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(100);
    }
  }

  private async ensureFreeThinkToggle(
    page: Page,
    targetEffort: ChatGptThinkingEffort,
  ): Promise<boolean> {
    const buttons = page.locator(CHATGPT_SELECTORS.thinkToggleButton);
    const count = await buttons.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const btn = buttons.nth(index);
      const visible = await btn.isVisible().catch(() => false);
      if (!visible) continue;

      const currentPressed = (
        (await btn.getAttribute("aria-pressed").catch(() => "")) || ""
      )
        .trim()
        .toLowerCase();
      const desiredPressed = targetEffort === "none" ? "false" : "true";
      if (currentPressed === desiredPressed) {
        return true;
      }

      const disabled = await btn.isDisabled().catch(() => false);
      const ariaDisabled =
        (await btn.getAttribute("aria-disabled").catch(() => "")) === "true";
      if (disabled || ariaDisabled) {
        return false;
      }

      await btn.click({ timeout: 2_000 }).catch(() => {});
      await page.waitForTimeout(150);
      const updatedPressed = (
        (await btn.getAttribute("aria-pressed").catch(() => "")) || ""
      )
        .trim()
        .toLowerCase();
      return updatedPressed === desiredPressed;
    }
    return false;
  }
}
