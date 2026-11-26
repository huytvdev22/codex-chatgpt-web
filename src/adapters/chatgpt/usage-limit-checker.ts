import type { Page, Response as PlaywrightResponse } from "playwright-core";
import {
  clampPercent,
  computeLimitBucketSeverity,
  computeOverallLimitStatus,
  DEFAULT_LIMIT_WARNING_THRESHOLD_PERCENT,
  type ProviderLimitBucket,
  type ProviderLimitCheckResult,
} from "../../limits/types";
import { isChatGptAuthUrl } from "./conversation-url";

export const CHATGPT_USAGE_URL =
  "https://chatgpt.com/settings/usage?tab=overview";
export const CHATGPT_USAGE_SCOPE_NOTE =
  "Plan limits apply across Codex, Work, and Workspace Agents (web chat conversations are not included).";

export interface ChatGptWhamRateWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
}

export interface ChatGptWhamRateLimit {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: ChatGptWhamRateWindow | null;
  secondary_window?: ChatGptWhamRateWindow | null;
}

export interface ChatGptWhamUsagePayload {
  plan_type?: string | null;
  rate_limit?: ChatGptWhamRateLimit | null;
  code_review_rate_limit?: ChatGptWhamRateLimit | null;
  additional_rate_limits?: unknown;
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    overage_limit_reached?: boolean;
    balance?: string | number | null;
  } | null;
  rate_limit_reset_credits?: {
    available_count?: number;
    applicable_available_count?: number;
  } | null;
  ambient_usage?: {
    default?: {
      menu?: {
        rows?: Array<{
          label?: string;
          value?: { text?: string };
          hover?: { text?: string };
        }>;
      };
    };
  } | null;
}

export interface ChatGptUsageDomProgressItem {
  value: number;
  max: number;
  ariaLabel?: string | null;
  containerText: string;
}

export interface ChatGptUsageDomSnapshot {
  url: string;
  title: string;
  planLine?: string | null;
  creditsLine?: string | null;
  mainText: string;
  progresses: ChatGptUsageDomProgressItem[];
}

export function formatChatGptPlanName(planType?: string | null): string | null {
  const clean = typeof planType === "string" ? planType.trim().toLowerCase() : "";
  if (!clean) return null;
  const known: Record<string, string> = {
    free: "ChatGPT Free",
    plus: "ChatGPT Plus",
    pro: "ChatGPT Pro",
    team: "ChatGPT Team",
    business: "ChatGPT Business",
    enterprise: "ChatGPT Enterprise",
    edu: "ChatGPT Edu",
    go: "ChatGPT Go",
  };
  if (known[clean]) return known[clean];
  return `ChatGPT ${clean.charAt(0).toUpperCase()}${clean.slice(1)}`;
}

