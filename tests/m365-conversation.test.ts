import { describe, expect, test } from "bun:test";
import type { CodexParsedRequest } from "../src/types";
import {
  m365ConversationKey,
  parseM365ConversationId,
} from "../src/adapters/m365-copilot";

const CONVERSATION_ID = "8cbbbab7-10a3-4f92-950e-f0a1b18b8f89";

describe("M365 persistent conversation identity", () => {
  test("hashes the raw Codex identity into a stable private launcher key across same-provider model switches", () => {
    const parsedA = {
      modelId: "m365-copilot/gpt-5.6",
      options: { reasoning: "high" },
    } as CodexParsedRequest;
    const parsedB = {
      modelId: "m365-copilot",
      options: { reasoning: "low" },
    } as CodexParsedRequest;
    const first = m365ConversationKey(parsedA, "raw-thread-id");
    const second = m365ConversationKey(parsedB, "raw-thread-id");
    const other = m365ConversationKey(parsedA, "other-thread-id");

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain("raw-thread-id");
  });

  test("accepts only a normal M365 conversation URL", () => {
    expect(parseM365ConversationId(
      `https://m365.cloud.microsoft/chat/conversation/${CONVERSATION_ID}`,
    )).toBe(CONVERSATION_ID);
    expect(parseM365ConversationId(
      `https://copilot.cloud.microsoft/chat/conversation/${CONVERSATION_ID}`,
    )).toBe(CONVERSATION_ID);
    expect(parseM365ConversationId(
      `https://example.com/chat/conversation/${CONVERSATION_ID}`,
    )).toBeUndefined();
    expect(parseM365ConversationId(
      "https://m365.cloud.microsoft/chat/conversation/not-a-uuid",
    )).toBeUndefined();
  });
});
