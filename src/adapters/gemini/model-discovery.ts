import type { Page } from "playwright-core";
import type { DiscoveredModelEntry } from "../../models/types";
import { GEMINI_HOME_URL, isGeminiAuthUrl } from "./conversation-url";
import { GEMINI_SELECTORS } from "./selectors";

export interface RawGeminiDomModeItem {
  readonly label: string;
  readonly sublabel?: string;
  readonly modeId?: string;
  readonly isChecked?: boolean;
  readonly isDisabled?: boolean;
}

function cleanGeminiUiLabel(raw: RawGeminiDomModeItem): string {
  const sub = raw.sublabel?.replace(/\b(?:new|beta|default)\b/gi, "").trim();
  const lbl = raw.label.replace(/\b(?:new|beta|default)\b/gi, "").trim();
  if (sub && !/adapts to your needs/i.test(sub)) {
    return sub;
  }
  return lbl;
}

export function normalizeGeminiSlugFromLabel(
  uiLabel: string,
  isPrimaryDefault = false,
): string {
  if (isPrimaryDefault) return "gemini";
  const slugPart = uiLabel
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `gemini/${slugPart || "custom"}`;
}

/**
 * Chuẩn hóa danh sách mục đọc được từ Mode Picker của `gemini.google.com`
 * thành `DiscoveredModelEntry[]`:
 * - Nếu UI dùng 3 mode cổ điển (Fast / Thinking / Pro), gom thành 1 slug chính `gemini`.
 * - Nếu UI dùng danh sách model (Auto, Everyday help / 4 Hydrogen, Deeper analysis / 4 Neon...),
 *   ánh xạ model mặc định sang `gemini` và các model bổ sung sang `gemini/<slug>`.
 */
export function buildGeminiDiscoveredModels(
  rawItems: readonly RawGeminiDomModeItem[],
  hasThinkingSubmenu = true,
): DiscoveredModelEntry[] {
  const cleaned = rawItems
    .filter((item) => !item.isDisabled && item.label.trim().length > 0)
    .map((item) => ({
      ...item,
      uiLabel: cleanGeminiUiLabel(item),
    }))
    .filter((item) => item.uiLabel.length > 0);

  if (cleaned.length === 0) {
    return [
      {
        slug: "gemini",
        providerId: "gemini",
        displayName: "Gemini Web",
        description: "Gemini Web qua gemini.google.com",
        isAccountDefault: true,
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        defaultReasoningLevel: "medium",
      },
    ];
  }

  // Giao diện cổ điển không có submenu Thinking level mà dùng Fast / Thinking / Pro trực tiếp
  const legacyModePattern = /^(?:fast|thinking|pro|flash)\b/i;
  if (
    !hasThinkingSubmenu &&
    cleaned.every((item) => legacyModePattern.test(item.uiLabel))
  ) {
    const modeNames = cleaned.map((item) => item.uiLabel).join(" / ");
    return [
      {
        slug: "gemini",
        providerId: "gemini",
        displayName: "Gemini Web",
        description: `Gemini Web (${modeNames})`,
        isAccountDefault: true,
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        defaultReasoningLevel: "medium",
      },
    ];
  }

  // Giao diện có danh sách model cụ thể (vd Auto, 4 Hydrogen, 4 Neon)
  const defaultItem =
    cleaned.find((item) => item.isChecked && !/^auto$/i.test(item.uiLabel)) ??
    cleaned.find((item) => !/^auto$/i.test(item.uiLabel)) ??
    cleaned[0]!;

  const results: DiscoveredModelEntry[] = [];
  const seen = new Set<string>();

  for (const item of cleaned) {
    const isPrimary = item === defaultItem;
    const slug = normalizeGeminiSlugFromLabel(item.uiLabel, isPrimary);
    if (seen.has(slug)) continue;
    seen.add(slug);

    const displayName = isPrimary
      ? `Gemini Web (${item.uiLabel})`
      : `Gemini - ${item.uiLabel}`;
    const descParts = [item.label, item.sublabel]
      .map((part) => part?.trim())
      .filter(Boolean);

    results.push({
      slug,
      providerId: "gemini",
      displayName,
      description: descParts.join(" — ") || `${item.uiLabel} qua Gemini Web`,
      uiLabel: item.uiLabel,
      ...(item.modeId ? { remoteModelId: item.modeId } : {}),
      isAccountDefault: isPrimary,
      contextWindow: 1_000_000,
      inputModalities: ["text", "image"],
      defaultReasoningLevel: "medium",
    });
  }

  return results;
}