export function formatDurationCompact(seconds?: number | null): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) {
    return `Resets in ${Math.max(1, totalMinutes)}m`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (totalHours < 24) {
    return mins > 0 ? `Resets in ${totalHours}h ${mins}m` : `Resets in ${totalHours}h`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `Resets in ${days}d ${hours}h` : `Resets in ${days}d`;
}

function resolveWindowLabel(
  prefix: string,
  windowSeconds?: number | null,
  fallbackLabel = "Usage limit",
): string {
  if (typeof windowSeconds === "number" && Number.isFinite(windowSeconds) && windowSeconds > 0) {
    if (windowSeconds === 18_000) return `${prefix}5-hour limit`;
    if (windowSeconds === 604_800) return `${prefix}Weekly limit`;
    const hours = Math.round(windowSeconds / 3600);
    if (hours >= 24 && hours % 24 === 0) {
      const days = hours / 24;
      return `${prefix}${days}-day limit`;
    }
    return `${prefix}${hours}-hour limit`;
  }
  return `${prefix}${fallbackLabel}`;
}

function buildWindowBucket(
  id: string,
  label: string,
  window: ChatGptWhamRateWindow,
  ambientHint?: { valueText?: string; hoverText?: string },
): ProviderLimitBucket {
  const percentUsed = clampPercent(Number(window.used_percent ?? 0));
  const percentLeft = Math.max(0, 100 - percentUsed);
  const resetAt =
    typeof window.reset_at === "number" && Number.isFinite(window.reset_at) && window.reset_at > 0
      ? new Date(window.reset_at * 1000).toISOString()
      : null;
  const resetText =
    ambientHint?.hoverText?.trim() ||
    formatDurationCompact(window.reset_after_seconds) ||
    null;

  return {
    id,
    label,
    percentUsed,
    usedText: `${percentUsed}% used`,
    remainingText: ambientHint?.valueText?.trim() || `${percentLeft}% left`,
    resetAt,
    resetText,
    severity: computeLimitBucketSeverity(
      percentUsed,
      DEFAULT_LIMIT_WARNING_THRESHOLD_PERCENT,
    ),
  };
}

export function parseChatGptWhamUsagePayload(
  payload: ChatGptWhamUsagePayload,
  sourceUrl = CHATGPT_USAGE_URL,
): ProviderLimitCheckResult {
  const buckets: ProviderLimitBucket[] = [];
  const ambientRows = payload.ambient_usage?.default?.menu?.rows ?? [];
  const findAmbientHint = (match: RegExp) => {
    const row = ambientRows.find((r) => typeof r.label === "string" && match.test(r.label));
    return row
      ? { valueText: row.value?.text, hoverText: row.hover?.text }
      : undefined;
  };

  if (payload.rate_limit?.primary_window) {
    buckets.push(
      buildWindowBucket(
        "primary_window",
        resolveWindowLabel("", payload.rate_limit.primary_window.limit_window_seconds, "5-hour limit"),
        payload.rate_limit.primary_window,
        findAmbientHint(/5-hour|primary/i),
      ),
    );
  }
  if (payload.rate_limit?.secondary_window) {
    buckets.push(
      buildWindowBucket(
        "secondary_window",
        resolveWindowLabel("", payload.rate_limit.secondary_window.limit_window_seconds, "Weekly limit"),
        payload.rate_limit.secondary_window,
        findAmbientHint(/weekly|secondary/i),
      ),
    );
  }

  if (payload.code_review_rate_limit?.primary_window) {
    buckets.push(
      buildWindowBucket(
        "code_review_primary",
        resolveWindowLabel(
          "Code Review · ",
          payload.code_review_rate_limit.primary_window.limit_window_seconds,
          "5-hour limit",
        ),
        payload.code_review_rate_limit.primary_window,
      ),
    );
  }
  if (payload.code_review_rate_limit?.secondary_window) {
    buckets.push(
      buildWindowBucket(
        "code_review_secondary",
        resolveWindowLabel(
          "Code Review · ",
          payload.code_review_rate_limit.secondary_window.limit_window_seconds,
          "Weekly limit",
        ),
        payload.code_review_rate_limit.secondary_window,
      ),
    );
  }

  if (payload.credits) {
    const balanceRaw = payload.credits.balance ?? "0";
    const balanceText = payload.credits.unlimited
      ? "Unlimited credits"
      : `${String(balanceRaw)} credits remaining`;
    const resetCreditsCount = payload.rate_limit_reset_credits?.available_count ?? 0;
    buckets.push({
      id: "credits",
      label: "Credits",
      percentUsed: null,
      remainingText: balanceText,
      resetText:
        resetCreditsCount > 0
          ? `${resetCreditsCount} reset pass available`
          : null,
      severity: "info",
    });
  }

  const limitReached =
    payload.rate_limit?.limit_reached === true ||
    payload.rate_limit?.allowed === false;
  const status = computeOverallLimitStatus(
    buckets,
    limitReached,
    DEFAULT_LIMIT_WARNING_THRESHOLD_PERCENT,
  );
  const planName = formatChatGptPlanName(payload.plan_type);
  const summaryParts = buckets.map((b) =>
    b.percentUsed !== null
      ? `${b.label}: ${b.remainingText ?? `${100 - b.percentUsed}% left`}`
      : `${b.label}: ${b.remainingText ?? ""}`,
  );

  return {
    status,
    planName,
    sourceUrl,
    sourceKind: "network-json",
    scopeNote: CHATGPT_USAGE_SCOPE_NOTE,
    providerUpdatedText: null,
    buckets,
    rawSummary: summaryParts.filter(Boolean).join(" · ") || null,
    lastError: null,
  };
}

export function parseChatGptUsageDomSnapshot(
  dom: ChatGptUsageDomSnapshot,
): ProviderLimitCheckResult {
  const buckets: ProviderLimitBucket[] = [];
  const mainLines = dom.mainText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  dom.progresses.forEach((item, index) => {
    const max = item.max > 0 ? item.max : 100;
    const rawRemainingPct = clampPercent((item.value / max) * 100);
    const lines = item.containerText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const leftLine = lines.find((l) => /\d+%\s*left/i.test(l));
    const usedLine = lines.find((l) => /\d+%\s*used/i.test(l));
    const resetLine = lines.find((l) => /resets?\s+in/i.test(l)) ?? null;

    let percentUsed = 100 - rawRemainingPct;
    if (usedLine) {
      const m = /(\d+(?:\.\d+)?)\s*%/.exec(usedLine);
      if (m) percentUsed = clampPercent(Number(m[1]));
    } else if (leftLine) {
      const m = /(\d+(?:\.\d+)?)\s*%/.exec(leftLine);
      if (m) percentUsed = clampPercent(100 - Number(m[1]));
    }

    const labelFromBlock = lines.find(
      (l) => !/\d+%\s*(left|used)/i.test(l) && !/resets?\s+in/i.test(l),
    );
    const label =
      labelFromBlock ||
      (index === 0 ? "5-hour limit" : index === 1 ? "Weekly limit" : `Limit ${index + 1}`);

    buckets.push({
      id: `dom_limit_${index + 1}`,
      label,
      percentUsed,
      usedText: `${percentUsed}% used`,
      remainingText: leftLine || `${100 - percentUsed}% left`,
      resetAt: null,
      resetText: resetLine,
      severity: computeLimitBucketSeverity(
        percentUsed,
        DEFAULT_LIMIT_WARNING_THRESHOLD_PERCENT,
      ),
    });
  });

  if (dom.creditsLine) {
    buckets.push({
      id: "credits",
      label: "Credits",
      percentUsed: null,
      remainingText: dom.creditsLine,
      resetText: null,
      severity: "info",
    });
  }

  const detectedPlan =
    dom.planLine?.trim() ||
    mainLines.find((line) => /^ChatGPT\s+(Free|Plus|Pro|Team|Enterprise|Business|Edu|Go)\b/i.test(line)) ||
    null;

  const status = computeOverallLimitStatus(
    buckets,
    false,
    DEFAULT_LIMIT_WARNING_THRESHOLD_PERCENT,
  );
  const rawSummary = mainLines.slice(0, 12).join(" | ").slice(0, 500) || null;

  return {
    status,
    planName: detectedPlan,
    sourceUrl: dom.url || CHATGPT_USAGE_URL,
    sourceKind: buckets.length > 0 ? "dom" : "dom-fallback",
    scopeNote: CHATGPT_USAGE_SCOPE_NOTE,
    providerUpdatedText: null,
    buckets,
    rawSummary,
    lastError:
      buckets.length === 0
        ? "Could not locate usage limit metrics on ChatGPT Settings page."
        : null,
  };
}

function isWhamUsageResponseUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.origin === "https://chatgpt.com" &&
      parsed.pathname === "/backend-api/wham/usage"
    );
  } catch {
    return false;
  }
}

