import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import {
  CHATGPT_USAGE_SCOPE_NOTE,
  CHATGPT_USAGE_URL,
  ChatGptUsageLimitChecker,
  formatChatGptPlanName,
  formatDurationCompact,
  parseChatGptUsageDomSnapshot,
  parseChatGptWhamUsagePayload,
} from "../src/adapters/chatgpt";

describe("ChatGPT Usage Limit Checker & Parsers", () => {
  test("chuẩn hóa đúng payload thật từ /backend-api/wham/usage (Plus 0%)", () => {
    const result = parseChatGptWhamUsagePayload({
      plan_type: "plus",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 0,
          limit_window_seconds: 18000,
          reset_after_seconds: 18000,
          reset_at: 1795676667,
        },
        secondary_window: {
          used_percent: 0,
          limit_window_seconds: 604800,
          reset_after_seconds: 604800,
          reset_at: 1796263467,
        },
      },
      code_review_rate_limit: null,
      credits: {
        has_credits: false,
        unlimited: false,
        overage_limit_reached: false,
        balance: "0",
      },
      rate_limit_reset_credits: {
        available_count: 1,
        applicable_available_count: 0,
      },
      ambient_usage: {
        default: {
          menu: {
            rows: [
              {
                label: "5-hour limit",
                value: { text: "100% left" },
                hover: { text: "Resets in 5h 0m" },
              },
              {
                label: "Weekly limit",
                value: { text: "100% left" },
                hover: { text: "Resets in 7d 0h" },
              },
            ],
          },
        },
      },
    });

    expect(result.status).toBe("ok");
    expect(result.planName).toBe("ChatGPT Plus");
    expect(result.sourceKind).toBe("network-json");
    expect(result.scopeNote).toBe(CHATGPT_USAGE_SCOPE_NOTE);
    expect(result.buckets).toHaveLength(3);
    expect(result.buckets[0]).toMatchObject({
      id: "primary_window",
      label: "5-hour limit",
      percentUsed: 0,
      remainingText: "100% left",
      resetText: "Resets in 5h 0m",
      severity: "ok",
    });
    expect(result.buckets[1]).toMatchObject({
      id: "secondary_window",
      label: "Weekly limit",
      percentUsed: 0,
      remainingText: "100% left",
      resetText: "Resets in 7d 0h",
      severity: "ok",
    });
    expect(result.buckets[2]).toMatchObject({
      id: "credits",
      percentUsed: null,
      remainingText: "0 credits remaining",
      resetText: "1 reset pass available",
      severity: "info",
    });
  });

  test("tính đúng mức cảnh báo (>= 80%) và exhausted (100% hoặc limit_reached)", () => {
    const warnResult = parseChatGptWhamUsagePayload({
      plan_type: "pro",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 85,
          limit_window_seconds: 18000,
          reset_after_seconds: 5400,
        },
        secondary_window: {
          used_percent: 40,
          limit_window_seconds: 604800,
          reset_after_seconds: 172800,
        },
      },
    });
    expect(warnResult.planName).toBe("ChatGPT Pro");
    expect(warnResult.status).toBe("warning");
    expect(warnResult.buckets[0].severity).toBe("warning");
    expect(warnResult.buckets[0].resetText).toBe("Resets in 1h 30m");

    const exhaustedResult = parseChatGptWhamUsagePayload({
      plan_type: "plus",
      rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: {
          used_percent: 100,
          limit_window_seconds: 18000,
          reset_after_seconds: 300,
        },
      },
    });
    expect(exhaustedResult.status).toBe("exhausted");
    expect(exhaustedResult.buckets[0].severity).toBe("exhausted");
    expect(formatChatGptPlanName("enterprise")).toBe("ChatGPT Enterprise");
    expect(formatDurationCompact(18000)).toBe("Resets in 5h");
  });

  test("fallback DOM đọc được progress bar và plan khi thiếu JSON network", () => {
    const domResult = parseChatGptUsageDomSnapshot({
      url: CHATGPT_USAGE_URL,
      title: "Settings",
      planLine: "ChatGPT Plus",
      creditsLine: "0 credits remaining",
      mainText: "Usage\nChatGPT Plus\n5-hour limit\nResets in 4h 59m\n100% left\nWeekly limit\nResets in 6d 23h\n92% left",
      progresses: [
        {
          value: 100,
          max: 100,
          ariaLabel: "Usage remaining",
          containerText: "5-hour limit\nResets in 4h 59m\n100% left",
        },
        {
          value: 92,
          max: 100,
          ariaLabel: "Usage remaining",
          containerText: "Weekly limit\nResets in 6d 23h\n92% left",
        },
      ],
    });

    expect(domResult.status).toBe("ok");
    expect(domResult.sourceKind).toBe("dom");
    expect(domResult.planName).toBe("ChatGPT Plus");
    expect(domResult.buckets[0]).toMatchObject({
      label: "5-hour limit",
      percentUsed: 0,
      resetText: "Resets in 4h 59m",
    });
    expect(domResult.buckets[1]).toMatchObject({
      label: "Weekly limit",
      percentUsed: 8,
      resetText: "Resets in 6d 23h",
    });
    expect(domResult.buckets[2]).toMatchObject({
      id: "credits",
      remainingText: "0 credits remaining",
    });
  });

  test("ChatGptUsageLimitChecker trả về signed_out khi trang redirect sang auth", async () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const fakePage = {
      url: () => "https://chatgpt.com/auth/login",
      on: (event: string, fn: (...args: unknown[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
      },
      off: (event: string, fn: (...args: unknown[]) => void) => {
        listeners.get(event)?.delete(fn);
      },
      goto: async () => {},
      reload: async () => {},
      locator: () => ({
        first: () => ({
          waitFor: async () => {},
        }),
      }),
      evaluate: async () => false,
    } as unknown as Page;

    const checker = new ChatGptUsageLimitChecker();
    const res = await checker.check(fakePage);
    expect(res.status).toBe("signed_out");
    expect(res.buckets).toEqual([]);
  });
});
