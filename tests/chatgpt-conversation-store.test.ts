import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ChatGptConversationStore,
  chatGptConversationKey,
  chatGptConversationUrl,
  normalizeChatGptConversationId,
  parseChatGptConversationId,
  resolveChatGptTargetUrl,
  CHATGPT_HOME_URL,
  CHATGPT_TEMPORARY_CHAT_URL,
} from "../src/adapters/chatgpt-web/conversation-store";

describe("ChatGPT Web Conversation Store & URL Mapping Tests", () => {
  const testDbPath = join(tmpdir(), `test-chatgpt-conv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);

  afterEach(() => {
    try {
      if (existsSync(testDbPath)) rmSync(testDbPath);
    } catch {}
  });

  test("1. Phân tích và chuẩn hóa Conversation ID từ URL ChatGPT", () => {
    expect(parseChatGptConversationId("https://chatgpt.com/c/670d8a55-1234-8001-a1b2-c3d4e5f6a7b8")).toBe(
      "670d8a55-1234-8001-a1b2-c3d4e5f6a7b8"
    );
    expect(parseChatGptConversationId("https://chatgpt.com/c/abc12345xyz/")).toBe("abc12345xyz");
    expect(parseChatGptConversationId("https://chatgpt.com/?temporary-chat=true")).toBeNull();
    expect(parseChatGptConversationId("https://chatgpt.com/")).toBeNull();
    expect(parseChatGptConversationId("https://other.com/c/12345678")).toBeNull();
  });

  test("2. Sinh Conversation URL chính xác", () => {
    expect(chatGptConversationUrl("670d8a55-1234-8001-a1b2-c3d4e5f6a7b8")).toBe(
      "https://chatgpt.com/c/670d8a55-1234-8001-a1b2-c3d4e5f6a7b8"
    );
    expect(() => chatGptConversationUrl("short")).toThrow("invalid");
  });

  test("3. Sinh Conversation Key băm SHA256 ổn định từ threadId", () => {
    const parsed: any = {
      modelId: "chatgpt/gpt-4o",
      options: { reasoning: "high" },
    };
    const key1 = chatGptConversationKey(parsed, "thread_123");
    const key2 = chatGptConversationKey(parsed, "thread_123");
    const keyOther = chatGptConversationKey(parsed, "thread_456");

    expect(key1).toBeDefined();
    expect(key1).toHaveLength(64);
    expect(key1).toBe(key2);
    expect(key1).not.toBe(keyOther);
  });

  test("4. Lưu trữ và tra cứu binding trong ChatGptConversationStore", () => {
    const store = new ChatGptConversationStore(testDbPath);
    const key = "a".repeat(64);
    const convId = "670d8a55-1234-8001-a1b2-c3d4e5f6a7b8";

    expect(store.get(key)).toBeNull();

    store.bind(key, convId);
    const loaded = store.get(key);
    expect(loaded?.conversationId).toBe(convId);
    expect(loaded?.lastUsedAt).toBeGreaterThan(0);

    // Kiểm tra tính bền vững khi reload từ file
    const reloadedStore = new ChatGptConversationStore(testDbPath);
    expect(reloadedStore.get(key)?.conversationId).toBe(convId);
  });

  test("5. Điều hướng URL khi useSavedChats = false (Temporary Chat Mode)", () => {
    const store = new ChatGptConversationStore(testDbPath);
    const key = "b".repeat(64);
    store.bind(key, "670d8a55-1234-8001-a1b2-c3d4e5f6a7b8");

    // Dù có conversation cũ nhưng useSavedChats = false thì vẫn dùng temporary chat
    const target = resolveChatGptTargetUrl({
      conversationKey: key,
      useSavedChats: false,
      store,
    });

    expect(target.url).toBe(CHATGPT_TEMPORARY_CHAT_URL);
    expect(target.isSavedChat).toBe(false);
  });

  test("6. Điều hướng URL khi useSavedChats = true (Saved Chat Mode)", () => {
    const store = new ChatGptConversationStore(testDbPath);
    const key = "c".repeat(64);
    const convId = "670d8a55-1234-8001-a1b2-c3d4e5f6a7b8";

    // 6a: Chưa có cuộc trò chuyện cũ -> vào trang chủ chatgpt.com/ để bắt đầu chat mới
    const targetNew = resolveChatGptTargetUrl({
      conversationKey: key,
      useSavedChats: true,
      store,
    });
    expect(targetNew.url).toBe(CHATGPT_HOME_URL);
    expect(targetNew.isSavedChat).toBe(true);
    expect(targetNew.conversationId).toBeNull();

    // 6b: Đã có cuộc trò chuyện cũ -> map đúng URL chat cũ https://chatgpt.com/c/<id>
    store.bind(key, convId);
    const targetExisting = resolveChatGptTargetUrl({
      conversationKey: key,
      useSavedChats: true,
      store,
    });
    expect(targetExisting.url).toBe(`https://chatgpt.com/c/${convId}`);
    expect(targetExisting.isSavedChat).toBe(true);
    expect(targetExisting.conversationId).toBe(convId);
  });
});