/**
 * Kiểm tra hạn mức sử dụng ChatGPT (`chatgpt.com/settings/usage?tab=overview`)
 * theo chiến lược Hybrid: ưu tiên bắt JSON `/backend-api/wham/usage`, fallback sang DOM.
 */
export class ChatGptUsageLimitChecker {
  public async check(
    page: Page,
    abortSignal?: AbortSignal,
  ): Promise<ProviderLimitCheckResult> {
    if (abortSignal?.aborted) {
      throw new DOMException("ChatGPT limit check aborted", "AbortError");
    }

    let capturedStatus: number | null = null;
    let capturedPayload: ChatGptWhamUsagePayload | null = null;
    let resolvePayloadWaiter: (() => void) | null = null;

    const onResponse = async (response: PlaywrightResponse) => {
      if (!isWhamUsageResponseUrl(response.url())) return;
      capturedStatus = response.status();
      if (capturedStatus >= 200 && capturedStatus < 300) {
        try {
          const json = (await response.json()) as ChatGptWhamUsagePayload;
          if (json && typeof json === "object") {
            capturedPayload = json;
            resolvePayloadWaiter?.();
          }
        } catch {
          // Bỏ qua lỗi parse JSON; sẽ fallback sang DOM
        }
      } else if (capturedStatus === 401 || capturedStatus === 403) {
        resolvePayloadWaiter?.();
      }
    };

    page.on("response", onResponse);
    try {
      const currentUrl = typeof page.url === "function" ? page.url() : "";
      if (currentUrl.startsWith("https://chatgpt.com/settings/usage")) {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 25_000 });
      } else {
        await page.goto(CHATGPT_USAGE_URL, {
          waitUntil: "domcontentloaded",
          timeout: 25_000,
        });
      }

