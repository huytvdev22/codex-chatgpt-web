import { describe, expect, test } from "bun:test";
import type { CodexParsedRequest } from "../src/types";
import {
  m365ConversationKey,
  parseM365ConversationId,
} from "../src/adapters/m365-copilot/browser";

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
});
