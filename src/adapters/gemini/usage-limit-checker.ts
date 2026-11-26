import type { Page } from "playwright-core";
import {
  clampPercent,
  computeLimitBucketSeverity,
  computeOverallLimitStatus,
  DEFAULT_LIMIT_WARNING_THRESHOLD_PERCENT,
  type ProviderLimitBucket,
  type ProviderLimitCheckResult,
} from "../../limits/types";
import { isGeminiAuthUrl } from "./conversation-url";

export const GEMINI_USAGE_URL = "https://gemini.google.com/usage";

export interface GeminiUsageDomBucketItem {
  testId: string;
  label: string;
  percentText?: string | null;
  cssWidthPercent?: number | null;
  resetText?: string | null;
  fullText: string;
}

export interface GeminiUsageDomSnapshot {
  url: string;
  title: string;
  planBadge?: string | null;
  updatedText?: string | null;
  items: GeminiUsageDomBucketItem[];
  sectionText: string;
}

export function formatGeminiPlanName(badge?: string | null): string | null {
  const clean = typeof badge === "string" ? badge.trim() : "";
  if (!clean) return null;
  const upper = clean.toUpperCase();
  if (upper === "PRO") return "Gemini Pro";
  if (upper === "ULTRA") return "Gemini Ultra";
  if (upper === "PLUS") return "Gemini Plus";
  if (upper === "FREE") return "Gemini Free";
  if (clean.toLowerCase().startsWith("gemini")) return clean;
  return `Gemini ${clean}`;
}

function extractPercentFromText(raw?: string | null): number | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const match = /(\d+(?:[.,]\d+)?)\s*%/.exec(raw);
  if (!match) return null;
  const numeric = Number(match[1].replace(",", "."));
  if (!Number.isFinite(numeric)) return null;
  return clampPercent(numeric);
}

export function parseGeminiUsageDomSnapshot(
  dom: GeminiUsageDomSnapshot,
): ProviderLimitCheckResult {
  const buckets: ProviderLimitBucket[] = [];

  for (const item of dom.items) {
    const label = item.label.trim();
    if (!label) continue;

    const percentUsed =
      extractPercentFromText(item.percentText) ??
      extractPercentFromText(item.fullText) ??
      (typeof item.cssWidthPercent === "number" && Number.isFinite(item.cssWidthPercent)
        ? clampPercent(item.cssWidthPercent)
        : null);

    if (percentUsed === null) continue;

    const remainingPercent = Math.max(0, 100 - percentUsed);
    const id = item.testId.trim().replace(/[^a-z0-9_-]+/gi, "_") || `bucket_${buckets.length + 1}`;
    const resetText = item.resetText?.trim() || null;

    buckets.push({
      id,
      label,
      percentUsed,
      usedText: item.percentText?.trim() || `${percentUsed}% used`,
      remainingText: `${remainingPercent}% left`,
      resetAt: null,
      resetText,
      severity: computeLimitBucketSeverity(
        percentUsed,
        DEFAULT_LIMIT_WARNING_THRESHOLD_PERCENT,
      ),
    });
  }

  const lines = dom.sectionText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // Fallback nếu Google thay đổi `data-testid` của các thẻ `<li>`
  if (buckets.length === 0 && lines.length > 0) {
    for (let i = 0; i < lines.length; i++) {
      const pct = extractPercentFromText(lines[i]);
      if (pct === null) continue;
      const prev = i > 0 ? lines[i - 1] : "";
      const label =
        prev && !/\d+\s*%/.test(prev) && prev !== "info"
          ? prev
          : `Gemini quota ${buckets.length + 1}`;
      buckets.push({
        id: `fallback_${buckets.length + 1}`,
        label,
        percentUsed: pct,
        usedText: lines[i],
        remainingText: `${Math.max(0, 100 - pct)}% left`,
        resetAt: null,
        resetText: null,
        severity: computeLimitBucketSeverity(
          pct,
          DEFAULT_LIMIT_WARNING_THRESHOLD_PERCENT,
        ),
      });
    }
  }

  const status = computeOverallLimitStatus(
    buckets,
    false,
    DEFAULT_LIMIT_WARNING_THRESHOLD_PERCENT,
  );
  const planName = formatGeminiPlanName(dom.planBadge);
  const rawSummary =
    buckets.length > 0
      ? buckets
          .map((b) =>
            `${b.label}: ${b.usedText ?? `${b.percentUsed}% used`}${b.resetText ? ` (${b.resetText})` : ""}`,
          )
          .join(" · ")
      : lines.slice(0, 10).join(" | ").slice(0, 500) || null;

  return {
    status,
    planName,
    sourceUrl: dom.url || GEMINI_USAGE_URL,
    sourceKind: buckets.length > 0 ? "dom" : "dom-fallback",
    scopeNote: null,
    providerUpdatedText: dom.updatedText?.trim() || null,
    buckets,
    rawSummary,
    lastError:
      buckets.length === 0
        ? "Could not locate usage limit metrics on Gemini Usage page."
        : null,
  };
}

