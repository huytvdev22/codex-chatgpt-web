import type { Page } from "playwright-core";
import { ModelConfigStore } from "../../models/model-config-store";
import {
  AiStudioModelProvider,
  type AiStudioModelRouteDefinition,
  type AiStudioThinkingLevel,
} from "./model-provider";

export interface AiStudioCapabilityTarget {
  readonly modelSlug: string;
  readonly remoteModelId: string;
  readonly displayName: string;
  readonly thinkingLevel: AiStudioThinkingLevel;
}

export interface AiStudioCapabilityResult {
  readonly modelSelected: boolean;
  readonly thinkingSelected: boolean;
  readonly reason?: string;
}

const MODEL_SELECTOR_TRIGGERS = [
  "ms-model-selector button.model-selector-card",
  "button.model-selector-card",
  "ms-model-selector button",
] as const;

const MODEL_CAROUSEL_OPTIONS = [
  "ms-model-carousel .model-options-container button.content-button",
  "ms-model-carousel button.content-button",
  ".cdk-overlay-pane .model-list-container button.content-button",
  "ms-model-selector-modal [data-model-id]",
  '[role="listbox"] [role="option"]',
].join(", ");

const THINKING_LEVEL_SELECT =
  'mat-select[role="combobox"][aria-label="Thinking Level"], #mat-select-0[aria-label="Thinking Level"]';
const SELECT_OPTION_SELECTOR =
  '.mat-mdc-select-panel [role="option"], [role="listbox"] [role="option"]';

