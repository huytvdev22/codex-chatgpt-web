import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import {
  formatGeminiPlanName,
  GEMINI_USAGE_URL,
  GeminiUsageLimitChecker,
  parseGeminiUsageDomSnapshot,
} from "../src/adapters/gemini";

describe("Gemini Usage Limit Checker & Parsers", () => {
  test("parse chính xác cấu trúc DOM thực tế của gemini.google.com/usage (tiếng Việt)", () => {
    const result = parseGeminiUsageDomSnapshot({
      url: GEMINI_USAGE_URL,
      title: "Cách sử dụng",
      planBadge: "PRO",
      updatedText: "Đã cập nhật 3 phút trước",
      items: [
        {
          testId: "current-usage",
          label: "Mức sử dụng hiện tại",
          percentText: "Đã sử dụng 0%",
          cssWidthPercent: 0,
          resetText: "Đặt lại lúc 10:50",
          fullText: "Mức sử dụng hiện tại\ninfo\nĐã sử dụng 0%\nĐặt lại lúc 10:50",
        },
        {
          testId: "weekly-usage",
          label: "Hạn mức hằng tuần",
          percentText: "Đã sử dụng 2%",
          cssWidthPercent: null,
          resetText: "Đặt lại vào 1 thg 12 lúc 9:50",
          fullText: "Hạn mức hằng tuần\nĐặt lại vào 1 thg 12 lúc 9:50\nĐã sử dụng 2%",
        },
      ],
      sectionText:
        "Hạn mức sử dụng\nPRO\nĐã cập nhật 3 phút trước\nMức sử dụng hiện tại\nĐã sử dụng 0%\nĐặt lại lúc 10:50\nHạn mức hằng tuần\nĐặt lại vào 1 thg 12 lúc 9:50\nĐã sử dụng 2%",
    });

    expect(result.status).toBe("ok");
    expect(result.planName).toBe("Gemini Pro");
    expect(result.sourceKind).toBe("dom");
    expect(result.providerUpdatedText).toBe("Đã cập nhật 3 phút trước");
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets[0]).toMatchObject({
      id: "current-usage",
      label: "Mức sử dụng hiện tại",
      percentUsed: 0,
      usedText: "Đã sử dụng 0%",
      remainingText: "100% left",
      resetText: "Đặt lại lúc 10:50",
      severity: "ok",
    });
    expect(result.buckets[1]).toMatchObject({
      id: "weekly-usage",
      label: "Hạn mức hằng tuần",
      percentUsed: 2,
      usedText: "Đã sử dụng 2%",
      remainingText: "98% left",
      resetText: "Đặt lại vào 1 thg 12 lúc 9:50",
      severity: "ok",
    });
  });

  test("hỗ trợ tiếng Anh, fallback CSS --x-width, và phân loại warning/exhausted", () => {
    const result = parseGeminiUsageDomSnapshot({
      url: GEMINI_USAGE_URL,
      title: "Usage",
      planBadge: "ULTRA",
      updatedText: "Updated 1 minute ago",
      items: [
        {
          testId: "current-usage",
          label: "Current usage",
          percentText: null,
          cssWidthPercent: 86,
          resetText: "Resets at 14:00",
          fullText: "Current usage\nResets at 14:00",
        },
        {
          testId: "weekly-usage",
          label: "Weekly limit",
          percentText: "100% used",
          cssWidthPercent: 100,
          resetText: "Resets Dec 1 at 9:50 AM",
          fullText: "Weekly limit\n100% used\nResets Dec 1 at 9:50 AM",
        },
      ],
      sectionText: "",
    });

    expect(result.planName).toBe("Gemini Ultra");
    expect(result.status).toBe("exhausted");
    expect(result.buckets[0]).toMatchObject({
      percentUsed: 86,
      severity: "warning",
    });
    expect(result.buckets[1]).toMatchObject({
      percentUsed: 100,
      severity: "exhausted",
    });
    expect(formatGeminiPlanName("FREE")).toBe("Gemini Free");
  });

  test("fallback text khi Google thay đổi data-testid trên DOM", () => {
    const fallbackResult = parseGeminiUsageDomSnapshot({
      url: GEMINI_USAGE_URL,
      title: "Usage",
      planBadge: "PRO",
      updatedText: null,
      items: [],
      sectionText: "Usage limits\nCurrent usage\n82% used\nWeekly limit\n15% used",
    });
    expect(fallbackResult.status).toBe("warning");
    expect(fallbackResult.buckets).toHaveLength(2);
    expect(fallbackResult.buckets[0]).toMatchObject({
      label: "Current usage",
      percentUsed: 82,
      severity: "warning",
    });
  });

  test("GeminiUsageLimitChecker trả về signed_out khi redirect sang accounts.google.com", async () => {
    const fakePage = {
      url: () => "https://accounts.google.com/v3/signin",
      goto: async () => {},
      reload: async () => {},
      locator: () => ({
        first: () => ({
          waitFor: async () => {},
        }),
      }),
      evaluate: async () => ({
        url: "https://accounts.google.com/v3/signin",
        title: "Sign in",
        items: [],
        sectionText: "",
      }),
    } as unknown as Page;

    const checker = new GeminiUsageLimitChecker();
    const res = await checker.check(fakePage);
    expect(res.status).toBe("signed_out");
    expect(res.buckets).toEqual([]);
  });
});