/**
 * Kiểm tra hạn mức sử dụng Gemini (`gemini.google.com/usage`) bằng đọc DOM
 * trực tiếp từ `[data-usage-island-root]` (`current-usage`, `weekly-usage`, ...).
 */
export class GeminiUsageLimitChecker {
  public async check(
    page: Page,
    abortSignal?: AbortSignal,
  ): Promise<ProviderLimitCheckResult> {
    if (abortSignal?.aborted) {
      throw new DOMException("Gemini limit check aborted", "AbortError");
    }

    const currentUrl = typeof page.url === "function" ? page.url() : "";
    if (currentUrl.startsWith(GEMINI_USAGE_URL)) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 25_000 });
    } else {
      await page.goto(GEMINI_USAGE_URL, {
        waitUntil: "domcontentloaded",
        timeout: 25_000,
      });
    }

    await page
      .locator(
        '[data-usage-island-root] [data-testid="current-usage"], [data-usage-island-root] [data-testid="weekly-usage"], [data-usage-island-root] h1, section[data-host-theme] h1',
      )
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
      .catch(() => {});

    // Chờ thêm một nhịp ngắn nếu island đang hydrate phần danh sách
    await page
      .locator('[data-usage-island-root] ul li[data-testid]')
      .first()
      .waitFor({ state: "visible", timeout: 4_000 })
      .catch(() => {});

    const finalUrl = typeof page.url === "function" ? page.url() : GEMINI_USAGE_URL;
    if (isGeminiAuthUrl(finalUrl)) {
      return {
        status: "signed_out",
        planName: null,
        sourceUrl: finalUrl,
        sourceKind: "dom",
        scopeNote: null,
        providerUpdatedText: null,
        buckets: [],
        rawSummary: null,
        lastError: "Gemini session is signed out. Sign in before checking limits.",
      };
    }

    const domSnapshot = await page.evaluate((): GeminiUsageDomSnapshot => {
      const root =
        document.querySelector<HTMLElement>("[data-usage-island-root]") ||
        document.querySelector<HTMLElement>("section[data-host-theme]") ||
        document.querySelector<HTMLElement>("main") ||
        document.body;

      const h1 = root?.querySelector("h1");
      const planBadge =
        h1?.nextElementSibling?.textContent?.trim() ||
        null;

      const updatedText =
        root?.querySelector<HTMLElement>('[data-testid="usage-updated"]')?.innerText?.trim() ||
        null;

      const items = Array.from(
        root?.querySelectorAll<HTMLElement>("ul li[data-testid]") || [],
      ).map((li) => {
        const testId = li.getAttribute("data-testid") || "";
        const strongs = Array.from(li.querySelectorAll<HTMLElement>("strong"))
          .map((s) => (s.innerText || s.textContent || "").trim())
          .filter(Boolean);
        const label = strongs[0] || "";
        const percentText =
          strongs.find((text) => /%/.test(text)) ||
          strongs[1] ||
          null;

        const barEl = li.querySelector<HTMLElement>('[style*="--x-width"]');
        let cssWidthPercent: number | null = null;
        if (barEl) {
          const styleAttr = barEl.getAttribute("style") || "";
          const m = /--x-width\s*:\s*(\d+(?:\.\d+)?)\s*%/.exec(styleAttr);
          if (m) {
            const parsed = Number(m[1]);
            if (Number.isFinite(parsed)) cssWidthPercent = parsed;
          }
        }

        const spans = Array.from(li.querySelectorAll<HTMLElement>("span"))
          .filter((s) => s.getAttribute("aria-hidden") !== "true")
          .map((s) => (s.innerText || s.textContent || "").trim())
          .filter(Boolean);
        // Chọn span cuối cùng không trùng nhãn + không chứa % + không chỉ là icon "info"
        const resetCandidates = spans.filter(
          (t) =>
            t !== "info" &&
            !t.includes("%") &&
            t !== label &&
            !t.includes("\n"),
        );
        const resetText = resetCandidates[resetCandidates.length - 1] ?? null;

        return {
          testId,
          label,
          percentText,
          cssWidthPercent,
          resetText,
          fullText: (li.innerText || "").trim(),
        };
      });

      return {
        url: location.href,
        title: document.title,
        planBadge,
        updatedText,
        items,
        sectionText: (root?.innerText || "").slice(0, 6000),
      };
    });

    return parseGeminiUsageDomSnapshot(domSnapshot);
  }
}
