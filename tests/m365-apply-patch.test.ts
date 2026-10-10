import { describe, expect, test } from "bun:test";
import { PatchToolCallDetector, normalizePatchEnvelope, M365OutputTranslator } from "../src/adapters/m365-copilot/output-translator";
import { M365ToolCallDetector } from "../src/adapters/m365-copilot/markdown";
import { M365ToolBridge } from "../src/adapters/m365-copilot/tool-bridge";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent, CodexTool } from "../src/types";

describe("M365 Native apply_patch Tests", () => {
  const samplePatch = `*** Begin Patch
*** Update File: src/cart.ts
@@ function calculateTotal @@
-  return subtotal;
+  return subtotal * 1.1;
*** End Patch`;

  test("Phase 1: PatchToolCallDetector detects raw patch text", () => {
    const detector = new PatchToolCallDetector();
    const result = detector.detect(`Tôi đã sửa hàm theo yêu cầu của bạn:\n\n${samplePatch}\n\nĐã kiểm tra xong.`);
    expect(result).not.toBeNull();
    const call = Array.isArray(result) ? result[0] : result!;
    expect(call.name).toBe("apply_patch");
    expect(call.arguments.input).toBe(samplePatch);
  });

  test("Phase 1: PatchToolCallDetector detects patch in markdown code fences", () => {
    const detector = new PatchToolCallDetector();
    const raw = "```patch\n" + samplePatch + "\n```";
    const result = detector.detect(raw);
    expect(result).not.toBeNull();
    const call = Array.isArray(result) ? result[0] : result!;
    expect(call.name).toBe("apply_patch");
    expect(call.arguments.input).toBe(samplePatch);
  });

  test("Phase 1: PatchToolCallDetector recovers Turndown escaped markdown (\\*\\*\\*, \\_, \\[, \\])", () => {
    const detector = new PatchToolCallDetector();
    const escaped = `\\*\\*\\* Begin Patch
\\*\\*\\* Update File: src/test\\[0\\].ts
@@ function test\\_fn() @@
-  const val = data\\[0\\];
+  const val = data\\[1\\];
\\*\\*\\* End Patch`;

    const result = detector.detect(escaped);
    expect(result).not.toBeNull();
    const call = Array.isArray(result) ? result[0] : result!;
    expect(call.name).toBe("apply_patch");
    expect(call.arguments.input).toContain("*** Begin Patch");
    expect(call.arguments.input).toContain("*** Update File: src/test[0].ts");
    expect(call.arguments.input).toContain("test_fn()");
    expect(call.arguments.input).toContain("const val = data[1];");
    expect(call.arguments.input).toContain("*** End Patch");
  });

  test("Phase 1: PatchToolCallDetector auto-closes unclosed patch at stream end", () => {
    const detector = new PatchToolCallDetector();
    const unclosed = `*** Begin Patch
*** Update File: src/cart.ts
@@ -1,3 +1,3 @@
-a
+b`;
    const result = detector.detect(unclosed);
    expect(result).not.toBeNull();
    const call = Array.isArray(result) ? result[0] : result!;
    expect(call.name).toBe("apply_patch");
    expect(call.arguments.input).toContain("*** Begin Patch");
    expect(call.arguments.input).toContain("*** End Patch");
  });

  test("Phase 2: M365OutputTranslator translates patch into OpenAI tool_call format", () => {
    const translator = new M365OutputTranslator([new PatchToolCallDetector()]);
    const translated = translator.translate(`Dưới đây là bản vá:\n${samplePatch}`);
    expect(translated.type).toBe("tool_call");
    if (translated.type === "tool_call") {
      expect(translated.tool_calls.length).toBe(1);
      expect(translated.tool_calls[0].function.name).toBe("apply_patch");
      const args = JSON.parse(translated.tool_calls[0].function.arguments);
      expect(args.input).toBe(samplePatch);
    }
  });

  test("Phase 3: M365ToolCallDetector streams text cleanly without leaking raw patch content", () => {
    const detector = new M365ToolCallDetector();
    const chunks = [
      "Tôi sẽ sửa hàm calculateTotal cho bạn:\n",
      "*** Begin Patch\n",
      "*** Update File: src/cart.ts\n",
      "@@ function calculateTotal @@\n",
      "-  return subtotal;\n",
      "+  return subtotal * 1.1;\n",
      "*** End Patch\n",
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
    expect(toolCall?.name).toBe("apply_patch");
    const args = toolCall?.arguments as Record<string, any>;
    expect(args?.input).toContain("*** Begin Patch");
    expect(args?.input).toContain("*** End Patch");

    const fullEmitted = emitted.join("");
    expect(fullEmitted).not.toContain("*** Begin Patch");
    expect(fullEmitted).not.toContain("*** Update File");
    expect(fullEmitted).toContain("Tôi sẽ sửa hàm calculateTotal cho bạn:");
  });

  test("Phase 4: M365ToolBridge maps apply_patch to native Codex apply_patch when client supports it", () => {
    const clientTools: CodexTool[] = [
      { name: "apply_patch", description: "Patch files", parameters: {}, freeform: true },
      { name: "exec_command", description: "Run command", parameters: {} },
    ];

    const rawCall = {
      name: "apply_patch",
      arguments: { patch: samplePatch },
    };

    const mapped = M365ToolBridge.mapToolCall(rawCall, clientTools);
    expect(mapped.name).toBe("apply_patch");
    const parsedArgs = JSON.parse(mapped.arguments);
    expect(parsedArgs.input).toBe(samplePatch);
  });

  test("Phase 4: M365ToolBridge falls back to exec_command when client does NOT have apply_patch", () => {
    const clientTools: CodexTool[] = [
      { name: "exec_command", description: "Run command", parameters: {} },
    ];

    const rawCall = {
      name: "apply_patch",
      arguments: { patch: samplePatch },
    };

    const mapped = M365ToolBridge.mapToolCall(rawCall, clientTools);
    expect(mapped.name).toBe("exec_command");
    const parsedArgs = JSON.parse(mapped.arguments);
    expect(parsedArgs.cmd).toContain("git apply");
  });

  test("Phase 5: bridgeToResponsesSSE outputs custom_tool_call with unwrapped patch input for Codex UI", async () => {
    async function* mockEvents(): AsyncIterable<AdapterEvent> {
      yield { type: "tool_call_start", id: "call_patch_123", name: "apply_patch" };
      yield { type: "tool_call_delta", arguments: JSON.stringify({ input: samplePatch }) };
      yield { type: "tool_call_end" };
      yield {
        type: "done",
        stopReason: "tool_use",
        endTurn: false,
        usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
      };
    }

    const freeformTools = new Set(["apply_patch"]);
    const stream = bridgeToResponsesSSE(mockEvents(), "m365-copilot/default", undefined, freeformTools);

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let sseText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseText += decoder.decode(value);
    }

    // Xác nhận event custom_tool_call được phát ra đúng format của Codex
    expect(sseText).toContain("custom_tool_call");
    expect(sseText).toContain("apply_patch");
    expect(sseText).toContain(JSON.stringify(samplePatch).slice(1, -1));
    expect(sseText).toContain("response.output_item.done");
  });
});
