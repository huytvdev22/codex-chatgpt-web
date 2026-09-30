import { describe, expect, test } from "bun:test";
import { compileM365Prompt } from "../src/adapters/m365-copilot/prompt";
import { M365ToolCallDetector } from "../src/adapters/m365-copilot/markdown";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

describe("M365 Tool Calling PoC Tests", () => {
  test("Phase 3: compileM365Prompt injects read_file declaration on new conversation", () => {
    const parsed: CodexParsedRequest = {
      model: "m365-copilot/default",
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
      model: "m365-copilot/default",
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
});
