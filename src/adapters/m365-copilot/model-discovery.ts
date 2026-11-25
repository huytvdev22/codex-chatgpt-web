import type { Page } from "playwright-core";
import type {
  DiscoveredModelEntry,
  M365DiscoveredCapabilityMeta,
} from "../../models/types";
import { isM365LoginUrl, M365_CHAT_URL } from "./conversation-url";

export interface RawM365MenuItem {
  readonly label: string;
  readonly itemTestId?: string;
  readonly iconTestId?: string;
  readonly isSubmenu?: boolean;
  readonly parentMenuTestId?: string;
  readonly parentLabel?: string;
}

const M365_CHAT_EDITOR_SELECTOR =
  'span#m365-chat-editor-target-element[role="textbox"], div#m365-chat-editor-target-element, #m365-chat-editor-target-element, [role="textbox"][aria-label*="Copilot" i], [role="textbox"][contenteditable="true"]';
const M365_SWITCHER_SELECTOR =
  '#gptModeSwitcher, button[id*="gptModeSwitcher"], button[aria-haspopup="menu"][aria-label*="Model Selector" i]';

function isQuickLabel(label: string): boolean {
  return /\bquick\b/i.test(label);
}

function isThinkLabel(label: string): boolean {
  return /\b(think|deeper|reasoning)\b/i.test(label);
}

