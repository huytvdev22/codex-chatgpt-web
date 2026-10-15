import { describe, expect, test } from "bun:test";
import {
  isGeminiModelSlug,
  availableGeminiModelRoutes,
  resolveGeminiCapabilityMode,
  GEMINI_MODEL_ROUTES,
} from "../src/gemini-models";
import { GEMINI_SELECTORS } from "../src/adapters/gemini-web/selectors";
import {
  GEMINI_TOOL_PROTOCOL,
  GEMINI_PLAN_MODE_PROMPT,
  GEMINI_SHORT_OUTPUT_FORMAT_ANCHOR,
} from "../src/adapters/gemini-web/prompts/templates";
import { GeminiWebAdapter, createGeminiWebAdapter } from "../src/adapters/gemini-web";
import { augmentNativeModelCatalog } from "../src/model-catalog";

describe("Google Gemini Web Adapter Base Architecture Tests", () => {
  test("1. isGeminiModelSlug nhận diện chính xác các model của Gemini Web", () => {
    expect(isGeminiModelSlug("gemini-web")).toBe(true);
    expect(isGeminiModelSlug("gemini-web/gemini-2.0-flash")).toBe(true);
    expect(isGeminiModelSlug("gemini-web/gemini-2.0-pro")).toBe(true);
    expect(isGeminiModelSlug("gemini-web/thinking")).toBe(true);

    // Không nhận nhầm các adapter khác
    expect(isGeminiModelSlug("m365-copilot")).toBe(false);
    expect(isGeminiModelSlug("chatgpt-web/pro")).toBe(false);
    expect(isGeminiModelSlug("gpt-5")).toBe(false);
  });

  test("2. availableGeminiModelRoutes cung cấp đầy đủ thông tin định tuyến model", () => {
    const routes = availableGeminiModelRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(4);
    const flashRoute = routes.find(r => r.slug === "gemini-web/3.8-flash");
    expect(flashRoute).toBeDefined();
    expect(flashRoute?.capabilityMode).toBe("flash");
    expect(flashRoute?.targetMenuLabel).toBe("3.8 Flash");
    expect(flashRoute?.contextWindow).toBe(128_000);
  });

  test("3. resolveGeminiCapabilityMode phân giải đúng capability", () => {
    expect(resolveGeminiCapabilityMode("gemini-web/3.8-flash")).toBe("flash");
    expect(resolveGeminiCapabilityMode("gemini-web/3.1-pro")).toBe("pro");
    expect(resolveGeminiCapabilityMode("gemini-web/3.5-flash-lite")).toBe("flash-lite");
    expect(resolveGeminiCapabilityMode("gemini-web/4-argon")).toBe("argon");
    expect(resolveGeminiCapabilityMode("gemini-web/thinking")).toBe("thinking");
    expect(resolveGeminiCapabilityMode("gemini-web")).toBe("auto");
  });

  test("4. Model Catalog tự động bổ sung danh sách model của Gemini", () => {
    const dummyCatalog = {
      models: [
        {
          slug: "gpt-5.6-sol",
          display_name: "5.6 Sol",
          description: "native",
          visibility: "list",
          supported_reasoning_levels: [
            { effort: "low", description: "Low" },
          ],
        },
      ],
    };
    const augmented = augmentNativeModelCatalog(dummyCatalog, {} as any);
    const slugs = (augmented.models as any[]).map(m => m.slug);
    expect(slugs).toContain("gemini-web/3.8-flash");
    expect(slugs).toContain("gemini-web/3.1-pro");
    expect(slugs).toContain("gemini-web/3.5-flash-lite");
    expect(slugs).toContain("gemini-web/4-argon");
    expect(slugs).toContain("gemini-web");
  });

  test("5. GEMINI_SELECTORS khai báo đầy đủ các element giao diện cốt lõi", () => {
    expect(GEMINI_SELECTORS.editor).toBeDefined();
    expect(GEMINI_SELECTORS.sendButton).toBeDefined();
    expect(GEMINI_SELECTORS.stopButton).toBeDefined();
    expect(GEMINI_SELECTORS.responseContainer).toBeDefined();
  });

  test("6. GEMINI_TOOL_PROTOCOL tuân thủ vỏ bọc thẻ <geminiResponse> và văn phong bạn đồng hành", () => {
    expect(GEMINI_TOOL_PROTOCOL).toContain("Chào Gemini, mình đang làm việc trên một dự án phần mềm ở máy cá nhân");
    expect(GEMINI_TOOL_PROTOCOL).toContain("<geminiResponse>");
    expect(GEMINI_TOOL_PROTOCOL).toContain("apply_patch");
    expect(GEMINI_SHORT_OUTPUT_FORMAT_ANCHOR).toContain("<geminiResponse>");
    expect(GEMINI_SHORT_OUTPUT_FORMAT_ANCHOR).toContain("4-backtick");
  });

  test("7. GeminiWebAdapter khởi tạo chuẩn ProviderAdapter interface", () => {
    const adapter = createGeminiWebAdapter({ headless: true });
    expect(adapter).toBeInstanceOf(GeminiWebAdapter);
    expect(adapter.name).toBe("gemini-web");
  });
});