      if (!capturedPayload) {
        await Promise.race([
          new Promise<void>((resolve) => {
            resolvePayloadWaiter = resolve;
            setTimeout(resolve, 12_000);
          }),
          page
            .locator('main progress[aria-label="Usage remaining"]')
            .first()
            .waitFor({ state: "visible", timeout: 12_000 })
            .then(() => new Promise<void>((r) => setTimeout(r, 350)))
            .catch(() => {}),
        ]);
      }

      const finalUrl = typeof page.url === "function" ? page.url() : CHATGPT_USAGE_URL;
      if (isChatGptAuthUrl(finalUrl) || capturedStatus === 401) {
        return {
          status: "signed_out",
          planName: null,
          sourceUrl: finalUrl,
          sourceKind: "dom",
          scopeNote: CHATGPT_USAGE_SCOPE_NOTE,
          providerUpdatedText: null,
          buckets: [],
          rawSummary: null,
          lastError: "ChatGPT session is signed out. Sign in before checking limits.",
        };
      }

      const isCloudflareChallenge = await page
        .evaluate(() => {
          const title = (document.title || "").toLowerCase();
          if (title.includes("just a moment")) return true;
          return Boolean(
            document.querySelector(
              "#challenge-running, #challenge-stage, input[name='cf-turnstile-response']",
            ),
          );
        })
        .catch(() => false);

      if (isCloudflareChallenge) {
        return {
          status: "challenge",
          planName: null,
          sourceUrl: finalUrl,
          sourceKind: "dom",
          scopeNote: CHATGPT_USAGE_SCOPE_NOTE,
          providerUpdatedText: null,
          buckets: [],
          rawSummary: null,
          lastError:
            "ChatGPT is showing a Cloudflare verification page. Complete verification in the Browser tab first.",
        };
      }

      if (capturedPayload) {
        return parseChatGptWhamUsagePayload(capturedPayload, finalUrl);
      }

      const domSnapshot = await page.evaluate((): ChatGptUsageDomSnapshot => {
        const main = document.querySelector("main") || document.body;
        const mainText = (main?.innerText || "").slice(0, 6000);
        const lines = mainText
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        const planLine =
          lines.find((l) => /^ChatGPT\s+(Free|Plus|Pro|Team|Enterprise|Business|Edu|Go)\b/i.test(l)) ??
          null;
        const creditsLine =
          lines.find((l) => /\bcredits?\s+remaining\b/i.test(l)) ?? null;
        const progresses = Array.from(
          (main || document).querySelectorAll<HTMLProgressElement>("progress"),
        ).map((el) => {
          const container =
            el.closest("div")?.parentElement?.parentElement ||
            el.parentElement?.parentElement ||
            el.parentElement;
          return {
            value: typeof el.value === "number" ? el.value : 0,
            max: typeof el.max === "number" && el.max > 0 ? el.max : 100,
            ariaLabel: el.getAttribute("aria-label"),
            containerText: (container?.innerText || "").trim(),
          };
        });
        return {
          url: location.href,
          title: document.title,
          planLine,
          creditsLine,
          mainText,
          progresses,
        };
      });

      return parseChatGptUsageDomSnapshot(domSnapshot);
    } finally {
      page.off("response", onResponse);
    }
  }
}
