import { describe, expect, test, afterEach } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  QwenConversationStore,
  qwenConversationKey,
  qwenConversationUrl,
  parseQwenConversationId,
  resolveQwenTargetUrl,
  QWEN_HOME_URL,
} from "../src/adapters/qwen-web/conversation-store";

describe("Qwen Web Conversation Store & URL Mapping Tests", () => {
  const testDbPath = join(tmpdir(), `test-qwen-conv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);

  afterEach(() => {
    try {
      if (existsSync(testDbPath)) rmSync(testDbPath);
    } catch {}
  });

  test("1. Phân tích và chuẩn hóa Conversation ID từ URL Qwen", () => {
    expect(parseQwenConversationId("https://chat.qwen.ai/c/58703ee0-04f5-4621-b17a-b20201be1ead")).toBe(
      "58703ee0-04f5-4621-b17a-b20201be1ead"
    );
    expect(parseQwenConversationId("https://chat.qwen.ai/c/0b822b50-f7dd-4d43-8c4a-1104340f745c/")).toBe(
      "0b822b50-f7dd-4d43-8c4a-1104340f745c"
    );
    expect(parseQwenConversationId("https://chat.qwen.ai/")).toBeNull();
    expect(parseQwenConversationId("https://other.com/c/58703ee0-04f5-4621-b17a-b20201be1ead")).toBeNull();
  });

  test("2. Sinh Conversation URL chính xác", () => {
    expect(qwenConversationUrl("58703ee0-04f5-4621-b17a-b20201be1ead")).toBe(
      "https://chat.qwen.ai/c/58703ee0-04f5-4621-b17a-b20201be1ead"
    );
    expect(() => qwenConversationUrl("short")).toThrow("invalid");
  });

  test("3. Sinh Conversation Key băm SHA256 ổn định từ threadId", () => {
    const parsed: any = {
      modelId: "qwen-web",
      options: { reasoning: "think" },
    };
    const key1 = qwenConversationKey(parsed, "thread_qwen_123");
    const key2 = qwenConversationKey(parsed, "thread_qwen_123");
    const keyOther = qwenConversationKey(parsed, "thread_qwen_456");

    expect(key1).toBeDefined();
    expect(key1).toHaveLength(64);
    expect(key1).toBe(key2);
    expect(key1).not.toBe(keyOther);
  });

  test("4. Lưu trữ và tra cứu binding trong QwenConversationStore", () => {
    const store = new QwenConversationStore(testDbPath);
    const threadId = "thread_qwen_abc";
    const convId = "58703ee0-04f5-4621-b17a-b20201be1ead";

    store.setConversationId(threadId, convId);
    expect(store.getConversationId(threadId)).toBe(convId);

    // Kiểm tra tính bền vững qua instance mới
    const store2 = new QwenConversationStore(testDbPath);
    expect(store2.getConversationId(threadId)).toBe(convId);
  });

  test("5. resolveQwenTargetUrl trả về URL trang chủ hoặc URL cuộc trò chuyện", () => {
    expect(resolveQwenTargetUrl()).toBe(QWEN_HOME_URL);
    expect(resolveQwenTargetUrl("58703ee0-04f5-4621-b17a-b20201be1ead")).toBe(
      "https://chat.qwen.ai/c/58703ee0-04f5-4621-b17a-b20201be1ead"
    );
    expect(resolveQwenTargetUrl("invalid-id")).toBe(QWEN_HOME_URL);
  });
});
