import { describe, expect, test } from "bun:test";
import {
  extractCodexProjectCwd,
  extractProjectLabel,
  resolveM365ConversationKey,
  clearProjectSession,
  checkHasPriorAssistantReply,
} from "../src/adapters/m365-copilot/session";
import { CodexRawPayload } from "../src/adapters/m365-copilot/normalization";
import type { CodexParsedRequest } from "../src/types";

describe("M365 Composite Conversation Key Tests", () => {
  const SHA256_REGEX = /^[a-f0-9]{64}$/;

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

  describe("extractProjectLabel", () => {
    test("trích xuất tên thư mục dự án làm label hiển thị trên tab", () => {
      const parsed = createMockParsed(["<cwd>/Users/huytv/IdeaProjects/project-alpha</cwd>"]);
      const label = extractProjectLabel(parsed);
      expect(label).toBe("project-alpha");
    });

    test("trích xuất tên thư mục khi CWD là đường dẫn Windows", () => {
      const parsed = createMockParsed(["<cwd>D:\\Workspace\\my-app</cwd>"]);
      const label = extractProjectLabel(parsed);
      expect(label).toBe("my-app");
    });

    test("trả về undefined khi không tìm thấy CWD", () => {
      const parsed = createMockParsed();
      const label = extractProjectLabel(parsed);
      expect(label).toBeUndefined();
    });
  });

  describe("resolveM365ConversationKey", () => {
    test("chấp nhận header x-codex-conversation-key dạng 64-hex hợp lệ", () => {
      const parsed = createMockParsed(["<cwd>/Users/huytv/project-a</cwd>"]);
      const rawPayload = createMockRawPayload();
      const valid64Hex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      const headers = new Headers({ "x-codex-conversation-key": valid64Hex });

      const key = resolveM365ConversationKey({
        parsed,
        rawPayload,
        headers,
        hasPriorAssistantReply: false,
      });

      expect(key).toBe(valid64Hex);
      expect(SHA256_REGEX.test(key)).toBe(true);
    });

    test("chuẩn hóa header x-codex-conversation-key không phải 64-hex thành SHA-256 hợp lệ", () => {
      const parsed = createMockParsed(["<cwd>/Users/huytv/project-a</cwd>"]);
      const rawPayload = createMockRawPayload();
      const headers = new Headers({ "x-codex-conversation-key": "explicit-key-12345" });

      const key = resolveM365ConversationKey({
        parsed,
        rawPayload,
        headers,
        hasPriorAssistantReply: false,
      });

      expect(SHA256_REGEX.test(key)).toBe(true);
    });

    test("luôn sinh chuỗi sha256 64-hex khi rawPayload có thread_id", () => {
      const parsed = createMockParsed(["<cwd>/Users/huytv/my-project</cwd>"]);
      const rawPayload = createMockRawPayload({ thread_id: "thread-abc-xyz" });

      const key = resolveM365ConversationKey({
        parsed,
        rawPayload,
        hasPriorAssistantReply: false,
      });

      expect(SHA256_REGEX.test(key)).toBe(true);
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

      expect(SHA256_REGEX.test(keyA)).toBe(true);
      expect(SHA256_REGEX.test(keyB)).toBe(true);
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

      expect(SHA256_REGEX.test(keyTurn1)).toBe(true);
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

      expect(SHA256_REGEX.test(keySession1)).toBe(true);
      expect(SHA256_REGEX.test(keySession2)).toBe(true);
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

      clearProjectSession();

      const key2 = resolveM365ConversationKey({
        parsed,
        rawPayload,
        hasPriorAssistantReply: false,
      });

      expect(SHA256_REGEX.test(key1)).toBe(true);
      expect(SHA256_REGEX.test(key2)).toBe(true);
      expect(key1).not.toBe(key2);
    });
  });

  describe("checkHasPriorAssistantReply", () => {
    test("trả về false khi context chỉ có user message và không có assistant", () => {
      const parsed = createMockParsed([], [
        { role: "user", content: "Chào bạn" },
      ]);
      const rawPayload = createMockRawPayload();
      expect(checkHasPriorAssistantReply(parsed, rawPayload)).toBe(false);
    });

    test("trả về true khi context.messages chứa message role assistant", () => {
      const parsed = createMockParsed([], [
        { role: "user", content: "Chào bạn" },
        { role: "assistant", content: "Xin chào!" },
      ]);
      const rawPayload = createMockRawPayload();
      expect(checkHasPriorAssistantReply(parsed, rawPayload)).toBe(true);
    });

    test("trả về true khi context.messages chứa role toolResult", () => {
      const parsed = createMockParsed([], [
        { role: "user", content: "Đọc file" },
        { role: "toolResult", content: "File content", toolCallId: "call_1" },
      ]);
      const rawPayload = createMockRawPayload();
      expect(checkHasPriorAssistantReply(parsed, rawPayload)).toBe(true);
    });

    test("trả về true khi rawPayload.input wire format chứa message role assistant", () => {
      const parsed = createMockParsed();
      const rawPayload = new CodexRawPayload({
        model: "gpt-4o",
        input: [
          { type: "message", role: "developer", content: "System rule" },
          { type: "message", role: "user", content: "Yêu cầu 1" },
          { type: "message", role: "assistant", content: "Tôi đồng ý 5 hướng" },
          { type: "message", role: "user", content: "Triển khai từ hướng 1 đến 5" },
        ],
      });
      expect(checkHasPriorAssistantReply(parsed, rawPayload)).toBe(true);
    });

    test("trả về true khi rawPayload.input chứa function_call hoặc function_call_output", () => {
      const parsed = createMockParsed();
      const rawPayload = new CodexRawPayload({
        model: "gpt-4o",
        input: [
          { type: "message", role: "user", content: "Chạy lệnh" },
          { type: "function_call", call_id: "call_abc", name: "exec_command", arguments: {} },
          { type: "function_call_output", call_id: "call_abc", output: "success" },
        ],
      });
      expect(checkHasPriorAssistantReply(parsed, rawPayload)).toBe(true);
    });
  });

  describe("CodexRawPayload.getThreadId fallback", () => {
    test("trích xuất threadId từ client_metadata.session_id khi không có thread_id", () => {
      const rawPayload = new CodexRawPayload({
        model: "gpt-4o",
        client_metadata: {
          session_id: "sess_xyz_123",
        },
      });
      expect(rawPayload.getThreadId()).toBe("sess_xyz_123");
    });

    test("trích xuất threadId từ prompt_cache_key khi client_metadata không có id", () => {
      const rawPayload = new CodexRawPayload({
        model: "gpt-4o",
        prompt_cache_key: "cache_key_999",
      });
      expect(rawPayload.getThreadId()).toBe("cache_key_999");
    });
  });
});
