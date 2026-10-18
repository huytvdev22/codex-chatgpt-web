import { describe, expect, test } from "bun:test";
import {
  isChatGptWebModelSlug,
  availableChatGptWebModelRoutes,
  CHATGPT_WEB_DEFAULT_ROUTE,
} from "../src/chatgpt-web-models";
import {
  ChatGptWebAdapter,
  createChatGptWebAdapter,
  CHATGPT_SELECTORS,
  extractConversationIdFromUrl,
  ChatGptConversationStore,
} from "../src/adapters/chatgpt-web";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

describe("ChatGPT Web Adapter V2 Architecture Tests", () => {
  test("1. isChatGptWebModelSlug nhận diện chính xác các model của ChatGPT Web", () => {
    expect(isChatGptWebModelSlug("chatgpt-web")).toBe(true);
    expect(isChatGptWebModelSlug("chatgpt-web/pro")).toBe(true);
    expect(isChatGptWebModelSlug("chatgpt-web/gpt-5.6-sol")).toBe(true);

    // Không nhận nhầm các adapter khác
    expect(isChatGptWebModelSlug("m365-copilot")).toBe(false);
    expect(isChatGptWebModelSlug("gemini-web")).toBe(false);
    expect(isChatGptWebModelSlug("gpt-5")).toBe(false);
  });

  test("2. availableChatGptWebModelRoutes trả về route mặc định với 2 nấc suy nghĩ (Off / Think)", () => {
    const routes = availableChatGptWebModelRoutes({ solAvailable: true, proAvailable: true });
    expect(routes.length).toBeGreaterThanOrEqual(1);

    const defaultRoute = routes.find(r => r.slug === "chatgpt-web");
    expect(defaultRoute).toBeDefined();
    expect(defaultRoute?.displayName).toBe("ChatGPT (Web)");
    expect(defaultRoute?.supportedCodexEfforts).toEqual(["low", "high"]);
  });

  test("3. Model Catalog tạo model chatgpt-web với thanh trượt Off / Think", () => {
    const dummyCatalog = {
      models: [
        {
          slug: "gpt-5.6-sol",
          display_name: "5.6 Sol",
          description: "native",
          visibility: "list",
          tool_mode: "responses",
          supported_reasoning_levels: [
            { effort: "low", description: "Low" },
            { effort: "high", description: "High" },
          ],
        },
      ],
    };
    const augmented = augmentNativeModelCatalog(dummyCatalog, { mode: "full" } as any);
    const models = augmented.models as any[];
    const chatGptModel = models.find(m => m.slug === "chatgpt-web");
    expect(chatGptModel).toBeDefined();
    expect(chatGptModel?.display_name).toBe("ChatGPT (Web)");

    const reasoningLevels = chatGptModel?.supported_reasoning_levels;
    expect(Array.isArray(reasoningLevels)).toBe(true);
    expect(reasoningLevels?.length).toBe(2);

    const lowLevel = reasoningLevels?.find((l: any) => l.effort === "low");
    const highLevel = reasoningLevels?.find((l: any) => l.effort === "high");

    expect(lowLevel?.description).toBe("Off");
    expect(highLevel?.description).toBe("Think");
  });

  test("4. CHATGPT_SELECTORS chứa đầy đủ các bộ chọn DOM thực tế", () => {
    expect(CHATGPT_SELECTORS.composer).toContain("div.ProseMirror");
    expect(CHATGPT_SELECTORS.sendButton).toContain('button[type="submit"][aria-label="Send"]');
    expect(CHATGPT_SELECTORS.stopButton).toContain('button[type="button"][aria-label="Stop"]');
    expect(CHATGPT_SELECTORS.startVoiceButton).toContain('button[type="button"][aria-label="Start Voice"]');
    expect(CHATGPT_SELECTORS.thinkButton).toContain('button[aria-label*="Think" i]');
    expect(CHATGPT_SELECTORS.copyCodeButton).toContain('button[aria-label="Copy code"]');
  });

  test("5. extractConversationIdFromUrl trích xuất đúng ID cuộc trò chuyện từ URL ChatGPT", () => {
    const url1 = "https://chatgpt.com/c/6ad38605-689c-83ec-9d93-2f0228aa2a0a";
    expect(extractConversationIdFromUrl(url1)).toBe("6ad38605-689c-83ec-9d93-2f0228aa2a0a");

    const url2 = "https://chatgpt.com/";
    expect(extractConversationIdFromUrl(url2)).toBeUndefined();
  });

  test("6. ChatGptConversationStore lưu và tải ánh xạ threadId <-> conversationId", () => {
    const testFile = join(process.cwd(), "scratch", ".chatgpt", "test-conversations.json");
    if (existsSync(testFile)) unlinkSync(testFile);

    const store = new ChatGptConversationStore(testFile);
    expect(store.getConversationId("thread-123")).toBeUndefined();

    store.setConversationId("thread-123", "conv-abc-456");
    expect(store.getConversationId("thread-123")).toBe("conv-abc-456");

    // Khởi tạo store mới trỏ vào cùng file để kiểm tra persistence
    const store2 = new ChatGptConversationStore(testFile);
    expect(store2.getConversationId("thread-123")).toBe("conv-abc-456");

    // Từ chối lưu và bỏ qua chuỗi rác local-chatgpt
    store2.setConversationId("thread-fake", "local-chatgpt");
    expect(store2.getConversationId("thread-fake")).toBeUndefined();

    store2.deleteConversation("thread-123");
    expect(store2.getConversationId("thread-123")).toBeUndefined();

    if (existsSync(testFile)) unlinkSync(testFile);
  });

  test("7. ChatGptWebAdapter khởi tạo chuẩn ProviderAdapter interface", () => {
    const adapter = createChatGptWebAdapter();
    expect(adapter).toBeInstanceOf(ChatGptWebAdapter);
    expect(adapter.name).toBe("chatgpt-web");
  });

  test("8. Validation và trích xuất đúng định dạng conversationId của ChatGPT Web", () => {
    // Trích xuất UUID thực tế từ URL ChatGPT (nhóm 3 bắt đầu bằng số 8)
    const realUrl = "https://chatgpt.com/c/6ad39c41-63b8-83ec-bb3c-16c223c4d914";
    const convId = extractConversationIdFromUrl(realUrl);
    expect(convId).toBe("6ad39c41-63b8-83ec-bb3c-16c223c4d914");

    // Loại trừ URL rác hoặc local-chatgpt
    expect(extractConversationIdFromUrl("https://chatgpt.com/c/local-chatgpt")).toBeUndefined();
    expect(extractConversationIdFromUrl("https://chatgpt.com/")).toBeUndefined();
  });

  test("9. Phiên hội thoại mới (isNewConversation=true) luôn biên dịch đầy đủ Bootstrap Protocol Chào ChatGPT", () => {
    const adapter = createChatGptWebAdapter();
    const parsedRequest = {
      model: "chatgpt-web",
      context: {
        messages: [{ role: "user", content: "xin chào" }],
      },
      options: {},
    };

    const compiled = (adapter as any).compilePrompt(parsedRequest, true);
    expect(compiled).toContain("Chào ChatGPT, mình đang làm việc trên một dự án phần mềm");
    expect(compiled).toContain("<webResponse>");
    expect(compiled).toContain("apply_patch");
    expect(compiled).toContain("xin chào");
  });
});

