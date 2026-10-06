import { describe, expect, test } from "bun:test";
import { M365ToolCallDetector } from "../src/adapters/m365-copilot/translation/toolcall-detector";
import { FastPathStreamBuffer } from "../src/adapters/m365-copilot/temp-chat/fastPathScraper";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

describe("M365 Stream Interruption & Cut-off Fixes", () => {
  test("Fix 1: tool_call_delta serialize object arguments safely without [object Object]", async () => {
    async function* mockEvents(): AsyncIterable<AdapterEvent> {
      yield { type: "tool_call_start", id: "call_test_123", name: "exec_command" };
      // Giả lập trường hợp emit tool_call_delta với chuỗi JSON hoặc object
      yield {
        type: "tool_call_delta",
        arguments: JSON.stringify({ command: "Write-Output '### TEST ###'" }),
      };
      yield { type: "tool_call_end" };
      yield {
        type: "done",
        stopReason: "tool_use",
        endTurn: false,
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      };
    }

    const stream = bridgeToResponsesSSE(mockEvents(), "gpt-5-sol-think");
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let sseOutput = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseOutput += decoder.decode(value);
    }

    // Xác nhận arguments không bao giờ chứa chuỗi literal '[object Object]'
    expect(sseOutput).not.toContain("[object Object]");
    expect(sseOutput).toContain("Write-Output '### TEST ###'");
    expect(sseOutput).toContain("response.function_call_arguments.done");
  });

  test("Fix 2: FastPathStreamBuffer.finish adopts longer final text across virtualization gaps", () => {
    const buffer = new FastPathStreamBuffer();
    // Giả lập stream chunk 1
    const delta1 = buffer.observe("1 <m365Response>\n2 <thought>Surveying code</thought>\n3 *** Begin Patch\n");
    expect(delta1.length).toBeGreaterThan(0);

    // Giả lập ở lượt cuối cùng, scraper gom được đầy đủ 438 dòng từ cache
    const completeText = "1 <m365Response>\n2 <thought>Surveying code</thought>\n3 *** Begin Patch\n4 *** Add File: style.css\n5 color: var(--color-text);\n6 *** End Patch\n7 </m365Response>";
    const finished = buffer.finish(completeText);

    expect(finished.markdown).toContain("*** End Patch");
    expect(finished.markdown).toContain("color: var(--color-text);");
    expect(finished.markdown.length).toBe(completeText.length);
  });

  test("Fix 3: Tool detector strips <m365Response> and trailing backticks cleanly on plan mode", () => {
    const detector = new M365ToolCallDetector({ renderThinkingInText: true });
    const planResponse = `<m365Response>
<thought>Plan survey complete.</thought>
<proposed_plan>
## 1. Goal
Build todo app with Vanilla JS.
</proposed_plan>
</m365Response>`;

    const emitted = detector.feed(planResponse);
    const finish = detector.finish();
    const combined = (emitted + finish.remainingText).trim();

    expect(combined).toContain("💭 Plan survey complete.");
    expect(combined).toContain("<proposed_plan>");
    expect(combined).toContain("</proposed_plan>");
    expect(combined).not.toContain("<m365Response>");
    expect(combined).not.toContain("</m365Response>");
  });
});
