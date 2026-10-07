import { describe, expect, test, beforeEach } from "bun:test";
import {
  extractCodexProjectCwd,
  resolveM365ConversationKey,
  clearProjectSession,
} from "../src/adapters/m365-copilot/session";
import { CodexRawPayload } from "../src/adapters/m365-copilot/normalization";
import type { CodexParsedRequest } from "../src/types";

describe("M365 Composite Conversation Key Tests", () => {
  const createMockParsed = (systemPrompt?: string[], messages?: any[]): CodexParsedRequest => ({
    modelId: "gpt-4o",
    stream: true,
    options: {} as any,
    context: {
      systemPrompt: systemPrompt || [],
      messages: messages || [],
    },
  });

  const createMockRawPayload = (extra: Record<string, any> = {}): CodexRawPayload => {
    return new CodexRawPayload({
      model: "gpt-4o",
      ...extra,
    });
  };

  describe("extractCodexProjectCwd", () => {
    test("trích xuất CWD từ thẻ <cwd> trong systemPrompt", () => {
      const parsed = createMockParsed(["<cwd>/Users/huytv/IdeaProjects/project-alpha</cwd>"]);
      const cwd = extractCodexProjectCwd(parsed);
      expect(cwd).toBe("/Users/huytv/IdeaProjects/project-alpha");
    });

    test("trích xuất CWD từ thẻ <root> trong tin nhắn context", () => {
      const parsed = createMockParsed([], [
        { role: "user", content: "Làm việc tại <root>/Users/huytv/IdeaProjects/project-beta</root>" },
      ]);
      const cwd = extractCodexProjectCwd(parsed);
      expect(cwd).toBe("/Users/huytv/IdeaProjects/project-beta");
    });

    test("trích xuất CWD từ header tùy biến x-codex-cwd", () => {
      const parsed = createMockParsed();
      const headers = new Headers({ "x-codex-cwd": "/Users/huytv/workspace/gamma" });
      const cwd = extractCodexProjectCwd(parsed, undefined, headers);
      expect(cwd).toBe("/Users/huytv/workspace/gamma");
    });

    test("trích xuất CWD từ client_metadata.workspaces trong raw payload", () => {
      const parsed = createMockParsed();
      const rawPayload = new CodexRawPayload({
        model: "gpt-4o",
        client_metadata: {
          workspaces: {
            "/Users/huytv/workspace/delta": {},
          },
        },
      });
      const cwd = extractCodexProjectCwd(parsed, rawPayload);
      expect(cwd).toBe("/Users/huytv/workspace/delta");
    });

    test("trích xuất CWD từ x-codex-turn-metadata trong client_metadata", () => {
      const parsed = createMockParsed();
      const rawPayload = new CodexRawPayload({
        model: "gpt-4o",
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({ cwd: "/Users/huytv/workspace/epsilon" }),
        },
      });
      const cwd = extractCodexProjectCwd(parsed, rawPayload);
      expect(cwd).toBe("/Users/huytv/workspace/epsilon");
    });

    test("trả về undefined nếu không tìm thấy CWD", () => {
      const parsed = createMockParsed();
      const cwd = extractCodexProjectCwd(parsed);
      expect(cwd).toBeUndefined();
    });
  });

  describe("resolveM365ConversationKey", () => {
    test("ưu tiên header tường minh x-codex-conversation-key nếu có", () => {
      const parsed = createMockParsed(["<cwd>/Users/huytv/project-a</cwd>"]);
      const rawPayload = createMockRawPayload();
      const headers = new Headers({ "x-codex-conversation-key": "explicit-key-12345" });

      const key = resolveM365ConversationKey({
        parsed,
        rawPayload,
        headers,
        hasPriorAssistantReply: false,
      });

      expect(key).toBe("explicit-key-12345");
    });

    test("gắn kết tên project và thread_id khi rawPayload có thread_id", () => {
      const parsed = createMockParsed(["<cwd>/Users/huytv/my-project</cwd>"]);
      const rawPayload = createMockRawPayload({ thread_id: "thread-abc-xyz" });

      const key = resolveM365ConversationKey({
        parsed,
        rawPayload,
        hasPriorAssistantReply: false,
      });

      expect(key).toContain("my-project_");
      expect(key).toContain("__thread-abc-xyz");
    });

    test("phân biệt hoàn toàn giữa hai project khác nhau (mở 2 tab riêng biệt)", () => {
      const parsedA = createMockParsed(["<cwd>/Users/huytv/project-a</cwd>"]);
      const rawPayloadA = createMockRawPayload();

      const parsedB = createMockParsed(["<cwd>/Users/huytv/project-b</cwd>"]);
      const rawPayloadB = createMockRawPayload();

      const keyA = resolveM365ConversationKey({
        parsed: parsedA,
        rawPayload: rawPayloadA,
        hasPriorAssistantReply: false,
      });

      const keyB = resolveM365ConversationKey({
        parsed: parsedB,
        rawPayload: rawPayloadB,
        hasPriorAssistantReply: false,
      });

      expect(keyA).toContain("project-a_");
      expect(keyB).toContain("project-b_");
      expect(keyA).not.toBe(keyB);
    });

    test("duy trì cùng conversation key qua các turn tiếp theo của cùng một project (tái sử dụng tab)", () => {
      const parsed = createMockParsed(["<cwd>/Users/huytv/single-project</cwd>"]);
      const rawPayload = createMockRawPayload();

      // Lượt 1: Bắt đầu chat (!hasPriorAssistantReply)
      const keyTurn1 = resolveM365ConversationKey({
        parsed,
        rawPayload,
        hasPriorAssistantReply: false,
      });

      // Lượt 2: Chat tiếp theo trong cùng hội thoại (hasPriorAssistantReply = true)
      const keyTurn2 = resolveM365ConversationKey({
        parsed,
        rawPayload,
        hasPriorAssistantReply: true,
      });

      expect(keyTurn1).toBe(keyTurn2);
    });

    test("sinh conversation key mới khi người dùng bấm New Chat trong cùng project", () => {
      const parsed = createMockParsed(["<cwd>/Users/huytv/single-project</cwd>"]);
      const rawPayload = createMockRawPayload();

      // Phiên chat 1
      const keySession1 = resolveM365ConversationKey({
        parsed,
        rawPayload,
        hasPriorAssistantReply: false,
      });

      // Người dùng bấm New Chat trên Codex IDE (context không còn assistant reply -> hasPriorAssistantReply = false)
      const keySession2 = resolveM365ConversationKey({
        parsed,
        rawPayload,
        hasPriorAssistantReply: false,
      });

      expect(keySession1).toContain("single-project_");
      expect(keySession2).toContain("single-project_");
      expect(keySession1).not.toBe(keySession2);
    });

    test("clearProjectSession xóa bỏ cache session hiện tại", () => {
      const parsed = createMockParsed(["<cwd>/Users/huytv/reset-project</cwd>"]);
      const rawPayload = createMockRawPayload();

      const key1 = resolveM365ConversationKey({
        parsed,
        rawPayload,
        hasPriorAssistantReply: false,
      });

      const projectTag = key1.split("__")[0];
      clearProjectSession(projectTag);

      // Sau khi clear, kể cả khi hasPriorAssistantReply = true (nếu không còn session cache)
      const key2 = resolveM365ConversationKey({
        parsed,
        rawPayload,
        hasPriorAssistantReply: false,
      });

      expect(key1).not.toBe(key2);
    });
  });
});
