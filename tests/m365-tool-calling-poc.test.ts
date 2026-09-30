import { describe, expect, test } from "bun:test";
import { compileM365Prompt, truncateToolResult } from "../src/adapters/m365-copilot/prompt";
import { M365ToolCallDetector } from "../src/adapters/m365-copilot/markdown";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

describe("M365 Tool Calling PoC Tests", () => {
  test("Phase 3: compileM365Prompt injects read_file declaration on new conversation", () => {
    const parsed: CodexParsedRequest = {
      modelId: "m365-copilot/default",
      stream: true,
      context: {
        messages: [{
          role: "user",
          content: "Read pom.xml",
          timestamp: Date.now(),
        }],
      },
      options: {},
    };

    const prompt = compileM365Prompt(parsed, true);
    expect(prompt).toContain("read_file(path)");
    expect(prompt).toContain("<tool_call>");
    expect(prompt).toContain("</tool_call>");
    expect(prompt).toContain("Read pom.xml");
  });

  test("Phase 4: M365ToolCallDetector parses partial streaming chunks and suppresses tool xml", () => {
    const detector = new M365ToolCallDetector();
    const chunks = [
      "Tôi sẽ kiểm tra file pom.xml cho bạn.\n<tool",
      "_call>\n",
      "{\n  \"name\": \"read_file\",\n  \"arguments\": {\n    \"path\": \"pom.xml\"\n  }\n}",
      "\n</tool_call>\n"
    ];

    const emitted: string[] = [];
    for (const chunk of chunks) {
      const text = detector.feed(chunk);
      if (text) emitted.push(text);
    }
    const { remainingText, toolCall } = detector.finish();
    if (remainingText) emitted.push(remainingText);

    expect(detector.hasDetectedToolCall()).toBeTrue();
    expect(toolCall).not.toBeNull();
    expect(toolCall?.name).toBe("read_file");
    expect(toolCall?.arguments).toEqual({ path: "pom.xml" });

    // Không làm rò rỉ cú pháp tool call ra ngoài text streaming
    const fullEmittedText = emitted.join("");
    expect(fullEmittedText).not.toContain("<tool_call>");
    expect(fullEmittedText).not.toContain("</tool_call>");
    expect(fullEmittedText).toContain("Tôi sẽ kiểm tra file pom.xml cho bạn.\n");
  });

  test("Phase 4: M365ToolCallDetector unescapes Turndown escaped markdown (\\_ to _)", () => {
    const detector = new M365ToolCallDetector();
    const rawTurndownOutput = "<tool\\_call>\n```json\n{\n  \"name\": \"read\\_file\",\n  \"arguments\": {\n    \"path\": \"pom.xml\"\n  }\n}\n```\n</tool\\_call>";
    detector.feed(rawTurndownOutput);
    detector.finish();

    expect(detector.hasDetectedToolCall()).toBeTrue();
    const toolCall = detector.getToolCall();
    expect(toolCall?.name).toBe("read_file");
    expect(toolCall?.arguments).toEqual({ path: "pom.xml" });
  });

  test("Phase 5 & Bridge verification: M365 tool events pass through bridge.ts correctly", async () => {
    const events: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_test_123", name: "read_file" },
      { type: "tool_call_delta", arguments: JSON.stringify({ path: "pom.xml" }) },
      { type: "tool_call_end" },
      {
        type: "done",
        stopReason: "tool_use",
        endTurn: false,
        usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
      },
    ];

    // Kiểm tra cấu trúc JSON từ buildResponseJSON
    const json = buildResponseJSON(events, "m365-copilot/default") as {
      status: string;
      end_turn: boolean;
      output: Array<Record<string, unknown>>;
    };

    expect(json.status).toBe("completed");
    expect(json.end_turn).toBeFalse();
    expect(json.output.length).toBeGreaterThan(0);
    const fcItem = json.output.find(item => item.type === "function_call");
    expect(fcItem).toBeDefined();
    expect(fcItem?.name).toBe("read_file");
    expect(fcItem?.call_id).toBe("call_test_123");
    expect(fcItem?.arguments).toBe(JSON.stringify({ path: "pom.xml" }));

    // Kiểm tra luồng SSE stream từ bridgeToResponsesSSE
    async function* gen(): AsyncGenerator<AdapterEvent> {
      yield* events;
    }
    const stream = bridgeToResponsesSSE(gen(), "m365-copilot/default");
    const response = new Response(stream);
    const sseText = await response.text();

    expect(sseText).toContain("event: response.output_item.added");
    expect(sseText).toContain('"type":"function_call"');
    expect(sseText).toContain('"name":"read_file"');
    expect(sseText).toContain("event: response.function_call_arguments.delta");
    expect(sseText).toContain("event: response.function_call_arguments.done");
    expect(sseText).toContain("event: response.output_item.done");
    expect(sseText).toContain("event: response.completed");
    expect(sseText).toContain('"end_turn":false');
  });

  test("Phase 6: compileM365Prompt formats toolResult into <tool_result> for next turn", () => {
    const parsed: CodexParsedRequest = {
      modelId: "m365-copilot/default",
      stream: true,
      context: {
        messages: [
          {
            role: "user",
            content: "Read pom.xml",
            timestamp: Date.now() - 2000,
          },
          {
            role: "assistant",
            content: [{
              type: "toolCall",
              id: "call_test_123",
              name: "read_file",
              arguments: { path: "pom.xml" },
            }],
            model: "m365-copilot/default",
            timestamp: Date.now() - 1000,
          },
          {
            role: "toolResult",
            toolCallId: "call_test_123",
            toolName: "read_file",
            content: "<project><modelVersion>4.0.0</modelVersion></project>",
            isError: false,
            timestamp: Date.now(),
          },
        ],
      },
      options: {},
    };

    // Khi không phải new conversation (roundtrip turn)
    const prompt = compileM365Prompt(parsed, false);
    expect(prompt).toContain("<tool_result>");
    expect(prompt).toContain("<project><modelVersion>4.0.0</modelVersion></project>");
    expect(prompt).toContain("</tool_result>");
  });

  test("Phase 1 Expansion: truncateToolResult safeguards large tool payloads", () => {
    // 1. Text ngắn: Giữ nguyên
    const shortText = "Short tool output within limit";
    expect(truncateToolResult(shortText)).toBe(shortText);

    // 2. Text siêu dài (20,000 ký tự): Cắt ngắn an toàn
    const longText = "A".repeat(10_000) + "MIDDLE_SECRET" + "Z".repeat(10_000);
    const truncated = truncateToolResult(longText, 8000);

    expect(truncated.length).toBeLessThan(8200);
    expect(truncated).toContain("Đã lược bớt");
    expect(truncated.startsWith("AAAA")).toBeTrue();
    expect(truncated.endsWith("ZZZZ")).toBeTrue();
    expect(truncated).not.toContain("MIDDLE_SECRET");
  });

  test("Phase 2 Expansion: M365ToolBridge maps all inspection & mutation tools to cross-platform exec_command", async () => {
    const { M365ToolBridge } = await import("../src/adapters/m365-copilot/tool-bridge");

    // 1. read_file: dùng node -e cross-platform
    const r1 = M365ToolBridge.mapToolCall({ name: "read_file", arguments: { path: "src/main.ts" } });
    expect(r1.name).toBe("exec_command");
    expect(JSON.parse(r1.arguments).cmd).toContain('node -e "const fs=require(\'fs\')');
    expect(JSON.parse(r1.arguments).cmd).toContain('"src/main.ts"');

    // 2. list_dir: dùng node -e cross-platform
    const r2 = M365ToolBridge.mapToolCall({ name: "list_dir", arguments: { path: "src" } });
    expect(r2.name).toBe("exec_command");
    expect(JSON.parse(r2.arguments).cmd).toContain('node -e "const fs=require(\'fs\')');
    expect(JSON.parse(r2.arguments).cmd).toContain('"src"');

    // 3. search_files: dùng node -e cross-platform
    const r3 = M365ToolBridge.mapToolCall({ name: "search_files", arguments: { pattern: "*.json" } });
    expect(r3.name).toBe("exec_command");
    expect(JSON.parse(r3.arguments).cmd).toContain("node -e");
    expect(JSON.parse(r3.arguments).cmd).toContain('"*.json"');

    // 4. grep_code: dùng node -e cross-platform
    const r4 = M365ToolBridge.mapToolCall({ name: "grep_code", arguments: { query: "compileM365Prompt" } });
    expect(r4.name).toBe("exec_command");
    expect(JSON.parse(r4.arguments).cmd).toContain("node -e");
    expect(JSON.parse(r4.arguments).cmd).toContain('"compileM365Prompt"');

    // 5. git_status
    const r5 = M365ToolBridge.mapToolCall({ name: "git_status", arguments: {} });
    expect(r5.name).toBe("exec_command");
    expect(JSON.parse(r5.arguments).cmd).toBe("git status -s");

    // 6. git_diff
    const r6 = M365ToolBridge.mapToolCall({ name: "git_diff", arguments: { path: "package.json" } });
    expect(r6.name).toBe("exec_command");
    expect(JSON.parse(r6.arguments).cmd).toBe('git diff "package.json"');

    // 7. run_command
    const r7 = M365ToolBridge.mapToolCall({ name: "run_command", arguments: { cmd: "bun test" } });
    expect(r7.name).toBe("exec_command");
    expect(JSON.parse(r7.arguments).cmd).toBe("bun test");

    // 8. write_file với Base64
    const r8 = M365ToolBridge.mapToolCall({
      name: "write_file",
      arguments: { path: "demo.txt", content: "console.log('hello');" },
    });
    expect(r8.name).toBe("exec_command");
    const parsedCmd = JSON.parse(r8.arguments).cmd;
    expect(parsedCmd).toContain("node -e");
    expect(parsedCmd).toContain('"demo.txt"');
    const expectedB64 = Buffer.from("console.log('hello');").toString("base64");
    expect(parsedCmd).toContain(expectedB64);
  });
});
