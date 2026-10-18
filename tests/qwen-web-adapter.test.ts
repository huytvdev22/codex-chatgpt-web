import { describe, expect, test } from "bun:test";
import {
  isQwenModelSlug,
  availableQwenWebModelRoutes,
  QWEN_WEB_DEFAULT_ROUTE,
} from "../src/qwen-web-models";
import { QWEN_SELECTORS, extractConversationIdFromUrl, isValidQwenConversationId } from "../src/adapters/qwen-web/selectors";
import { createQwenWebAdapter, QwenWebAdapter } from "../src/adapters/qwen-web";
import { buildQwenModel } from "../src/model-catalog";

describe("Qwen Web Adapter Architecture & Integration Tests", () => {
  test("1. isQwenModelSlug nhận diện chính xác các model của Qwen Web", () => {
    expect(isQwenModelSlug("qwen-web")).toBe(true);
    expect(isQwenModelSlug("qwen-web/think")).toBe(true);
    expect(isQwenModelSlug("chatgpt-web")).toBe(false);
    expect(isQwenModelSlug("m365-copilot/general")).toBe(false);
    expect(isQwenModelSlug("")).toBe(false);
  });

  test("2. availableQwenWebModelRoutes trả về route mặc định với chế độ Think", () => {
    const routes = availableQwenWebModelRoutes();
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0].slug).toBe("qwen-web");
    expect(routes[0].displayName).toBe("Qwen (Web)");
    expect(routes[0].contextWindow).toBe(128_000);
  });

  test("3. Model Catalog tạo model qwen-web chuẩn chỉnh", () => {
    const mockTemplate: any = {
      slug: "native-template",
      display_name: "Template",
      description: "Base",
      context_window: 100_000,
    };
    const mockConfig: any = {};
    const model = buildQwenModel(mockTemplate, QWEN_WEB_DEFAULT_ROUTE, mockConfig);

    expect(model.slug).toBe("qwen-web");
    expect(model.display_name).toBe("Qwen (Web)");
    expect(model.context_window).toBe(128_000);
    expect(model.default_reasoning_level).toBe("none");
    expect(Array.isArray(model.supported_reasoning_levels)).toBe(true);
  });

  test("4. QWEN_SELECTORS chứa đầy đủ các bộ chọn DOM thực tế từ giao diện", () => {
    expect(QWEN_SELECTORS.composer).toBe("textarea.message-input-textarea");
    expect(QWEN_SELECTORS.sendButton).toContain("button.send-button");
    expect(QWEN_SELECTORS.stopButton).toContain("button.stop-button");
    expect(QWEN_SELECTORS.assistantMessage).toBe(".chat-response-message");
    expect(QWEN_SELECTORS.codeBlock).toBe("pre.qwen-markdown-code");
    expect(QWEN_SELECTORS.codeCopyButton).toContain('[aria-label="Copy"]');
  });

  test("5. Trích xuất đúng Conversation ID từ URL Qwen Web", () => {
    const url = "https://chat.qwen.ai/c/58703ee0-04f5-4621-b17a-b20201be1ead";
    expect(extractConversationIdFromUrl(url)).toBe("58703ee0-04f5-4621-b17a-b20201be1ead");
    expect(isValidQwenConversationId("58703ee0-04f5-4621-b17a-b20201be1ead")).toBe(true);
    expect(isValidQwenConversationId("not-a-valid-uuid")).toBe(false);
  });

  test("6. QwenWebAdapter khởi tạo chuẩn ProviderAdapter interface", () => {
    const adapter = createQwenWebAdapter();
    expect(adapter.name).toBe("qwen-web");
    expect(typeof adapter.runTurn).toBe("function");
    expect(typeof adapter.abortTurn).toBe("function");
    expect(typeof adapter.cleanup).toBe("function");
  });
});
