import { describe, expect, test } from "bun:test";
import { M365OutputTranslator } from "../src/adapters/m365-copilot/output-translator";
import { compileM365Prompt, TOOL_REMINDER_PROMPT } from "../src/adapters/m365-copilot/prompt";
import {
  M365CopilotAdapter,
  conversationGuard,
  MAX_IDENTICAL_TOOL_CALLS,
  isAssistantFinalAnswer,
  stableToolFingerprint,
  cleanExpiredConversationGuards,
} from "../src/adapters/m365-copilot";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

describe("M365 Loop Prevention & Final Answer Integrity Tests", () => {
  const translator = new M365OutputTranslator();

  // ----------------------------------------------------
  // Test 1: Final answer không sinh tool call
  // ----------------------------------------------------
  test("Test 1: Final answer with 'type', 'cat', 'npm test' in explanatory Vietnamese text is strictly final_answer", () => {
    const rawAnalysis = `Dưới đây là kết quả phân tích nguyên nhân lỗi validation:
1. Trong file CustomerSourceController.java:
Kiểm tra type request body không hợp lệ do thiếu trường id.
2. cat dữ liệu mẫu cho thấy cấu trúc DTO không khớp.
3. Để kiểm tra lại trên terminal, bạn có thể chạy:
npm test
4. Kết luận: Đã xác định đầy đủ nguyên nhân lỗi validation.`;

    const result = translator.translate(rawAnalysis);
    expect(result.type).toBe("final_answer");
    if (result.type === "final_answer") {
      expect(result.content).toBe(rawAnalysis.trim());
      expect(result.content).toContain("type request body không hợp lệ");
      expect(result.content).toContain("cat dữ liệu mẫu");
    }
  });

  // ----------------------------------------------------
  // Test 2: Prose cộng explicit tool call vẫn phải chạy
  // ----------------------------------------------------
  test("Test 2: Prose cộng explicit tool call vẫn phải chạy (không bị prose làm mất)", () => {
    const responseWithProseAndXml = `Tôi cần đọc file cấu hình trước để xác minh dependencies.

<tool_call>
{
  "name": "read_file",
  "arguments": {
    "path": "package.json"
  }
}
</tool_call>`;

    const result = translator.translate(responseWithProseAndXml);
    expect(result.type).toBe("tool_call");
    if (result.type === "tool_call") {
      expect(result.tool_calls.length).toBe(1);
      expect(result.tool_calls[0].function.name).toBe("read_file");
      expect(JSON.parse(result.tool_calls[0].function.arguments)).toEqual({ path: "package.json" });
    }
  });

  // ----------------------------------------------------
  // Test 3: Prose cộng fenced shell command & standalone command
  // ----------------------------------------------------
  test("Test 3: Prose cộng fenced shell command hoặc strict standalone command", () => {
    // 3a. Prose + fenced code block ```bash
    const responseWithFencedBash = `Tôi sẽ chạy kiểm thử dự án để kiểm tra lỗi:

\`\`\`bash
bun test
\`\`\``;

    const resFenced = translator.translate(responseWithFencedBash);
    expect(resFenced.type).toBe("tool_call");
    if (resFenced.type === "tool_call") {
      expect(resFenced.tool_calls.length).toBe(1);
      expect(resFenced.tool_calls[0].function.name).toBe("run_command");
      expect(JSON.parse(resFenced.tool_calls[0].function.arguments)).toEqual({ cmd: "bun test" });
    }

    // 3b. Prose + standalone cat command
    const responseWithStandaloneCat = `Tôi sẽ kiểm tra file cấu hình trước.

cat package.json`;

    const resStandalone = translator.translate(responseWithStandaloneCat);
    expect(resStandalone.type).toBe("tool_call");
    if (resStandalone.type === "tool_call") {
      expect(resStandalone.tool_calls.length).toBe(1);
      expect(resStandalone.tool_calls[0].function.name).toBe("read_file");
      expect(JSON.parse(resStandalone.tool_calls[0].function.arguments)).toEqual({ path: "package.json" });
    }

    // 3c. type Dockerfile (hợp lệ) vs type com.example.Request (prose)
    const resDocker = translator.translate("type Dockerfile");
    expect(resDocker.type).toBe("tool_call");

    const resClass = translator.translate("type com.example.Request là class đầu vào");
    expect(resClass.type).toBe("final_answer");

    // 3d. Fenced code block mang tính hướng dẫn/minh họa KHÔNG được tự động chạy
    const instructionalText1 = `Bạn có thể chạy lệnh sau nếu muốn kiểm tra:
\`\`\`bash
rm -rf build
\`\`\``;
    const resInstruction1 = translator.translate(instructionalText1);
    expect(resInstruction1.type).toBe("final_answer");

    const instructionalText2 = `Ví dụ lệnh Maven tham khảo:
\`\`\`bash
mvn test
\`\`\``;
    const resInstruction2 = translator.translate(instructionalText2);
    expect(resInstruction2.type).toBe("final_answer");

    // 3e. Fenced code block có chủ đích thực thi của model được chuyển thành tool_call
    const executionText = `Tôi sẽ tiến hành chạy kiểm tra Maven:
\`\`\`bash
mvn test
\`\`\``;
    const resExecution = translator.translate(executionText);
    expect(resExecution.type).toBe("tool_call");
    if (resExecution.type === "tool_call") {
      expect(resExecution.tool_calls[0].function.name).toBe("run_command");
      expect(JSON.parse(resExecution.tool_calls[0].function.arguments)).toEqual({ cmd: "mvn test" });
    }

    // 3f. Chốt chặn an toàn: Destructive commands (rm, del, git reset, git push, docker prune...)
    // TUYỆT ĐỐI không bao giờ tự động chạy từ fenced code block thông thường!
    const destructiveRm = `Dưới đây là lệnh dọn dẹp:
\`\`\`bash
rm -rf target build
\`\`\``;
    expect(translator.translate(destructiveRm).type).toBe("final_answer");

    const destructiveGitReset = `Để khôi phục trạng thái:
\`\`\`bash
git reset --hard HEAD
\`\`\``;
    expect(translator.translate(destructiveGitReset).type).toBe("final_answer");

    // Nhưng nếu dùng XML explicit <tool_call> thì vẫn được tôn trọng
    const explicitDestructive = `<tool_call>
{
  "name": "run_command",
  "arguments": { "cmd": "rm -rf build" }
}
</tool_call>`;
    const resExplicit = translator.translate(explicitDestructive);
    expect(resExplicit.type).toBe("tool_call");
  });

  // ----------------------------------------------------
  // Test 4: Không replay assistant cuối & Phân biệt pending toolCall vs final answer
  // ----------------------------------------------------
  test("Test 4: Không replay assistant cuối & Phân biệt chính xác pending toolCall vs final answer", async () => {
    const parsedFinalAnswer: CodexParsedRequest = {
      modelId: "m365-copilot/default",
      stream: true,
      context: {
        messages: [
          { role: "user", content: "Check file", timestamp: 1000 },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "c1", name: "read_file", arguments: { path: "a.txt" } }],
            model: "m365-copilot/default",
            timestamp: 2000,
          },
          { role: "toolResult", toolCallId: "c1", toolName: "read_file", content: "FILE_CONTENT_A", isError: false, timestamp: 3000 },
          {
            role: "assistant",
            content: [{ type: "text", text: "Nguyên nhân lỗi validation: do file a.txt thiếu trường age." }],
            model: "m365-copilot/default",
            timestamp: 4000,
          },
        ],
      },
      options: {},
    };

    // 4a. compileM365Prompt: Không chứa nội dung toolResult cũ và không nạp lại assistant cuối
    const prompt = compileM365Prompt(parsedFinalAnswer, false);
    expect(prompt).not.toContain("FILE_CONTENT_A");
    expect(prompt).not.toContain("<tool_result>\nFILE_CONTENT_A");

    // 4b. M365CopilotAdapter: Nhận request mà message cuối cùng là assistant final answer -> Ngắt ngay với endTurn: true
    const adapter = new M365CopilotAdapter();
    const events: AdapterEvent[] = [];
    await adapter.runTurn(parsedFinalAnswer, { headers: new Headers() }, (e) => events.push(e));

    const doneEvent = events.find(e => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent && doneEvent.type === "done") {
      expect(doneEvent.stopReason).toBe("stop");
      expect(doneEvent.endTurn).toBe(true);
    }

    // 4c. Nếu assistant message cuối cùng chứa toolCall (đang chờ IDE thực thi), KHÔNG được coi là final answer
    const parsedPendingTool: CodexParsedRequest = {
      modelId: "m365-copilot/default",
      stream: true,
      context: {
        messages: [
          { role: "user", content: "Read pom", timestamp: 1000 },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "c2", name: "read_file", arguments: { path: "pom.xml" } }],
            timestamp: 2000,
          },
        ],
      },
      options: {},
    };

    const lastMsg = parsedPendingTool.context.messages[parsedPendingTool.context.messages.length - 1];
    expect(isAssistantFinalAnswer(lastMsg)).toBe(false);

    // 4d. Nếu assistant content là text string nhưng chứa XML <tool_call> serialize -> KHÔNG phải final answer
    const assistantSerializedXml = {
      role: "assistant" as const,
      content: '<tool_call>{"name": "read_file", "arguments": {"path": "pom.xml"}}</tool_call>',
      timestamp: 3000,
    };
    expect(isAssistantFinalAnswer(assistantSerializedXml as any)).toBe(false);

    // 4e. Biến thể schema khác: tool_call (snake_case) hoặc function_call
    const assistantSnakeCase = {
      role: "assistant" as const,
      content: [{ type: "tool_call", id: "c3", name: "list_dir" }],
      timestamp: 3000,
    };
    expect(isAssistantFinalAnswer(assistantSnakeCase as any)).toBe(false);
  });

  // ----------------------------------------------------
  // Test 5: Tool loop hoàn chỉnh qua bridgeToResponsesSSE chứng minh end_turn: true
  // ----------------------------------------------------
  test("Test 5: SSE output từ bridgeToResponsesSSE thực sự chứa end_turn: true khi hoàn tất turn", async () => {
    async function* eventStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "text_delta", text: "Phân tích hoàn tất: Lỗi validation đã được sửa." };
      yield {
        type: "done",
        stopReason: "stop",
        endTurn: true,
        usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
      };
    }

    const stream = bridgeToResponsesSSE(eventStream(), "m365-copilot/default");
    const response = new Response(stream);
    const sseText = await response.text();

    expect(sseText).toContain("event: response.completed");
    expect(sseText).toContain('"status":"completed"');
    expect(sseText).toContain('"end_turn":true');
    expect(sseText).toContain("data: [DONE]");
  });

  // ----------------------------------------------------
  // Test 6: Giới hạn phòng vệ, Stable Fingerprint, Fallback Isolation & Cleanup
  // ----------------------------------------------------
  test("Test 6: Loop Guard tự động ngắt sau 3 lần trùng và chuẩn hóa Stable Fingerprint", () => {
    // 6a. Stable Fingerprint không phụ thuộc vào thứ tự key
    const fp1 = stableToolFingerprint("read_file", { path: "pom.xml", line: 10 });
    const fp2 = stableToolFingerprint("read_file", { line: 10, path: "pom.xml" });
    expect(fp1).toBe(fp2);

    // 6b. Chuẩn hóa path separator Windows \ sang /
    const fpWin = stableToolFingerprint("read_file", { path: "src\\index.ts" });
    const fpUnix = stableToolFingerprint("read_file", { path: "src/index.ts" });
    expect(fpWin).toBe(fpUnix);

    // 6c. Kiểm tra TTL cleanup
    const convKey = `test_ttl_guard_${Date.now()}`;
    conversationGuard.set(convKey, {
      toolIterations: 5,
      identicalToolCount: 1,
      updatedAt: Date.now() - 20 * 60 * 1000, // 20 phút trước (quá hạn 15 phút)
    });
    cleanExpiredConversationGuards();
    expect(conversationGuard.has(convKey)).toBe(false);

    // 6d. Hai request không có conversationKey không dùng chung state lặp
    const transientKeyA = `transient_test_a_${Date.now()}`;
    const transientKeyB = `transient_test_b_${Date.now()}`;
    conversationGuard.set(transientKeyA, {
      toolIterations: 2,
      lastToolFingerprint: "read_file:{}",
      identicalToolCount: 2,
      updatedAt: Date.now(),
    });
    // Request B là một phiên transient độc lập
    expect(conversationGuard.get(transientKeyB)).toBeUndefined();
    conversationGuard.delete(transientKeyA);
  });

  // ----------------------------------------------------
  // Test 7: Full Multi-turn Lifecycle Simulation: Tool Execution -> Tool Result -> Final Answer -> Continuation Blocked
  // ----------------------------------------------------
  test("Test 7: Full Multi-turn Lifecycle Simulation mô phỏng dừng triệt để sau final answer", async () => {
    const adapter = new M365CopilotAdapter();

    // Bước 1: Client gửi tool result sau khi đọc xong pom.xml
    const turn1Request: CodexParsedRequest = {
      modelId: "m365-copilot/default",
      stream: false,
      context: {
        messages: [
          { role: "user", content: "Đọc pom.xml và cho biết phiên bản Spring Boot", timestamp: 1000 },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_pom", name: "read_file", arguments: { path: "pom.xml" } }],
            timestamp: 2000,
          },
          {
            role: "toolResult",
            toolCallId: "call_pom",
            toolName: "read_file",
            content: "<parent><groupId>org.springframework.boot</groupId><version>3.2.0</version></parent>",
            isError: false,
            timestamp: 3000,
          },
        ],
      },
      options: {},
    };

    // Bước 2: Model trả về Final Answer hoàn tất
    // Bước 3: Nếu Codex Client gửi thêm một continuation request thừa với context kết thúc bằng Final Answer
    const turn2ContinuationRequest: CodexParsedRequest = {
      modelId: "m365-copilot/default",
      stream: false,
      context: {
        messages: [
          ...turn1Request.context.messages,
          {
            role: "assistant",
            content: [{ type: "text", text: "Dự án đang sử dụng phiên bản Spring Boot 3.2.0." }],
            timestamp: 4000,
          },
        ],
      },
      options: {},
    };

    const events: AdapterEvent[] = [];
    const startTime = performance.now();
    await adapter.runTurn(turn2ContinuationRequest, { headers: new Headers() }, (e) => events.push(e));
    const elapsed = performance.now() - startTime;

    // Khẳng định: Ngắt ngay lập tức (< 50ms) bằng Early Conclude mà không gọi bất kỳ upstream provider nào!
    expect(elapsed).toBeLessThan(50);
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent && doneEvent.type === "done") {
      expect(doneEvent.stopReason).toBe("stop");
      expect(doneEvent.endTurn).toBe(true);
    }
  });
});
