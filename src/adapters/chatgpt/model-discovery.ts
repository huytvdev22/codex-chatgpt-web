import type { Page } from "playwright-core";
import type { DiscoveredModelEntry } from "../../models/types";
import { CHATGPT_HOME_URL, isChatGptAuthUrl } from "./conversation-url";
import { CHATGPT_SELECTORS } from "./selectors";

export interface RawChatGptDomModelItem {
  readonly uiLabel: string;
  readonly description?: string;
  readonly isChecked?: boolean;
  readonly isAccountDefault?: boolean;
  readonly shortUiVersion?: string;
  readonly remoteModelId?: string;
}

const KNOWN_CHATGPT_UI_SLUGS: Record<string, string> = {
  "gpt-6.2": "chatgpt/gpt-6.2",
  "gpt-6": "chatgpt/gpt-6",
  "gpt-5.6 sol": "chatgpt/gpt-5.6-sol",
};

/** Chuẩn hóa tên model trên dropdown ChatGPT (`GPT-6.2`, `GPT-5.6 Sol`, `o3`...) thành slug `chatgpt/...`. */
export function normalizeChatGptSlugFromLabel(
  uiLabel: string,
  remoteModelId?: string,
): string {
  const cleanedRemote = (remoteModelId ?? "").trim().replace(/^chatgpt\//i, "");
  if (cleanedRemote && /^[a-z0-9][a-z0-9._-]{1,}$/i.test(cleanedRemote)) {
    return `chatgpt/${cleanedRemote.toLowerCase()}`;
  }
  const normalizedLabel = uiLabel.replace(/\s+/g, " ").trim().toLowerCase();
  if (KNOWN_CHATGPT_UI_SLUGS[normalizedLabel]) {
    return KNOWN_CHATGPT_UI_SLUGS[normalizedLabel];
  }
  const slugPart = normalizedLabel
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `chatgpt/${slugPart || "default"}`;
}

/** Rút phiên bản ngắn từ `uiLabel` (vd `"GPT-6"` -> `"6"`, `"GPT-5.6 Sol"` -> `"5.6"`). */
export function inferChatGptShortUiVersion(
  uiLabel: string,
  explicit?: string,
): string | undefined {
  if (explicit?.trim()) return explicit.trim();
  const match = /\bgpt[- ]?(\d+(?:\.\d+)?)\b/i.exec(uiLabel);
  if (!match) return undefined;
  return match[1];
}

/** Chuẩn hóa danh sách item đọc được từ popover ChatGPT Model Picker thành `DiscoveredModelEntry[]`. */
export function buildChatGptDiscoveredModels(
  rawItems: readonly RawChatGptDomModelItem[],
): DiscoveredModelEntry[] {
  const results: DiscoveredModelEntry[] = [];
  const seen = new Set<string>();

  for (const item of rawItems) {
    const uiLabel = item.uiLabel.replace(/\s+/g, " ").trim();
    if (!uiLabel) continue;
    const slug = normalizeChatGptSlugFromLabel(uiLabel, item.remoteModelId);
    if (seen.has(slug)) continue;
    seen.add(slug);

    const shortUiVersion = item.isAccountDefault
      ? undefined
      : inferChatGptShortUiVersion(uiLabel, item.shortUiVersion);

    results.push({
      slug,
      providerId: "chatgpt",
      displayName: uiLabel.toLowerCase().startsWith("chatgpt") ? uiLabel : `ChatGPT - ${uiLabel}`,
      description: item.description?.trim() || `${uiLabel} qua ChatGPT Web`,
      uiLabel,
      ...(shortUiVersion ? { shortUiVersion } : {}),
      ...(item.isAccountDefault !== undefined ? { isAccountDefault: item.isAccountDefault } : {}),
      ...(item.remoteModelId?.trim() ? { remoteModelId: item.remoteModelId.trim() } : {}),
      contextWindow: 1_000_000,
      inputModalities: ["text", "image"],
      defaultReasoningLevel: "medium",
    });
  }

  return results;
}

/**
 * Logic Auto-Discovery quét các model hiện có trong tài khoản ChatGPT (Free / Plus / Pro).
 */
export class ChatGptModelDiscovery {
  public async discoverModels(page: Page): Promise<DiscoveredModelEntry[]> {
    const initialUrl = typeof page.url === "function" ? page.url() : "";
    if (!initialUrl || !initialUrl.startsWith("https://chatgpt.com")) {
      await page.goto(CHATGPT_HOME_URL, {
        waitUntil: "domcontentloaded",
        timeout: 25_000,
      });
    }

    await page
      .locator(`${CHATGPT_SELECTORS.composer}, ${CHATGPT_SELECTORS.modelPickerTrigger}`)
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
      .catch(() => {});

    const currentUrl = typeof page.url === "function" ? page.url() : "";
    if (isChatGptAuthUrl(currentUrl)) {
      throw new Error(
        "ChatGPT session is signed out. Sign in with Chrome before refreshing models.",
      );
    }

    const isCloudflareChallenge = await page
      .evaluate(() => {
        const title = (document.title || "").toLowerCase();
        if (title.includes("just a moment")) return true;
        return Boolean(
          document.querySelector("#challenge-running, #challenge-stage, input[name='cf-turnstile-response']"),
        );
      })
      .catch(() => false);
    if (isCloudflareChallenge) {
      throw new Error(
        "ChatGPT is showing a Cloudflare verification page. Complete verification in the Browser tab first, then refresh again.",
      );
    }

    const trigger = page.locator(CHATGPT_SELECTORS.modelPickerTrigger).first();
    const triggerVisible = await trigger.isVisible().catch(() => false);

    // Tài khoản Free đôi khi không có nút dropdown Select ChatGPT model mà chỉ dùng model mặc định + Think toggle.
    if (!triggerVisible) {
      const composerVisible = await page
        .locator(CHATGPT_SELECTORS.composer)
        .first()
        .isVisible()
        .catch(() => false);
      if (!composerVisible) {
        throw new Error("ChatGPT composer did not become ready during model refresh.");
      }
      const triggerHint = await page
        .evaluate(() => {
          const badge = document.querySelector<HTMLElement>(
            'button[aria-haspopup="menu"][data-testid*="model" i], button[data-testid="model-switcher-dropdown-button"]',
          );
          return (badge?.innerText || "").split(/\r?\n/)[0]?.trim() || "";
        })
        .catch(() => "");
      return buildChatGptDiscoveredModels([
        {
          uiLabel: triggerHint || "GPT-6.2",
          isAccountDefault: true,
        },
      ]);
    }

    let menuOpened = false;
    try {
      await trigger.click({ timeout: 3_000 });
      menuOpened = true;
      const menu = page.locator(CHATGPT_SELECTORS.openPickerMenu).last();
      await menu.waitFor({ state: "visible", timeout: 3_000 });

      const simpleState = await menu
        .evaluate((menuEl, toggleSel) => {
          const toggle = menuEl.querySelector<HTMLElement>(toggleSel);
          const hasReset = Array.from(
            menuEl.querySelectorAll<HTMLElement>('[role="menuitem"]'),
          ).some(el => /reset to default/i.test(el.textContent || ""));
          const toggleFirstLine = (toggle?.innerText || toggle?.textContent || "")
            .trim()
            .split(/\r?\n/)[0]
            ?.trim();
          return {
            hasReset,
            toggleFirstLine: toggleFirstLine || "",
          };
        }, CHATGPT_SELECTORS.modelViewToggle)
        .catch(() => ({ hasReset: false, toggleFirstLine: "" }));

      const viewToggle = menu.locator(CHATGPT_SELECTORS.modelViewToggle).first();
      if (await viewToggle.isVisible().catch(() => false)) {
        await viewToggle.click({ timeout: 2_500 });
        await page.waitForTimeout(220);
      }

      const rawItems = await this.collectRadioItems(page);

      // Thử mở thêm submenu Legacy / More models nếu có
      const legacyTrigger = menu
        .locator('[role="menuitem"]:has-text("Legacy"), [role="menuitem"]:has-text("More models")')
        .first();
      if (await legacyTrigger.isVisible().catch(() => false)) {
        await legacyTrigger.hover().catch(() => {});
        await legacyTrigger.click({ timeout: 1_500 }).catch(() => {});
        await page.waitForTimeout(240);
        const subItems = await this.collectRadioItems(page);
        for (const sub of subItems) {
          if (!rawItems.some(existing => existing.uiLabel === sub.uiLabel)) {
            rawItems.push(sub);
          }
        }
      }

      if (rawItems.length === 0 && simpleState.toggleFirstLine) {
        rawItems.push({
          uiLabel: simpleState.toggleFirstLine,
          isAccountDefault: !simpleState.hasReset,
        });
      }

      const discovered = buildChatGptDiscoveredModels(rawItems);
      if (discovered.length === 0) {
        throw new Error("Could not find any model entries in the ChatGPT model picker.");
      }
      return discovered;
    } finally {
      if (menuOpened) {
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(100);
        await page.keyboard.press("Escape").catch(() => {});
      }
    }
  }

  private async collectRadioItems(page: Page): Promise<RawChatGptDomModelItem[]> {
    return await page
      .evaluate((radioSel) => {
        const items: Array<{
          uiLabel: string;
          description?: string;
          isChecked?: boolean;
          isAccountDefault?: boolean;
          remoteModelId?: string;
        }> = [];

        const menus = Array.from(
          document.querySelectorAll<HTMLElement>('[role="menu"][data-state="open"]'),
        );
        const targetRoot = menus[menus.length - 1] ?? document;
        const radios = Array.from(targetRoot.querySelectorAll<HTMLElement>(radioSel));

        radios.forEach((el, index) => {
          const lines = (el.innerText || el.textContent || "")
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);
          if (lines.length === 0) return;

          const primaryLabel = lines[0];
          if (!primaryLabel || /^(legacy models|more models|select model)$/i.test(primaryLabel)) {
            return;
          }

          const description = lines
            .slice(1)
            .filter(line => !/^(default|new|legacy|beta)$/i.test(line))
            .join(" — ");
          const dataModelId =
            el.getAttribute("data-model-id") ||
            el.getAttribute("data-value") ||
            undefined;
          const isChecked = el.getAttribute("aria-checked") === "true";

          items.push({
            uiLabel: primaryLabel,
            ...(description ? { description } : {}),
            isChecked,
            ...(index === 0 ? { isAccountDefault: true } : {}),
            ...(dataModelId ? { remoteModelId: dataModelId } : {}),
          });
        });

        return items;
      }, CHATGPT_SELECTORS.modelRadioItem)
      .catch(() => []);
  }
}
