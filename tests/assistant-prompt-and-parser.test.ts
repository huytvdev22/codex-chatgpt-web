import { describe, expect, test } from "bun:test";
import type {
  NormalizedCodexRequest,
  NormalizedTool,
} from "../src/adapters/web/normalization/canonical-types";
import { AssistantPromptCompiler } from "../src/assistant/assistant-prompt-compiler";
import { AssistantResponseParser } from "../src/assistant/assistant-response-parser";

function createSampleNormalizedRequest(): NormalizedCodexRequest {
  const tools: NormalizedTool[] = [
    {
      kind: "function",
      identity: { name: "exec_command", qualifiedName: "exec_command" },
      description: "Run command",
      rawParameters: {
        type: "object",
        properties: {
          cmd: { type: "string", description: "Command" },
          workdir: { type: "string", description: "Working dir" },
          sandbox_permissions: { type: "string", enum: ["use_default", "require_escalated"] },
          justification: { type: "string", description: "Reason" },
          tty: { type: "boolean" },
          login: { type: "boolean" },
          yield_time_ms: { type: "number" },
          prefix_rule: { type: "array" },
          max_output_tokens: { type: "number" },
        },
        required: ["cmd"],
      },
    },
    {
      kind: "function",
      identity: { name: "write_stdin", qualifiedName: "write_stdin" },
      description: "Write to running exec session",
      rawParameters: {
        type: "object",
        properties: { session_id: { type: "number" } },
        required: ["session_id"],
      },
    },
    {
      kind: "custom",
      identity: { name: "apply_patch", qualifiedName: "apply_patch" },
      description: "Edit file",
    },
    {
      kind: "function",
      identity: { name: "tool_search", qualifiedName: "tool_search" },
      description: "Search deferred tools",
      isToolSearch: true,
      rawParameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    {
      kind: "function",
      identity: { name: "get_goal", qualifiedName: "get_goal" },
      description: "Get goal",
      rawParameters: { type: "object", properties: {} },
    },
    {
      kind: "function",
      identity: { name: "create_goal", qualifiedName: "create_goal" },
      description: "Create goal",
      rawParameters: { type: "object", properties: {} },
    },
    {
      kind: "function",
      identity: { name: "update_goal", qualifiedName: "update_goal" },
      description: "Update goal",
      rawParameters: { type: "object", properties: {} },
    },
    {
      kind: "function",
      identity: {
        namespace: "multi_agent_v1",
        name: "spawn",
        qualifiedName: "multi_agent_v1.spawn",
      },
      description: "Spawn subagent",
      rawParameters: { type: "object", properties: {} },
    },
  ];

  return {
    model: "gemini/gemini-2.5-flash",
    stream: true,
    systemInstructions: [
      "Bạn là Trợ lý AI Cá nhân cục bộ chạy trên máy macOS của người dùng, giao tiếp qua Telegram.",
    ],
    developerInstructions: ["Workspace chính: /Users/test/CodexAssistant"],
    priorHistory: [],
    latestUserInstruction: "Hôm nay thời tiết Hà Nội thế nào?",
    trailingToolResults: [],
    tools,
    activeCodingTools: tools,
    deferredNamespaces: ["mcp__assistant_telegram", "multi_agent_v1"],
    executionPolicy: {
      parallelToolCalls: true,
    },
    collaborationMode: "default",
    rawSnapshot: { model: "gemini/gemini-2.5-flash" },
    availableSkills: [
      {
        name: "gemini-image",
        description: "Tạo và chỉnh sửa ảnh cục bộ qua Gemini",
        absolutePath: "/Users/test/CodexAssistant/skills/gemini-image/SKILL.md",
        shortPath: "~/CodexAssistant/skills/gemini-image/SKILL.md",
        source: "user",
      },
      {
        name: "imagegen",
        description: "System imagegen",
        absolutePath: "/Users/test/.codex/skills/.system/imagegen/SKILL.md",
        shortPath: "~/.codex/skills/.system/imagegen/SKILL.md",
        source: "system",
      },
      {
        name: "openai-docs",
        description: "System docs",
        absolutePath: "/Users/test/.codex/skills/.system/openai-docs/SKILL.md",
        shortPath: "~/.codex/skills/.system/openai-docs/SKILL.md",
        source: "system",
      },
    ],
  };
}

describe("AssistantPromptCompiler & AssistantToolCatalogRenderer", () => {
  test("Turn 1 gọn nhẹ, loại bỏ boilerplate IDE, .system skills, *_goal và nén exec_command", () => {
    const compiler = new AssistantPromptCompiler();
    const compiled = compiler.compile({
      normalized: createSampleNormalizedRequest(),
      assistantName: "Gemini",
      isNewConversation: true,
    });

    expect(compiled.scenario).toBe("FIRST_HANDSHAKE");
    const prompt = compiled.finalPrompt;
    expect(prompt).not.toContain(".codex-copilot/MEMORY.md");
    expect(prompt).not.toContain("PowerShell");
    expect(prompt).not.toContain("get_goal");
    expect(prompt).not.toContain("create_goal");
    expect(prompt).not.toContain("update_goal");
    expect(prompt).not.toContain("multi_agent_v1");
    expect(prompt).not.toContain("yield_time_ms");
    expect(prompt).not.toContain("prefix_rule");
    expect(prompt).not.toContain("openai-docs");
    expect(prompt).not.toContain("skill-installer");

    expect(prompt).toContain("exec_command(");
    expect(prompt).toContain("cmd:string");
    expect(prompt).toContain("workdir?:string");
    expect(prompt).toContain("sandbox_permissions?:");
    expect(prompt).toContain("justification?:string");
    expect(prompt).toContain("write_stdin");
    expect(prompt).toContain("mcp__assistant_telegram");
    expect(prompt).toContain("gemini-image");
    expect(prompt.length).toBeLessThan(3500);
  });
});

describe("AssistantResponseParser", () => {
  const parser = new AssistantResponseParser();

  test("chấp nhận thẳng câu trả lời Natural-First không cần 4-backtick hay <webResponse>", () => {
    const res = parser.parse("Hà Nội hôm nay nắng nhẹ, khoảng 26°C.");
    expect(res.kind).toBe("final_answer");
    if (res.kind === "final_answer") {
      expect(res.content).toBe("Hà Nội hôm nay nắng nhẹ, khoảng 26°C.");
    }
  });

  test("gỡ wrapper 4-backtick + <webResponse> nếu AI tự bọc", () => {
    const res = parser.parse("````markdown\n<webResponse>\nĐã xử lý xong.\n</webResponse>\n````");
    expect(res.kind).toBe("final_answer");
    if (res.kind === "final_answer") {
      expect(res.content).toBe("Đã xử lý xong.");
    }
  });

  test("parse <tool_call> kèm câu dẫn commentaryText", () => {
    const res = parser.parse(
      'Để mình kiểm tra thư mục nhé.\n<tool_call>\n{"name":"exec_command","arguments":{"cmd":"ls -la"}}\n</tool_call>',
    );
    expect(res.kind).toBe("tool_calls");
    if (res.kind === "tool_calls") {
      expect(res.commentaryText).toBe("Để mình kiểm tra thư mục nhé.");
      expect(res.calls).toHaveLength(1);
      expect(res.calls[0]?.name).toBe("exec_command");
    }
  });

  test("không nhận nhầm <tool_call> bên trong code fence", () => {
    const sample = 'Hướng dẫn:\n```xml\n<tool_call>\n{"name":"demo"}\n</tool_call>\n```';
    const res = parser.parse(sample);
    expect(res.kind).toBe("final_answer");
  });

  test("báo lỗi INCOMPLETE_TOOL_CALL khi thẻ <tool_call> bị cắt cụt", () => {
    const res = parser.parse('<tool_call>\n{"name":"exec_command","arguments":{"cmd":"ls"');
    expect(res.kind).toBe("protocol_error");
    if (res.kind === "protocol_error") {
      expect(res.code).toBe("INCOMPLETE_TOOL_CALL");
    }
  });
});
