import { describe, expect, test } from "bun:test";
import {
  isGeminiModelSlug,
  availableGeminiModelRoutes,
  resolveGeminiCapabilityMode,
  GEMINI_MODEL_ROUTES,
} from "../src/gemini-models";
import { GEMINI_SELECTORS } from "../src/adapters/gemini-web/selectors";
import {
  buildUnifiedToolProtocol,
  buildShortOutputFormatAnchor,
} from "../src/adapters/m365-copilot/prompts";
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
    const models = augmented.models as any[];
    const slugs = models.map(m => m.slug);
    expect(slugs).toContain("gemini-web/3.8-flash");
    expect(slugs).toContain("gemini-web/3.1-pro");
    expect(slugs).toContain("gemini-web/3.5-flash-lite");
    expect(slugs).toContain("gemini-web/4-argon");
    expect(slugs).toContain("gemini-web");

    // Kiểm tra cấu hình 3 cấp độ thinking trên TẤT CẢ các model của Gemini
    const geminiSlugs = [
      "gemini-web/3.8-flash",
      "gemini-web/3.1-pro",
      "gemini-web/3.5-flash-lite",
      "gemini-web/4-argon",
      "gemini-web",
    ];

    for (const slug of geminiSlugs) {
      const model = models.find(m => m.slug === slug);
      expect(model).toBeDefined();
      expect(model.default_reasoning_level).toBe("medium");
      expect(model.supported_reasoning_levels).toHaveLength(3);
      const effortNames = model.supported_reasoning_levels.map((l: any) => l.effort);
      expect(effortNames).toEqual(["low", "medium", "high"]);
      const descriptions = model.supported_reasoning_levels.map((l: any) => l.description);
      expect(descriptions[0]).toContain("Thấp");
      expect(descriptions[1]).toContain("Trung bình");
      expect(descriptions[2]).toContain("Cao");
    }
  });

  test("5. GEMINI_SELECTORS khai báo đầy đủ các element giao diện cốt lõi", () => {
    expect(GEMINI_SELECTORS.editor).toBeDefined();
    expect(GEMINI_SELECTORS.sendButton).toBeDefined();
    expect(GEMINI_SELECTORS.stopButton).toBeDefined();
    expect(GEMINI_SELECTORS.responseContainer).toBeDefined();
    expect(GEMINI_SELECTORS.modelSelectorButton).toBeDefined();
    expect(GEMINI_SELECTORS.modelMenuContainer).toBeDefined();
    expect(GEMINI_SELECTORS.thinkingSubmenuTrigger).toBeDefined();
  });

  test("6. buildUnifiedToolProtocol hỗ trợ truyền tên trợ lý linh hoạt với webResponse cố định", () => {
    const geminiPrompt = buildUnifiedToolProtocol("Gemini");
    expect(geminiPrompt).toContain("Chào Gemini, mình đang làm việc trên một dự án phần mềm ở máy cá nhân");
    expect(geminiPrompt).toContain("<webResponse>");
    expect(geminiPrompt).toContain("apply_patch");

    const copilotPrompt = buildUnifiedToolProtocol("Copilot");
    expect(copilotPrompt).toContain("Chào Copilot, mình đang làm việc trên một dự án phần mềm ở máy cá nhân");
    expect(copilotPrompt).toContain("<webResponse>");

    const anchor = buildShortOutputFormatAnchor();
    expect(anchor).toContain("<webResponse>");
    expect(anchor).toContain("4-backtick");
  });

  test("7. GeminiWebAdapter khởi tạo chuẩn ProviderAdapter interface", () => {
    const adapter = createGeminiWebAdapter({ headless: true });
    expect(adapter).toBeInstanceOf(GeminiWebAdapter);
    expect(adapter.name).toBe("gemini-web");
  });

  test("8. Bóc tách và phân tích strict response từ khối Markdown của Gemini Web", () => {
    const { ensureMarkdownTransportFence } = require("../src/adapters/gemini-web/gemini-browser-worker");
    const { parseStrictM365Response } = require("../src/adapters/m365-copilot/translation/strict-response-parser");

    // Giả lập raw text trích xuất từ thẻ code của Gemini Web
    const geminiCodeBlockContent = `<webResponse>
Chào bạn! Mình đã sẵn sàng đồng hành cùng bạn trong dự án này. 

Hiện tại mình chưa nhận được thông tin về mã nguồn hay tác vụ cụ thể cần thực hiện. Bạn muốn bắt đầu từ bước nào (khảo sát cấu trúc thư mục, kiểm tra file cấu hình, hay xử lý một tính năng/bug cụ thể)? Cứ gửi yêu cầu để chúng ta cùng bắt tay vào làm nhé!
</webResponse>`;

    const wrapped = ensureMarkdownTransportFence(geminiCodeBlockContent);
    expect(wrapped.startsWith("````markdown")).toBe(true);
    expect(wrapped.endsWith("````")).toBe(true);

    const parsed = parseStrictM365Response(wrapped);
    expect(parsed.kind).toBe("final_answer");
    if (parsed.kind === "final_answer") {
      expect(parsed.content).toContain("Chào bạn! Mình đã sẵn sàng đồng hành cùng bạn trong dự án này.");
      // Đã bóc sạch không còn thẻ <webResponse>
      expect(parsed.content).not.toContain("<webResponse>");
      expect(parsed.content).not.toContain("</webResponse>");
    }

    // Giả lập tool call qua strict-parser
    const geminiToolContent = `<webResponse>
<tool_call>
{"name": "read_file", "arguments": {"path": "package.json"}}
</tool_call>
</webResponse>`;

    const toolWrapped = ensureMarkdownTransportFence(geminiToolContent);
    const parsedTool = parseStrictM365Response(toolWrapped);
    expect(parsedTool.kind).toBe("tool_calls");
    if (parsedTool.kind === "tool_calls") {
      expect(parsedTool.calls).toHaveLength(1);
      expect(parsedTool.calls[0].name).toBe("read_file");
      expect(parsedTool.calls[0].arguments).toEqual({ path: "package.json" });
    }
  });
});
