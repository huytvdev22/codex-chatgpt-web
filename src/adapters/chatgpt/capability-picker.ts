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

const DEFAULT_SELECTOR_READY_TIMEOUT_MS = 5_000;
const SELECTOR_READY_POLL_MS = 150;
const MAX_INSTANT_MOCK_POLLS = 5;

export interface ChatGptCapabilityResult {
  readonly modelSelected: boolean;
  readonly effortAdjusted: boolean;
  readonly reason?: string;
}

export interface ChatGptCapabilityEnsureOptions {
  readonly readyTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface CachedCapabilityState {
  readonly key: string;
  readonly hasEffortAttr: boolean;
}

/**
 * Điều khiển popover Model Switcher & Power/Thinking Slider của ChatGPT Web (`chatgpt.com`).
 */
export class ChatGptCapabilityPicker {
  private readonly appliedByPage = new WeakMap<Page, CachedCapabilityState>();

  public clearCache(page: Page): void {
    this.appliedByPage.delete(page);
  }

  public async ensureCapability(
    page: Page,
    target: ChatGptCapabilityTarget,
    options?: ChatGptCapabilityEnsureOptions,
  ): Promise<boolean> {
    const result = await this.ensureCapabilityDetailed(page, target, options);
    return result.modelSelected && result.effortAdjusted;
  }