/**
 * Auto-Discovery quét các model/mode hiện có trong Mode Picker của Gemini Web (`gemini.google.com`).
 */
export class GeminiModelDiscovery {
  public async discoverModels(page: Page): Promise<DiscoveredModelEntry[]> {
    const initialUrl = typeof page.url === "function" ? page.url() : "";
    if (!initialUrl || !initialUrl.startsWith("https://gemini.google.com")) {
      await page.goto(GEMINI_HOME_URL, {
        waitUntil: "domcontentloaded",
        timeout: 25_000,
      });
    }

    await page
      .locator(`${GEMINI_SELECTORS.composer}, ${GEMINI_SELECTORS.modePickerTrigger}`)
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
      .catch(() => {});

    const currentUrl = typeof page.url === "function" ? page.url() : "";
    if (isGeminiAuthUrl(currentUrl)) {
      throw new Error(
        "Gemini session is signed out. Sign in with Chrome before refreshing models.",
      );
    }

    const trigger = page.locator(GEMINI_SELECTORS.modePickerTrigger).first();
    await trigger.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    if (!(await trigger.isVisible().catch(() => false))) {
      const composerVisible = await page
        .locator(GEMINI_SELECTORS.composer)
        .first()
        .isVisible()
        .catch(() => false);
      if (!composerVisible) {
        throw new Error(
          "Gemini composer did not become ready during model refresh.",
        );
      }
      return buildGeminiDiscoveredModels([]);
    }

    let menuOpened = false;
    try {
      const menu = page.locator(GEMINI_SELECTORS.modeMenu).first();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await trigger.click({ timeout: 3_000 });
        menuOpened = true;
        const visible = await menu
          .waitFor({ state: "visible", timeout: 2_500 })
          .then(() => true)
          .catch(() => false);
        if (visible) break;
        await page.waitForTimeout(350);
      }
      await menu.waitFor({ state: "visible", timeout: 2_000 });

      const probe = await menu
        .evaluate((menuEl, selectors) => {
          const hasThinkingSubmenu = Boolean(
            menuEl.querySelector(selectors.thinkingLevelTrigger),
          );
          const items = Array.from(
            menuEl.querySelectorAll<HTMLElement>(selectors.modeRadioItem),
          )
            .filter(
              (el) =>
                !el.closest(".submenu-container") &&
                el.closest('gem-menu[role="menu"]') === menuEl,
            )
            .map((el) => {
            const labelEl = el.querySelector<HTMLElement>(".label");
            const sublabelEl = el.querySelector<HTMLElement>(".sublabel");
            const fallbackLines = (el.innerText || el.textContent || "")
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            const label =
              (labelEl?.innerText || labelEl?.textContent || "").trim() ||
              fallbackLines[0] ||
              "";
            const sublabel =
              (sublabelEl?.innerText || sublabelEl?.textContent || "").trim() ||
              fallbackLines.slice(1).join(" ") ||
              undefined;
            return {
              label,
              ...(sublabel ? { sublabel } : {}),
              ...(el.getAttribute("data-mode-id")
                ? { modeId: el.getAttribute("data-mode-id")! }
                : {}),
              isChecked: el.getAttribute("aria-checked") === "true",
              isDisabled: el.getAttribute("aria-disabled") === "true",
            };
          });
          return { hasThinkingSubmenu, items };
        }, {
          thinkingLevelTrigger: GEMINI_SELECTORS.thinkingLevelTrigger,
          modeRadioItem: GEMINI_SELECTORS.modeRadioItem,
        })
        .catch(() => ({ hasThinkingSubmenu: true, items: [] }));

      return buildGeminiDiscoveredModels(probe.items, probe.hasThinkingSubmenu);
    } finally {
      if (menuOpened) {
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(100);
      }
    }
  }
}