function normalizeToken(value?: string): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeRemoteId(value?: string): string {
  return (value ?? "")
    .trim()
    .replace(/^models\//i, "")
    .replace(/^ai-studio\//i, "")
    .toLowerCase();
}

/**
 * Điều khiển bộ chọn Model (`ms-model-selector`) và Thinking Level trên Google AI Studio
 * để cho phép đổi model ngay trên URL `/prompts/{id}` đang mở (fail-closed khi đổi model thất bại).
 */
export class AiStudioCapabilityPicker {
  private readonly appliedByPage = new WeakMap<Page, string>();

  public clearCache(page: Page): void {
    this.appliedByPage.delete(page);
  }

  public resolveTarget(
    modelId = "ai-studio/gemini-4-hydrogen",
    requestedEffort?: string,
  ): AiStudioCapabilityTarget {
    const provider = AiStudioModelProvider.getInstance();
    const resolved =
      (ModelConfigStore.getInstance().findResolvedRoute(
        provider,
        modelId,
      ) as AiStudioModelRouteDefinition | undefined) ??
      provider.findRoute(modelId);
    const cleanModel = normalizeRemoteId(
      resolved?.remoteModelId || modelId || "gemini-4-hydrogen",
    );
    const displayName = resolved?.displayName || cleanModel;
    const thinkingLevel = provider.resolveThinkingLevel(modelId, requestedEffort);
    return {
      modelSlug: resolved?.slug || (modelId.startsWith("ai-studio/") ? modelId : `ai-studio/${cleanModel}`),
      remoteModelId: cleanModel,
      displayName,
      thinkingLevel,
    };
  }

  public async ensureCapabilityDetailed(
    page: Page,
    target: AiStudioCapabilityTarget,
  ): Promise<AiStudioCapabilityResult> {
    const cacheKey = `${target.remoteModelId}:${target.thinkingLevel}`;
    const alreadyActiveModel = await this.isModelAlreadyActive(page, target);
    if (this.appliedByPage.get(page) === cacheKey && alreadyActiveModel) {
      return { modelSelected: true, thinkingSelected: true };
    }

    const modelOutcome = alreadyActiveModel
      ? { selected: true }
      : await this.ensureModelSelected(page, target);

    if (!modelOutcome.selected) {
      return {
        modelSelected: false,
        thinkingSelected: false,
        reason: modelOutcome.reason,
      };
    }

    const thinkingSelected = await this.ensureThinkingLevel(
      page,
      target.thinkingLevel,
    ).catch(() => false);

    if (thinkingSelected) {
      this.appliedByPage.set(page, cacheKey);
    }
    return {
      modelSelected: true,
      thinkingSelected,
    };
  }

  private async isModelAlreadyActive(
    page: Page,
    target: AiStudioCapabilityTarget,
  ): Promise<boolean> {
    const currentUrl = typeof page.url === "function" ? page.url() : "";
    if (currentUrl) {
      try {
        const parsed = new URL(currentUrl);
        const urlModel = normalizeRemoteId(parsed.searchParams.get("model") || undefined);
        if (urlModel && urlModel === target.remoteModelId) {
          return true;
        }
      } catch {
        // Bỏ qua URL không hợp lệ
      }
    }

    if (typeof page.evaluate !== "function") return false;
    return await page
      .evaluate(
        ({ targetId, targetName }) => {
          const cards = Array.from(
            document.querySelectorAll<HTMLElement>(
              "ms-model-selector button.model-selector-card, button.model-selector-card",
            ),
          );
          const card = cards.find((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          if (!card) return false;
          const attrId = (
            card.getAttribute("data-model-id") ||
            card.getAttribute("data-value") ||
            ""
          )
            .replace(/^models\//i, "")
            .trim()
            .toLowerCase();
          if (attrId && attrId === targetId) return true;
          const text = (card.innerText || card.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
          if (!text) return false;
          if (targetId && text.includes(targetId)) return true;
          return Boolean(targetName) && text.includes(targetName);
        },
        {
          targetId: target.remoteModelId,
          targetName: normalizeToken(target.displayName),
        },
      )
      .catch(() => false);
  }

  private async findVisibleTrigger(page: Page) {
    if (typeof page.locator !== "function") return undefined;
    for (const selector of MODEL_SELECTOR_TRIGGERS) {
      const loc = page.locator(selector).first();
      if (await loc.isVisible().catch(() => false)) {
        return loc;
      }
    }
    return undefined;
  }

  private async ensureModelSelected(
    page: Page,
    target: AiStudioCapabilityTarget,
  ): Promise<{ selected: boolean; reason?: string }> {
    const trigger = await this.findVisibleTrigger(page);
    if (!trigger) {
      return {
        selected: false,
        reason: `Không tìm thấy bộ chọn model (ms-model-selector) trên Google AI Studio để chuyển sang '${target.displayName}'.`,
      };
    }

    let openedPanel = false;
    try {
      await trigger.click({ timeout: 3_000 });
      openedPanel = true;
      await page
        .locator("ms-model-carousel, .cdk-overlay-pane .model-categories-container, ms-model-selector-modal")
        .first()
        .waitFor({ state: "visible", timeout: 5_000 })
        .catch(() => {});

      const allChip = page
        .locator(".model-categories-container button.ms-button-filter-chip")
        .filter({ hasText: /^All$/i })
        .first();
      const geminiChip = page
        .locator(".model-categories-container button.ms-button-filter-chip")
        .filter({ hasText: /^Gemini$/i })
        .first();
      if (await allChip.isVisible().catch(() => false)) {
        await allChip.click({ timeout: 2_000 }).catch(() => {});
        await page.waitForTimeout(200);
      } else if (await geminiChip.isVisible().catch(() => false)) {
        await geminiChip.click({ timeout: 2_000 }).catch(() => {});
        await page.waitForTimeout(200);
      }

      const options = page.locator(MODEL_CAROUSEL_OPTIONS);
      await options.first().waitFor({ state: "visible", timeout: 4_000 }).catch(() => {});
      const count = await options.count().catch(() => 0);
      if (count === 0) {
        return {
          selected: false,
          reason: "Không đọc được danh sách model trong panel chọn model của Google AI Studio.",
        };
      }

      const targetId = target.remoteModelId;
      const targetName = normalizeToken(target.displayName);
      let matchedIndex = -1;
      let fallbackNameIndex = -1;

      for (let index = 0; index < count; index += 1) {
        const opt = options.nth(index);
        if (!(await opt.isVisible().catch(() => false))) continue;
        const attrId = normalizeRemoteId(
          (await opt.getAttribute("data-model-id").catch(() => null)) ||
            (await opt.getAttribute("data-value").catch(() => null)) ||
            undefined,
        );
        const text = normalizeToken(await opt.innerText().catch(() => ""));
        if (attrId && attrId === targetId) {
          matchedIndex = index;
          break;
        }
        if (targetId && text.includes(targetId)) {
          matchedIndex = index;
          break;
        }
        if (
          fallbackNameIndex < 0 &&
          targetName &&
          (text === targetName || text.startsWith(`${targetName} `) || text.includes(targetName))
        ) {
          fallbackNameIndex = index;
        }
      }

      const chosenIndex = matchedIndex >= 0 ? matchedIndex : fallbackNameIndex;
      if (chosenIndex < 0) {
        return {
          selected: false,
          reason: `Không tìm thấy model '${target.displayName}' (${target.remoteModelId}) trong danh sách AI Studio.`,
        };
      }

      const chosen = options.nth(chosenIndex);
      const ariaDisabled = await chosen.getAttribute("aria-disabled").catch(() => null);
      const disabled = ariaDisabled === "true" || (await chosen.isDisabled().catch(() => false));
      if (disabled) {
        return {
          selected: false,
          reason: `Model '${target.displayName}' (${target.remoteModelId}) đang bị khóa/vô hiệu hóa trên AI Studio.`,
        };
      }

      await chosen.click({ timeout: 3_000 });
      openedPanel = false;
      await page.waitForTimeout(300);

      const confirmed = await this.isModelAlreadyActive(page, target);
      if (!confirmed) {
        await page.waitForTimeout(350);
      }
      return { selected: true };
    } catch (error) {
      return {
        selected: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (openedPanel) {
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(100);
      }
    }
  }

  public async ensureThinkingLevel(
    page: Page,
    targetLevel: AiStudioThinkingLevel,
  ): Promise<boolean> {
    if (typeof page.locator !== "function") return true;
    const select = page.locator(THINKING_LEVEL_SELECT).first();
    if (!(await select.isVisible().catch(() => false))) return true;

    const currentText = ((await select.innerText().catch(() => "")) || "").trim().toLowerCase();
    const firstLine = currentText.split(/\r?\n/)[0]?.trim() || "";
    if (currentText === targetLevel.toLowerCase() || firstLine === targetLevel.toLowerCase()) {
      return true;
    }

    await select.click({ timeout: 3_000 });
    await page.waitForTimeout(240);
    const options = page.locator(SELECT_OPTION_SELECTOR);
    await options.first().waitFor({ state: "visible", timeout: 3_000 });
    const count = await options.count();
    for (let i = 0; i < count; i += 1) {
      const opt = options.nth(i);
      const label = ((await opt.innerText().catch(() => "")) || "").trim();
      if (label.toLowerCase() === targetLevel.toLowerCase()) {
        await opt.click({ timeout: 2_000 });
        await page.waitForTimeout(260);
        return true;
      }
    }
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
}