  public async ensureCapabilityDetailed(
    page: Page,
    target: ChatGptCapabilityTarget,
    options?: ChatGptCapabilityEnsureOptions,
  ): Promise<ChatGptCapabilityResult> {
    const readiness = await this.waitForSelectorReady(page, options);
    if (readiness.kind !== "picker") {
      if (!target.isAccountDefault) {
        return {
          modelSelected: false,
          effortAdjusted: false,
          reason: `Tài khoản ChatGPT hiện tại không hiển thị Model Switcher để chuyển sang '${target.modelLabel}'.`,
        };
      }
      const effortAdjusted = await this.ensureFreeThinkToggle(page, target.thinkingEffort);
      return { modelSelected: true, effortAdjusted };
    }

    const trigger = readiness.trigger;
    if (readiness.disabled) {
      return {
        modelSelected: false,
        effortAdjusted: false,
        reason: `Model Switcher của ChatGPT chưa sẵn sàng hoặc đang bị vô hiệu hóa để chuyển sang '${target.modelLabel}'.`,
      };
    }

    const cacheKey = `${target.modelSlug}:${target.thinkingEffort}`;
    const currentEffortAttr = await this.readReasoningEffortAttr(trigger);
    const cached = this.appliedByPage.get(page);
    if (
      cached &&
      cached.key === cacheKey &&
      (cached.hasEffortAttr
        ? currentEffortAttr === target.thinkingEffort
        : !currentEffortAttr)
    ) {
      return { modelSelected: true, effortAdjusted: true };
    }

    try {
      await trigger.click({ timeout: 2_000 });
      const menu = page.locator(CHATGPT_SELECTORS.openPickerMenu).last();
      await menu.waitFor({ state: "visible", timeout: 2_000 });

      const modelOutcome = await this.ensureModelSelected(page, target);
      const effortAdjusted = modelOutcome.selected
        ? await this.ensureThinkingEffort(page, target.thinkingEffort, {
            switchedModel: Boolean(modelOutcome.switchedModel),
            inRadioListView: Boolean(modelOutcome.inRadioListView),
          }).catch(() => false)
        : false;

      await this.closePickerMenuIfOpen(page);
      if (modelOutcome.selected && effortAdjusted) {
        const latestEffortAttr = await this.readReasoningEffortAttr(trigger);
        this.appliedByPage.set(page, {
          key: cacheKey,
          hasEffortAttr: Boolean(latestEffortAttr),
        });
      }
      return {
        modelSelected: modelOutcome.selected,
        effortAdjusted,
        ...(modelOutcome.reason ? { reason: modelOutcome.reason } : {}),
      };
    } catch (error) {
      await this.closePickerMenuIfOpen(page);
      if (!(await this.findVisibleTrigger(page))) {
        if (!target.isAccountDefault) {
          return {
            modelSelected: false,
            effortAdjusted: false,
            reason: `Không thể mở Model Switcher để chuyển sang '${target.modelLabel}'.`,
          };
        }
        const effortAdjusted = await this.ensureFreeThinkToggle(page, target.thinkingEffort);
        return { modelSelected: true, effortAdjusted };
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[chatgpt-capability] Không thể chuyển model='${target.modelLabel}' effort='${target.thinkingEffort}':`,
        error,
      );
      return {
        modelSelected: false,
        effortAdjusted: false,
        reason: message,
      };
    }
  }

  private async waitBriefly(page: Page, ms: number): Promise<number> {
    if (typeof page.waitForTimeout !== "function") {
      return -1;
    }
    const before = Date.now();
    await page.waitForTimeout(ms);
    return Date.now() - before;
  }

  private async readReasoningEffortAttr(
    trigger: ReturnType<Page["locator"]>,
  ): Promise<string> {
    if (typeof trigger.getAttribute !== "function") return "";
    return (
      (await trigger.getAttribute("data-selected-reasoning-effort").catch(() => "")) ||
      ""
    )
      .trim()
      .toLowerCase();
  }

  private async isLocatorDisabled(
    locator: ReturnType<Page["locator"]>,
  ): Promise<boolean> {
    const ariaDisabled =
      typeof locator.getAttribute === "function"
        ? await locator.getAttribute("aria-disabled").catch(() => null)
        : null;
    if (ariaDisabled === "true") return true;
    if (typeof locator.isDisabled === "function") {
      return await locator.isDisabled().catch(() => false);
    }
    return false;
  }

  private async findVisibleTrigger(
    page: Page,
  ): Promise<ReturnType<Page["locator"]> | undefined> {
    const loc = page.locator(CHATGPT_SELECTORS.modelPickerTrigger);
    const first = loc.first?.();
    if (first && (await first.isVisible().catch(() => false))) {
      return first;
    }
    if (typeof loc.count === "function") {
      const count = await loc.count().catch(() => 0);
      for (let index = 1; index < count; index += 1) {
        const candidate = loc.nth(index);
        if (await candidate.isVisible().catch(() => false)) {
          return candidate;
        }
      }
    }
    return undefined;
  }

  private async hasVisibleThinkToggle(page: Page): Promise<boolean> {
    const buttons = page.locator(CHATGPT_SELECTORS.thinkToggleButton);
    if (typeof buttons.count !== "function") return false;
    const count = await buttons.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (await buttons.nth(index).isVisible().catch(() => false)) {
        return true;
      }
    }
    return false;
  }

  private async waitForSelectorReady(
    page: Page,
    options?: ChatGptCapabilityEnsureOptions,
  ): Promise<
    | { kind: "picker"; trigger: ReturnType<Page["locator"]>; disabled: boolean }
    | { kind: "think-only" }
    | { kind: "none" }
  > {
    const timeoutMs = options?.readyTimeoutMs ?? DEFAULT_SELECTOR_READY_TIMEOUT_MS;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let instantPolls = 0;
    let lastDisabledTrigger: ReturnType<Page["locator"]> | undefined;

    while (true) {
      if (options?.signal?.aborted) {
        throw new DOMException("ChatGPT capability selection aborted", "AbortError");
      }

      const trigger = await this.findVisibleTrigger(page);
      if (trigger) {
        const disabled = await this.isLocatorDisabled(trigger);
        if (!disabled) {
          return { kind: "picker", trigger, disabled: false };
        }
        lastDisabledTrigger = trigger;
      } else if (await this.hasVisibleThinkToggle(page)) {
        return { kind: "think-only" };
      }

      if (timeoutMs <= 0 || Date.now() >= deadline) {
        break;
      }

      const elapsed = await this.waitBriefly(page, SELECTOR_READY_POLL_MS);
      if (elapsed < 0) {
        break;
      }
      if (elapsed < 15) {
        instantPolls += 1;
        if (instantPolls >= MAX_INSTANT_MOCK_POLLS) {
          break;
        }
      } else {
        instantPolls = 0;
      }
    }

    if (lastDisabledTrigger && (await lastDisabledTrigger.isVisible().catch(() => false))) {
      return {
        kind: "picker",
        trigger: lastDisabledTrigger,
        disabled: await this.isLocatorDisabled(lastDisabledTrigger),
      };
    }

    return { kind: "none" };
  }

  private async ensureModelSelected(
    page: Page,
    target: ChatGptCapabilityTarget,
  ): Promise<{
    selected: boolean;
    switchedModel?: boolean;
    inRadioListView?: boolean;
    reason?: string;
  }> {
    const menu = page.locator(CHATGPT_SELECTORS.openPickerMenu).last();

    // Kiểm tra nhanh khi đang ở view simple:
    // Chỉ skip bước mở danh sách radio nếu text model hiện trên toggle thực sự khớp model đích
    // (không dựa vào việc thiếu nút "Reset to default", tránh nhận nhầm khi tài khoản/thread đang ở 5.6).
    const quickMatch = await menu
      .evaluate(
        (menuEl, { toggleSel, expectedShort, expectedLabel }) => {
          const toggle = menuEl.querySelector<HTMLElement>(toggleSel);
          if (!toggle) return false;
          const firstLine = (toggle.innerText || toggle.textContent || "")
            .trim()
            .split(/\r?\n/)[0]
            ?.trim()
            .toLowerCase();
          if (!firstLine) return false;
          const shortLower = expectedShort.trim().toLowerCase();
          const labelLower = expectedLabel.trim().toLowerCase();
          const strippedGpt = labelLower.replace(/^gpt[- ]?/i, "");
          if (shortLower && firstLine === shortLower) return true;
          if (labelLower && (firstLine === labelLower || (strippedGpt && firstLine === strippedGpt))) {
            return true;
          }
          return false;
        },
        {
          toggleSel: CHATGPT_SELECTORS.modelViewToggle,
          expectedShort: target.shortUiVersion ?? "",
          expectedLabel: target.modelLabel,
        },
      )
      .catch(() => false);

    if (quickMatch) {
      return { selected: true, switchedModel: false, inRadioListView: false };
    }

    const viewToggle = menu.locator(CHATGPT_SELECTORS.modelViewToggle).first();
    if (!(await viewToggle.isVisible().catch(() => false))) {
      return {
        selected: false,
        reason: `Không tìm thấy danh sách chuyển model trong menu ChatGPT để chọn '${target.modelLabel}'.`,
      };
    }

    await viewToggle.click({ timeout: 2_500 });
    await this.waitBriefly(page, 180);

    const radios = menu.locator(CHATGPT_SELECTORS.modelRadioItem);
    await radios.first().waitFor({ state: "visible", timeout: 2_500 }).catch(() => {});

    const normalizedTarget = target.modelLabel.trim().toLowerCase();
    const findMatchedRadio = async (): Promise<{
      matchedIndex: number;
      alreadyChecked: boolean;
      targetRadio: ReturnType<typeof radios.nth> | null;
    }> => {
      const count = await radios.count();
      for (let index = 0; index < count; index += 1) {
        const radio = radios.nth(index);
        const label = ((await radio.innerText().catch(() => "")) || "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (!label) continue;
        if (label === normalizedTarget || label.startsWith(`${normalizedTarget} `)) {
          return {
            matchedIndex: index,
            alreadyChecked: (await radio.getAttribute("aria-checked").catch(() => "")) === "true",
            targetRadio: radio,
          };
        }
      }
      for (let index = 0; index < count; index += 1) {
        const radio = radios.nth(index);
        const label = ((await radio.innerText().catch(() => "")) || "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (label.includes(normalizedTarget)) {
          return {
            matchedIndex: index,
            alreadyChecked: (await radio.getAttribute("aria-checked").catch(() => "")) === "true",
            targetRadio: radio,
          };
        }
      }
      return { matchedIndex: -1, alreadyChecked: false, targetRadio: null };
    };

    let matched = await findMatchedRadio();
    if (matched.matchedIndex < 0) {
      const legacyTrigger = menu
        .locator('[role="menuitem"]:has-text("Legacy"), [role="menuitem"]:has-text("More models")')
        .first();
      if (await legacyTrigger.isVisible().catch(() => false)) {
        await legacyTrigger.hover().catch(() => {});
        await legacyTrigger.click({ timeout: 1_500 }).catch(() => {});
        await this.waitBriefly(page, 240);
        const activeMenu = page.locator(CHATGPT_SELECTORS.openPickerMenu).last();
        const subRadios = activeMenu.locator(CHATGPT_SELECTORS.modelRadioItem);
        const subCount = await subRadios.count().catch(() => 0);
        for (let index = 0; index < subCount; index += 1) {
          const radio = subRadios.nth(index);
          const label = ((await radio.innerText().catch(() => "")) || "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
          if (label === normalizedTarget || label.startsWith(`${normalizedTarget} `) || label.includes(normalizedTarget)) {
            matched = {
              matchedIndex: index,
              alreadyChecked: (await radio.getAttribute("aria-checked").catch(() => "")) === "true",
              targetRadio: radio,
            };
            break;
          }
        }
      }
    }

    if (matched.matchedIndex < 0 || !matched.targetRadio) {
      console.warn(
        `[chatgpt-capability] Không tìm thấy model '${target.modelLabel}' trong danh sách ChatGPT.`,
      );
      return {
        selected: false,
        reason: `Không tìm thấy model '${target.modelLabel}' trong danh sách ChatGPT.`,
      };
    }

    const { targetRadio, alreadyChecked } = matched;
    if (alreadyChecked) {
      return { selected: true, switchedModel: false, inRadioListView: true };
    }

    if (await this.isLocatorDisabled(targetRadio)) {
      return {
        selected: false,
        reason: `Model '${target.modelLabel}' đang bị khóa/vô hiệu hóa trên tài khoản ChatGPT hiện tại.`,
      };
    }

    await targetRadio.click({ timeout: 2_500 });
    await this.waitBriefly(page, 220);

    return { selected: true, switchedModel: true, inRadioListView: false };
  }

  private async ensureThinkingEffort(
    page: Page,
    targetEffort: ChatGptThinkingEffort,
    context: { switchedModel: boolean; inRadioListView: boolean },
  ): Promise<boolean> {
    const trigger = await this.findVisibleTrigger(page);
    const currentAttr = trigger ? await this.readReasoningEffortAttr(trigger) : "";
    if (!context.switchedModel && currentAttr === targetEffort) {
      return true;
    }

    const menu = page.locator(CHATGPT_SELECTORS.openPickerMenu).last();
    if (!(await menu.isVisible().catch(() => false))) {
      if (currentAttr === targetEffort) {
        return true;
      }
      if (!trigger) return false;
      await trigger.click({ timeout: 2_500 });
      await menu.waitFor({ state: "visible", timeout: 2_500 }).catch(() => {});
      if (!(await menu.isVisible().catch(() => false))) {
        return false;
      }
    }

    const sliderRow = menu.locator(CHATGPT_SELECTORS.reasoningSliderItem).first();
    if (!(await sliderRow.isVisible().catch(() => false)) && context.inRadioListView) {
      await this.closePickerMenuIfOpen(page);
      const reopenedTrigger = await this.findVisibleTrigger(page);
      if (reopenedTrigger) {
        await reopenedTrigger.click({ timeout: 2_500 });
        await menu.waitFor({ state: "visible", timeout: 2_500 }).catch(() => {});
      }
    }

    if (!(await sliderRow.isVisible().catch(() => false))) {
      return true;
    }

    const sliderThumb = menu.locator(CHATGPT_SELECTORS.reasoningSliderThumb).first();
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
      await this.waitBriefly(page, 90);
    }

    const updatedAttr = trigger ? await this.readReasoningEffortAttr(trigger) : "";
    return updatedAttr === targetEffort;
  }

  private async closePickerMenuIfOpen(page: Page): Promise<void> {
    const menu = page.locator(CHATGPT_SELECTORS.openPickerMenu).first();
    if (await menu.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape").catch(() => {});
      await this.waitBriefly(page, 100);
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

      if (await this.isLocatorDisabled(btn)) {
        return false;
      }

      await btn.click({ timeout: 2_000 }).catch(() => {});
      await this.waitBriefly(page, 150);
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
