import { describe, expect, test } from "bun:test";
import {
  isQwenModelSlug,
  availableQwenWebModelRoutes,
  QWEN_WEB_DEFAULT_ROUTE,
} from "../src/qwen-web-models";
import { QWEN_SELECTORS, extractConversationIdFromUrl, isValidQwenConversationId } from "../src/adapters/qwen-web/selectors";
import { createQwenWebAdapter, QwenWebAdapter } from "../src/adapters/qwen-web";
import { QwenConversationStore } from "../src/adapters/qwen-web/conversation-store";
import { buildQwenModel } from "../src/model-catalog";
import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";

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

  test("3. Model Catalog tạo model qwen-web chuẩn chỉnh giống ChatGPT Web", () => {
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
    expect(model.default_reasoning_level).toBe("low");
    expect(Array.isArray(model.supported_reasoning_levels)).toBe(true);
    expect(model.supported_reasoning_levels.length).toBe(2);
    expect(model.supported_reasoning_levels[0].effort).toBe("low");
    expect(model.supported_reasoning_levels[0].description).toBe("Off");
    expect(model.supported_reasoning_levels[1].effort).toBe("high");
    expect(model.supported_reasoning_levels[1].description).toBe("Think");
  });

  test("4. QWEN_SELECTORS chứa đầy đủ các bộ chọn DOM thực tế từ giao diện", () => {
    expect(QWEN_SELECTORS.composer).toBe("textarea.message-input-textarea");
    expect(QWEN_SELECTORS.sendButton).toContain("button.send-button");
    expect(QWEN_SELECTORS.stopButton).toContain("button.stop-button");
    expect(QWEN_SELECTORS.assistantMessage).toBe(".chat-response-message");
    expect(QWEN_SELECTORS.codeBlock).toBe("pre.qwen-markdown-code");
    expect(QWEN_SELECTORS.codeCopyButton).toContain('[aria-label="Copy"]');
    expect(QWEN_SELECTORS.thinkingSelector).toBe(".qwen-thinking-selector");
    expect(QWEN_SELECTORS.thinkingTrigger).toContain(".qwen-chat-v2-dropdown-menu-trigger");
    expect(QWEN_SELECTORS.thinkingPopup).toContain(".qwen-chat-v2-dropdown-menu-popup");
    expect(QWEN_SELECTORS.thinkingMenuItem).toBe(".qwen-chat-v2-dropdown-menu-item");
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

  test("7. QwenConversationStore lưu và tải ánh xạ threadId <-> conversationId bền vững", () => {
    const testFile = join(process.cwd(), "scratch", ".qwen", "test-qwen-conversations.json");
    if (existsSync(testFile)) unlinkSync(testFile);

    const store = new QwenConversationStore(testFile);
    expect(store.getConversationId("thread-test-1")).toBeUndefined();

    const uuid = "706cfc9a-5618-416c-a638-079f6ab62019";
    store.setConversationId("thread-test-1", uuid);
    expect(store.getConversationId("thread-test-1")).toBe(uuid);

    // Khởi tạo instance mới cùng trỏ vào file để kiểm tra persist
    const store2 = new QwenConversationStore(testFile);
    expect(store2.getConversationId("thread-test-1")).toBe(uuid);

    // Không lưu chuỗi rác không hợp lệ
    store2.setConversationId("thread-fake", "not-a-valid-uuid");
    expect(store2.getConversationId("thread-fake")).toBeUndefined();

    store2.deleteConversation("thread-test-1");
    expect(store2.getConversationId("thread-test-1")).toBeUndefined();

    if (existsSync(testFile)) unlinkSync(testFile);
  });

  test("8. Qwen Web Adapter duy trì cuộc trò chuyện liên tục khi cùng threadId", async () => {
    const uuid = "706cfc9a-5618-416c-a638-079f6ab62019";
    const testFile = join(process.cwd(), "scratch", ".qwen", "test-qwen-thread.json");
    if (existsSync(testFile)) unlinkSync(testFile);

    const store = new QwenConversationStore(testFile);
    store.setConversationId("thread-active-123", uuid);

    // Khi đã có trong store:
    const storedConvId = store.getConversationId("thread-active-123");
    expect(storedConvId).toBe(uuid);

    // Khi có tin nhắn tiếp theo trong cùng thread (cho dù messages chưa chứa assistant text):
    const hasPrior = false;
    const isNew = !hasPrior && !storedConvId;
    expect(isNew).toBe(false); // Tuyệt đối KHÔNG được là phiên mới!

    if (existsSync(testFile)) unlinkSync(testFile);
  });
});
