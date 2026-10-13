import { describe, expect, test } from "bun:test";
import type { CodexParsedRequest } from "../src/types";
import {
  m365ConversationKey,
  parseM365ConversationId,
  M365_CHAT_URL,
  M365BrowserWorker,
} from "../src/adapters/m365-copilot/browser";
import { BrowserTurnOptionsDto } from "../src/adapters/base-web/browser";
import { M365CopilotAdapter } from "../src/adapters/m365-copilot";

const CONVERSATION_ID = "8cbbbab7-10a3-4f92-950e-f0a1b18b8f89";

describe("M365 persistent conversation identity", () => {
  test("hashes the raw Codex identity into a stable private launcher key", () => {
    const parsed = {
      modelId: "gpt-5.4",
      options: { reasoning: "high" },
    } as CodexParsedRequest;
    const first = m365ConversationKey(parsed, "raw-thread-id");
    const second = m365ConversationKey(parsed, "raw-thread-id");

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain("raw-thread-id");
  });

  test("accepts only a normal M365 conversation URL", () => {
    expect(parseM365ConversationId(
      `https://m365.cloud.microsoft/chat/conversation/${CONVERSATION_ID}`,
    )).toBe(CONVERSATION_ID);
    expect(parseM365ConversationId(
      `https://example.com/chat/conversation/${CONVERSATION_ID}`,
    )).toBeUndefined();
    expect(parseM365ConversationId(
      "https://m365.cloud.microsoft/chat/conversation/not-a-uuid",
    )).toBeUndefined();
  });

  test("M365CopilotAdapter resolves isNewConversation accurately based on assistant message history", () => {
    const adapter = new M365CopilotAdapter();

    // 1. Lượt đầu tiên: Không có tin nhắn trợ lý -> isNewConversation = true
    const newReq = {
      modelId: "gpt-5.4",
      options: {},
      context: {
        messages: [{ role: "user", content: "Hãy đọc file index.ts" }],
      },
    } as unknown as CodexParsedRequest;

    const metaNew = (adapter as any).resolveExecutionMeta(newReq, { headers: new Headers() });
    expect(metaNew.isNewConversation).toBe(true);

    // 2. Lượt tiếp theo: Đã có tin nhắn trợ lý -> isNewConversation = false (tiếp diễn)
    const continuedReq = {
      modelId: "gpt-5.4",
      options: {},
      context: {
        messages: [
          { role: "user", content: "Hãy đọc file index.ts" },
          { role: "assistant", content: "Tôi sẽ đọc file." },
          { role: "user", content: "Kết quả thực thi tool..." },
        ],
      },
    } as unknown as CodexParsedRequest;

    const metaContinued = (adapter as any).resolveExecutionMeta(continuedReq, { headers: new Headers() });
    expect(metaContinued.isNewConversation).toBe(false);
  });

  test("M365BrowserWorker preserves existing conversation without reloading when lease is retained", async () => {
    class TestWorker extends M365BrowserWorker {
      public testPrepare(page: any, options: any, attachment: any) {
        return this.preparePageNavigation(page, options, attachment);
      }
    }

    const worker = new TestWorker();
    let navigatedUrl = "";

    const mockPage = {
      url: () => `https://m365.cloud.microsoft/chat/conversation/${CONVERSATION_ID}`,
      goto: async (url: string) => {
        navigatedUrl = url;
      },
      evaluate: async () => {},
    };

    const options = BrowserTurnOptionsDto.of({
      conversationKey: "test-conv-key",
      isNewConversation: false,
    });

    const attachment = {
      page: mockPage as any,
      lease: {
        surfaceId: "surf_1",
        conversationId: CONVERSATION_ID,
        reused: true,
      },
    };

    // Khi lease đã có conversationId trùng với URL: Tuyệt đối KHÔNG điều hướng đi đâu
    await worker.testPrepare(mockPage, options, attachment);
    expect(navigatedUrl).toBe("");

    // Khi là cuộc hội thoại mới (isNewConversation = true): Phải điều hướng về M365_CHAT_URL
    const newOptions = BrowserTurnOptionsDto.of({
      conversationKey: "test-conv-key-2",
      isNewConversation: true,
    });
    const newAttachment = {
      page: mockPage as any,
      lease: {
        surfaceId: "surf_2",
      },
    };

    await worker.testPrepare(mockPage, newOptions, newAttachment);
    expect(navigatedUrl).toBe(M365_CHAT_URL);
  });
});

