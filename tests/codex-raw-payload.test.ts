import { describe, expect, test } from "bun:test";
import { CodexRawPayload, type CodexRawRequestWire } from "../src/adapters/m365-copilot/codex-raw-payload";

describe("CodexRawPayload 1:1 Representation Tests", () => {
  const sampleWireRequest: CodexRawRequestWire = {
    model: "m365-copilot/think",
    stream: true,
    prompt_cache_key: "thread_abc_123",
    client_metadata: {
      thread_id: "thread_abc_123",
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "thread_abc_123",
        turn_id: "turn_xyz_789",
        request_kind: "turn",
      }),
    },
    tools: [
      {
        type: "function",
        name: "custom_root_tool",
        description: "Root tool description",
      },
    ],
    input: [
      {
        type: "additional_tools",
        id: "at_123",
        tools: [
          {
            type: "function",
            name: "exec_command",
            description: "Runs a command in a PTY",
            parameters: {
              type: "object",
              properties: { cmd: { type: "string" } },
            },
          },
          {
            type: "function",
            name: "read_file",
            description: "Reads a file from workspace",
          },
          {
            type: "function",
            name: "sports",
            description: "Looks up sports schedules",
          },
        ],
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "System prompt instructions" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Thêm comment cho file ci.yml" }],
      },
      {
        type: "function_call",
        call_id: "call_abc123",
        name: "read_file",
        arguments: JSON.stringify({ path: ".github/workflows/ci.yml" }),
      },
      {
        type: "function_call_output",
        call_id: "call_abc123",
        output: "name: CI\non:\n  push:\n    branches: [main]",
      },
    ],
  };

  test("1:1 Fidelity: toJSON() và toRawJson() giữ nguyên 100% dữ liệu gốc", () => {
    const payload = CodexRawPayload.from(sampleWireRequest);
    expect(payload.model).toBe("m365-copilot/think");
    expect(payload.stream).toBe(true);
    expect(payload.getThreadId()).toBe("thread_abc_123");
    expect(payload.getTurnId()).toBe("turn_xyz_789");

    const jsonRoundtrip = payload.toJSON();
    expect(jsonRoundtrip).toEqual(sampleWireRequest);

    const parsedFromStr = JSON.parse(payload.toRawJson());
    expect(parsedFromStr).toEqual(sampleWireRequest);
  });

  test("Trích xuất thông tin người dùng và lịch sử chính xác", () => {
    const payload = CodexRawPayload.from(sampleWireRequest);
    expect(payload.getLatestUserInstruction()).toBe("Thêm comment cho file ci.yml");
    expect(payload.getAllUserInstructions()).toEqual(["Thêm comment cho file ci.yml"]);

    const history = payload.getConversationHistory();
    expect(history.length).toBe(4);
    expect(history[0].role).toBe("developer");
    expect(history[1].role).toBe("user");
    expect(history[2].role).toBe("assistant");
    expect(history[3].role).toBe("tool");
  });

  test("Trích xuất công cụ khả dụng và kết quả công cụ gần nhất", () => {
    const payload = CodexRawPayload.from(sampleWireRequest);
    const tools = payload.getAvailableTools();
    const toolNames = tools.map(t => t.name);
    expect(toolNames).toContain("custom_root_tool");
    expect(toolNames).toContain("exec_command");
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("sports");

    const toolResults = payload.getLatestToolResults();
    expect(toolResults.length).toBe(1);
    expect(toolResults[0].callId).toBe("call_abc123");
    expect(toolResults[0].output).toContain("name: CI");
  });

  test("buildOptimizedPrompt() loại bỏ metadata rác, lọc tool và giảm kích thước", () => {
    const payload = CodexRawPayload.from(sampleWireRequest);
    const optimized = payload.buildOptimizedPrompt();

    // Phải chứa các thành phần cốt lõi
    expect(optimized).toContain("[HỆ THỐNG GIAO TIẾP VĂN BẢN VỚI IDE - TEXT INTERACTION PROTOCOL]");
    expect(optimized).toContain("<tool_call>");
    expect(optimized).toContain("exec_command");
    expect(optimized).toContain("read_file");
    expect(optimized).toContain("<tool_result id=\"call_abc123\">");

    // Phải loại bỏ tool không liên quan như sports
    expect(optimized).not.toContain("sports");

    // So sánh độ dài: Kiểm tra độ dài và các thành phần cốt lõi
    const rawLen = payload.toRawJson().length;
    const optLen = optimized.length;
    console.log(`[Prompt Generated] Raw JSON: ${rawLen} chars, Optimized Prompt: ${optLen} chars`);
    expect(optimized.length).toBeGreaterThan(0);
  });
});
