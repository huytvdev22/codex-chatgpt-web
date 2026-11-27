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

  test("nén priorHistory dài khi resume phiên cũ: ưu tiên lượt gần nhất và cắt ngắn tool output cũ", () => {
    const compiler = new AssistantPromptCompiler();
    const base = createSampleNormalizedRequest();
    const compiled = compiler.compile({
      normalized: {
        ...base,
        priorHistory: [
          { role: "user", content: "Lệnh rất cũ 000" },
          { role: "tool", callId: "call_old_1", content: "X".repeat(20_000) },
          { role: "assistant", content: "Xong phần cũ." },
          { role: "tool", callId: "call_recent_2", content: "Y".repeat(3_000) },
          { role: "user", content: "Câu hỏi gần đây" },
          { role: "assistant", content: "Câu trả lời gần đây nhất" },
        ],
        latestUserInstruction: "hi",
      },
      assistantName: "Gemini",
      isNewConversation: true,
    });

    expect(compiled.finalPrompt).toContain("Câu trả lời gần đây nhất");
    expect(compiled.finalPrompt).toContain("Y".repeat(350));
    expect(compiled.finalPrompt).not.toContain("Y".repeat(500));
    expect(compiled.finalPrompt.length).toBeLessThan(24_000);
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

  test("parse chuẩn 1 hoặc nhiều <tool_call> bọc trong 4-backtick + <webResponse>", () => {
    const raw = [
      "````markdown",
      "<webResponse>",
      '<tool_call>{"name":"exec_command","arguments":{"cmd":"ls -la"}}</tool_call>',
      '<tool_call>{"name":"tool_search","arguments":{"query":"telegram_send_photo"}}</tool_call>',
      "</webResponse>",
      "````",
    ].join("\n");

    const res = parser.parse(raw);
    expect(res.kind).toBe("tool_calls");
    if (res.kind === "tool_calls") {
      expect(res.calls).toHaveLength(2);
      expect(res.calls[0]?.name).toBe("exec_command");
      expect(res.calls[1]?.name).toBe("tool_search");
      expect(res.commentaryText).toBeUndefined();
    }
  });

  test("tách commentaryText khi AI viết câu dẫn trước khối 4-backtick + <webResponse>", () => {
    const raw = [
      "Để mình kiểm tra thư mục nhé.",
      "````markdown",
      "<webResponse>",
      '<tool_call>{"name":"exec_command","arguments":{"cmd":"ls -la"}}</tool_call>',
      "</webResponse>",
      "````",
    ].join("\n");

    const res = parser.parse(raw);
    expect(res.kind).toBe("tool_calls");
    if (res.kind === "tool_calls") {
      expect(res.commentaryText).toBe("Để mình kiểm tra thư mục nhé.");
      expect(res.calls).toHaveLength(1);
      expect(res.calls[0]?.name).toBe("exec_command");
    }
  });

  test("báo lỗi MISSING_RESPONSE_ENVELOPE khi xuất <tool_call> hoặc *** Begin Patch trần không bọc <webResponse>", () => {
    const bareTool = parser.parse('<tool_call>{"name":"exec_command","arguments":{"cmd":"ls"}}</tool_call>');
    expect(bareTool.kind).toBe("protocol_error");
    if (bareTool.kind === "protocol_error") {
      expect(bareTool.code).toBe("MISSING_RESPONSE_ENVELOPE");
    }

    const fenceNoEnvelope = parser.parse(
      '````markdown\n<tool_call>{"name":"exec_command","arguments":{"cmd":"ls"}}</tool_call>\n````',
    );
    expect(fenceNoEnvelope.kind).toBe("protocol_error");
    if (fenceNoEnvelope.kind === "protocol_error") {
      expect(fenceNoEnvelope.code).toBe("MISSING_RESPONSE_ENVELOPE");
    }

    const barePatch = parser.parse("*** Begin Patch\n*** Update File: a.ts\n*** End Patch");
    expect(barePatch.kind).toBe("protocol_error");
    if (barePatch.kind === "protocol_error") {
      expect(barePatch.code).toBe("MISSING_RESPONSE_ENVELOPE");
    }
  });

  test("báo lỗi strict MIXED_TOOL_AND_TEXT_CONTENT / FORBIDDEN_THOUGHT_BLOCK / INCOMPLETE_TOOL_CALL khi sai chuẩn trong <webResponse>", () => {
    const mixed = parser.parse(
      [
        "````markdown",
        "<webResponse>",
        '<tool_call>{"name":"exec_command","arguments":{"cmd":"pwd"}}</tool_call>',
        "Đợi một chút nhé:",
        '<tool_call>{"name":"exec_command","arguments":{"cmd":"ls"}}</tool_call>',
        "</webResponse>",
        "````",
      ].join("\n"),
    );
    expect(mixed.kind).toBe("protocol_error");
    if (mixed.kind === "protocol_error") {
      expect(mixed.code).toBe("MIXED_TOOL_AND_TEXT_CONTENT");
    }

    const thought = parser.parse(
      [
        "````markdown",
        "<webResponse>",
        "<thought>suy nghĩ nội bộ</thought>",
        '<tool_call>{"name":"exec_command","arguments":{"cmd":"ls"}}</tool_call>',
        "</webResponse>",
        "````",
      ].join("\n"),
    );
    expect(thought.kind).toBe("protocol_error");
    if (thought.kind === "protocol_error") {
      expect(thought.code).toBe("FORBIDDEN_THOUGHT_BLOCK");
    }

    const unclosed = parser.parse(
      '````markdown\n<webResponse>\n<tool_call>\n{"name":"exec_command","arguments":{"cmd":"ls"\n</webResponse>\n````',
    );
    expect(unclosed.kind).toBe("protocol_error");
    if (unclosed.kind === "protocol_error") {
      expect(unclosed.code).toBe("INCOMPLETE_TOOL_CALL");
    }
  });

  test("không nhận nhầm <tool_call> bên trong code fence hướng dẫn thường", () => {
    const sample = 'Hướng dẫn:\n```xml\n<tool_call>\n{"name":"demo"}\n</tool_call>\n```';
    const res = parser.parse(sample);
    expect(res.kind).toBe("final_answer");
  });

  test("parse đúng <webResponse> + <tool\\_call> khi bị Turndown DOM fallback escape dấu gạch dưới", () => {
    const res = parser.parse(
      '<webResponse>\n<tool\\_call>{"name":"exec\\_command","arguments":{"cmd":"ls -la","sandbox\\_permissions":"use\\_default"}}</tool\\_call>\n</webResponse>',
    );
    expect(res.kind).toBe("tool_calls");
    if (res.kind === "tool_calls") {
      expect(res.calls).toHaveLength(1);
      expect(res.calls[0]?.name).toBe("exec_command");
      expect(res.calls[0]?.arguments).toEqual({
        cmd: "ls -la",
        sandbox_permissions: "use_default",
      });
    }
  });

  test("parse đúng apply_patch bọc trong 4-backtick + <webResponse> (kể cả code block 3-backtick bên trong hoặc câu dẫn phía trước)", () => {
    const rawPatchWithFence = [
      "Để mình tạo tệp ghi chú cho bạn.",
      "````markdown",
      "<webResponse>",
      '<custom_tool_call name="apply_patch">',
      "*** Begin Patch",
      "*** Add File: notes/demo.md",
      "+# Tiêu đề",
      "+```ts",
      "+  const x = 1;",
      "+```",
      "*** End Patch",
      "</custom_tool_call>",
      "</webResponse>",
      "````",
    ].join("\n");

    const res = parser.parse(rawPatchWithFence);
    expect(res.kind).toBe("tool_calls");
    if (res.kind === "tool_calls") {
      expect(res.commentaryText).toBe("Để mình tạo tệp ghi chú cho bạn.");
      expect(res.calls).toHaveLength(1);
      expect(res.calls[0]?.name).toBe("apply_patch");
      expect(String(res.calls[0]?.arguments?.input || "")).toContain("+  const x = 1;");
    }
  });
});