function extractM365BaseModelName(label: string): string {
  return label
    .replace(/\b(quick\s*response|think\s*deeper|quick|deeper|reasoning)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeM365DiscoveredSlug(baseName: string, isDefaultGroup: boolean): string {
  if (isDefaultGroup) return "m365-copilot";
  if (/gpt[- ]?5\.6/i.test(baseName)) return "m365-copilot/gpt-5.6";
  const slugPart = baseName
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `m365-copilot/${slugPart || "custom"}`;
}

/**
 * Chuyển danh sách item thu từ `#gptModeSwitcher` & submenu của M365 Copilot
 * thành danh mục `DiscoveredModelEntry` thống nhất (gom cặp Quick/Think thành 1 model).
 */
export function buildM365DiscoveredModels(
  rawItems: readonly RawM365MenuItem[],
): DiscoveredModelEntry[] {
  const grouped = new Map<
    string,
    {
      slug: string;
      displayName: string;
      quick?: RawM365MenuItem;
      think?: RawM365MenuItem;
      single?: RawM365MenuItem;
    }
  >();

  for (const item of rawItems) {
    const label = item.label.replace(/\s+/g, " ").trim();
    if (!label) continue;
    // Bỏ qua item "Auto" mặc định để giữ catalog gọn (Quick/Think đã ánh xạ vào m365-copilot).
    if (/^auto$/i.test(label) || item.itemTestId === "gptSubMenuModelTrigger-Magic") {
      continue;
    }

    const baseName = extractM365BaseModelName(label);
    const isDefaultGroup =
      !item.isSubmenu &&
      (!baseName ||
        item.itemTestId === "gptSubMenuModelTrigger-Chat" ||
        item.itemTestId === "gptSubMenuModelTrigger-Reasoning");

    const slug = normalizeM365DiscoveredSlug(baseName || label, isDefaultGroup);
    const displayName = isDefaultGroup
      ? "M365 Copilot"
      : slug === "m365-copilot/gpt-5.6"
        ? "M365 - GPT 5.6"
        : `M365 - ${baseName || label}`;

    const existing = grouped.get(slug) ?? { slug, displayName };
    if (isQuickLabel(label)) {
      existing.quick = item;
    } else if (isThinkLabel(label)) {
      existing.think = item;
    } else {
      existing.single = item;
    }
    grouped.set(slug, existing);
  }

  const results: DiscoveredModelEntry[] = [];
  for (const group of grouped.values()) {
    const primary = group.quick ?? group.think ?? group.single;
    if (!primary) continue;

    const capabilityMeta: M365DiscoveredCapabilityMeta = {
      label: primary.label,
      ...(group.quick ? { quickLabel: group.quick.label } : {}),
      ...(group.think ? { thinkLabel: group.think.label } : {}),
      ...(primary.itemTestId ? { itemTestId: primary.itemTestId } : {}),
      ...(primary.iconTestId ? { iconTestId: primary.iconTestId } : {}),
      ...(group.quick?.itemTestId ? { quickItemTestId: group.quick.itemTestId } : {}),
      ...(group.quick?.iconTestId ? { quickIconTestId: group.quick.iconTestId } : {}),
      ...(group.think?.itemTestId ? { thinkItemTestId: group.think.itemTestId } : {}),
      ...(group.think?.iconTestId ? { thinkIconTestId: group.think.iconTestId } : {}),
      ...(primary.isSubmenu ? { isSubmenu: true } : {}),
      ...(primary.parentMenuTestId ? { parentMenuTestId: primary.parentMenuTestId } : {}),
      ...(primary.parentLabel ? { parentLabel: primary.parentLabel } : {}),
    };

    results.push({
      slug: group.slug,
      providerId: "m365-copilot",
      displayName: group.displayName,
      description: `${group.displayName} qua Microsoft 365 Copilot Web`,
      capabilityMeta,
      contextWindow: 1_000_000,
      inputModalities: ["text", "image"],
      defaultReasoningLevel: "low",
    });
  }

  // Đưa model GPT phụ (vd GPT 5.6) lên trước để khớp thứ tự mặc định của M365ModelProvider.
  results.sort((a, b) => {
    if (a.slug === "m365-copilot" && b.slug !== "m365-copilot") return 1;
    if (b.slug === "m365-copilot" && a.slug !== "m365-copilot") return -1;
    return 0;
  });

  return results;
}

/**
 * Logic Auto-Discovery quét trực tiếp Fluent UI Capability Switcher (`#gptModeSwitcher`) trên M365 Copilot.
 */
export class M365ModelDiscovery {
  public async discoverModels(page: Page): Promise<DiscoveredModelEntry[]> {
    const initialUrl = typeof page.url === "function" ? page.url() : "";
    if (!initialUrl || isM365LoginUrl(initialUrl) || !/cloud\.microsoft/i.test(initialUrl)) {
      await page.goto(M365_CHAT_URL, {
        waitUntil: "domcontentloaded",
        timeout: 25_000,
      });
    }

    await page
      .locator(`${M365_SWITCHER_SELECTOR}, ${M365_CHAT_EDITOR_SELECTOR}`)
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
      .catch(() => {});

    const currentUrl = typeof page.url === "function" ? page.url() : "";
    if (isM365LoginUrl(currentUrl)) {
      throw new Error(
        "Microsoft 365 Copilot session is signed out. Sign in before refreshing models.",
      );
    }

    let menuOpened = false;
    try {
      const opened = await page.evaluate((switcherSelector) => {
        const switcher = document.querySelector<HTMLElement>(switcherSelector);
        if (!switcher) return false;
        switcher.focus();
        switcher.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
        switcher.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        switcher.click();
        switcher.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return true;
      }, M365_SWITCHER_SELECTOR);

      if (!opened) {
        throw new Error("Could not find the M365 capability switcher (#gptModeSwitcher) on the page.");
      }

      menuOpened = true;
      await page
        .waitForSelector('.fui-MenuList[role="menu"], [role="menu"]', { timeout: 3_000 })
        .catch(() => null);

      const collected: RawM365MenuItem[] = [];
      const primaryItems = await page.evaluate(() => {
        const items: Array<{
          label: string;
          itemTestId?: string;
          iconTestId?: string;
        }> = [];
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>(
            '.fui-MenuItem, [role="menuitem"], [role="menuitemradio"]',
          ),
        );
        for (const el of nodes) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (el.getAttribute("aria-haspopup") === "menu") continue;
          const firstLine = (el.innerText || el.textContent || "")
            .split(/\r?\n/)[0]
            ?.replace(/\s+/g, " ")
            .trim();
          if (!firstLine) continue;
          const itemTestId = el.getAttribute("data-testid") || undefined;
          const iconTestId =
            el.querySelector("svg[data-testid]")?.getAttribute("data-testid") || undefined;
          items.push({
            label: firstLine,
            ...(itemTestId ? { itemTestId } : {}),
            ...(iconTestId ? { iconTestId } : {}),
          });
        }
        return items;
      });
      collected.push(...primaryItems);

      const submenuTriggers = page.locator(
        '.fui-MenuItem[aria-haspopup="menu"], [role="menuitem"][aria-haspopup="menu"]',
      );
      const triggerCount = await submenuTriggers.count().catch(() => 0);
      for (let idx = 0; idx < triggerCount; idx += 1) {
        const trigger = submenuTriggers.nth(idx);
        if (!(await trigger.isVisible().catch(() => false))) continue;
        const parentMenuTestId =
          (await trigger.getAttribute("data-testid").catch(() => null)) || undefined;
        const parentLabel = ((await trigger.innerText().catch(() => "")) || "")
          .split(/\r?\n/)[0]
          ?.trim();
        await trigger.hover().catch(() => {});
        await page.waitForTimeout(250);
        await trigger.click({ timeout: 1_500 }).catch(() => {});
        await page.waitForTimeout(350);

        const subItems = await page.evaluate(
          ({ pTestId, pLabel }) => {
            const popovers = Array.from(
              document.querySelectorAll<HTMLElement>('.fui-MenuPopover, [role="menu"]'),
            );
            if (popovers.length < 2) return [];
            const submenuRoot = popovers[popovers.length - 1]!;
            const items: Array<{
              label: string;
              itemTestId?: string;
              iconTestId?: string;
              isSubmenu?: boolean;
              parentMenuTestId?: string;
              parentLabel?: string;
            }> = [];
            for (const el of Array.from(
              submenuRoot.querySelectorAll<HTMLElement>(
                '.fui-MenuItem, [role="menuitem"], [role="menuitemradio"]',
              ),
            )) {
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              const firstLine = (el.innerText || el.textContent || "")
                .split(/\r?\n/)[0]
                ?.replace(/\s+/g, " ")
                .trim();
              if (!firstLine) continue;
              const itemTestId = el.getAttribute("data-testid") || undefined;
              const iconTestId =
                el.querySelector("svg[data-testid]")?.getAttribute("data-testid") || undefined;
              items.push({
                label: firstLine,
                ...(itemTestId ? { itemTestId } : {}),
                ...(iconTestId ? { iconTestId } : {}),
                isSubmenu: true,
                ...(pTestId ? { parentMenuTestId: pTestId } : {}),
                ...(pLabel ? { parentLabel: pLabel } : {}),
              });
            }
            return items;
          },
          { pTestId: parentMenuTestId, pLabel: parentLabel },
        );
        collected.push(...subItems);
      }

      const discovered = buildM365DiscoveredModels(collected);
      if (discovered.length === 0) {
        throw new Error("M365 model switcher opened, but no selectable model items were detected.");
      }
      return discovered;
    } finally {
      if (menuOpened) {
        await page.keyboard.press("Escape").catch(() => {});
        await page.keyboard.press("Escape").catch(() => {});
      }
    }
  }
}
