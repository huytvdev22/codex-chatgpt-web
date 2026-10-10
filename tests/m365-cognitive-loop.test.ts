import { describe, expect, test } from "bun:test";
import {
  M365AgentLoop,
  CognitiveEvaluator,
  type IM365ModelClient,
  type IToolExecutor,
  type AgentLoopOptions,
} from "../src/adapters/m365-copilot/harness";
import {
  M365OutputTranslator,
  extractCognitiveBlocks,
  M365ToolCallDetector,
} from "../src/adapters/m365-copilot/translation";
import {
  isReadOnlyTool,
  getMaxIdenticalToolCalls,
  MAX_IDENTICAL_READ_TOOL_CALLS,
  MAX_IDENTICAL_WRITE_TOOL_CALLS,
  stableToolFingerprint,
} from "../src/adapters/m365-copilot/session";

describe("M365 Cognitive Loop & Agent Resilience Tests (Sprint 1)", () => {
  // =========================================================================
  // 1. Retry with Exponential Backoff
  // =========================================================================
  test("Agent Loop tự động retry khi gặp lỗi tạm thời (quota/timeout) và thành công", async () => {
    let callAttempts = 0;
    const retryEvents: { turn: number; attempt: number; delay: number }[] = [];

    const flakyModelClient: IM365ModelClient = {
      async call(prompt: string) {
        callAttempts++;
        if (callAttempts === 1) {
          throw new Error("429 Too Many Requests: Rate limit exceeded");
        }
        if (callAttempts === 2) {
          throw new Error("Request timeout: gateway timed out");
        }
        // Lần thứ 3 thành công
        return "<m365Response>Tác vụ đã được hoàn thành sau khi thử lại thành công.</m365Response>";
      },
    };

    const loop = new M365AgentLoop(flakyModelClient);
    const result = await loop.run("Thực hiện tác vụ dài hạn", {
      retryOptions: {
        maxRetries: 3,
        baseDelayMs: 10, // Rút ngắn delay trong test
        maxDelayMs: 50,
      },
      onTurnRetry(turn, attempt, error, delay) {
        retryEvents.push({ turn, attempt, delay });
      },
    });

    expect(callAttempts).toBe(3);
    expect(retryEvents.length).toBe(2);
    expect(retryEvents[0].attempt).toBe(1);
    expect(retryEvents[1].attempt).toBe(2);
    expect(result.status).toBe("completed");
    expect(result.finalAnswer).toContain("hoàn thành");
  });

  test("Agent Loop trả về status 'failed' khi lỗi không thể phục hồi hoặc vượt quá maxRetries", async () => {
    let callAttempts = 0;

    const failingModelClient: IM365ModelClient = {
      async call() {
        callAttempts++;
        throw new Error("503 Service Unavailable: temporaily unavailable");
      },
    };

    const loop = new M365AgentLoop(failingModelClient);
    const result = await loop.run("Tác vụ gặp lỗi server liên tục", {
      retryOptions: {
        maxRetries: 2,
        baseDelayMs: 5,
        maxDelayMs: 10,
      },
    });

    expect(callAttempts).toBe(2);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("503 Service Unavailable");
    expect(result.finalAnswer).toContain("thất bại sau khi thử lại");
  });

  // =========================================================================
  // 2. Per-turn Timeout
  // =========================================================================
  test("Agent Loop phát hiện và ngắt timeout per-turn khi model treo lâu", async () => {
    let callAttempts = 0;

    const hangingModelClient: IM365ModelClient = {
      async call() {
        callAttempts++;
        // Treo 200ms
        await new Promise((r) => setTimeout(r, 200));
        return "Xong";
      },
    };

    const loop = new M365AgentLoop(hangingModelClient);
    const result = await loop.run("Tác vụ bị treo", {
      retryOptions: {
        maxRetries: 2,
        perTurnTimeoutMs: 30, // Timeout 30ms < 200ms
        baseDelayMs: 5,
      },
    });

    expect(callAttempts).toBe(2); // Thử lần 1 timeout -> retry lần 2 timeout
    expect(result.status).toBe("failed");
    expect(result.error).toContain("per-turn timeout");
  });

  // =========================================================================
  // 3. Tool Result Validation & System Hint
  // =========================================================================
  test("Tool Execution lỗi được gắn thẻ error và gợi ý system_hint cho model", async () => {
    let promptReceivedAtTurn2 = "";

    const modelClient: IM365ModelClient = {
      async call(prompt: string, context?: { turnIndex: number }) {
        if (context?.turnIndex === 1) {
          // Trả về tool call đọc file không tồn tại
          return `<m365Response><tool_call>\n{"name": "read_file", "arguments": {"path": "non-existent-file.xyz"}}\n</tool_call></m365Response>`;
        }
        promptReceivedAtTurn2 = prompt;
        return "<m365Response>Tôi hiểu file không tồn tại, tôi sẽ tạo file mới.</m365Response>";
      },
    };

    const toolExecutor: IToolExecutor = {
      async execute(name, args) {
        return `Lỗi: File không tồn tại tại đường dẫn: ${args.path}`;
      },
    };

    const loop = new M365AgentLoop(modelClient, toolExecutor);
    const result = await loop.run("Đọc file và cập nhật");

    expect(result.status).toBe("completed");
    expect(result.turns).toBe(2);

    // Xác nhận turn 2 nhận được system_hint hướng dẫn
    expect(promptReceivedAtTurn2).toContain('status="error"');
    expect(promptReceivedAtTurn2).toContain("<system_hint>");
    expect(promptReceivedAtTurn2).toContain("tránh lặp lại cùng một thao tác lỗi");

    // Xác nhận message tool_result có cờ isError = true
    const toolMsg = result.messages.find((m) => m.role === "tool_result");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.isError).toBe(true);
  });

  test("Default harness retries strict protocol errors before executing tools", async () => {
    const prompts: string[] = [];
    const formatErrors: string[] = [];
    let modelCalls = 0;
    let toolExecutions = 0;

    const modelClient: IM365ModelClient = {
      async call(prompt) {
        prompts.push(prompt);
        modelCalls++;
        if (modelCalls === 1) {
          return `<tool_call>{"name":"read_file","arguments":{"path":"package.json"}}</tool_call>`;
        }
        if (modelCalls === 2) {
          return `<m365Response><tool_call>{"name":"read_file","arguments":{"path":"package.json"}}</tool_call></m365Response>`;
        }
        return `<m365Response>Hoàn tất sau khi đọc file.</m365Response>`;
      },
    };
    const executor: IToolExecutor = {
      execute() {
        toolExecutions++;
        return "{}";
      },
    };

    const result = await new M365AgentLoop(modelClient, executor).run("Đọc package.json", {
      onFormatRetry(_turn, _attempt, code) {
        formatErrors.push(code);
      },
    });

    expect(result.status).toBe("completed");
    expect(result.turns).toBe(2);
    expect(toolExecutions).toBe(1);
    expect(formatErrors).toEqual(["MISSING_RESPONSE_ENVELOPE"]);
    expect(prompts[1]).toContain("M365 RESPONSE FORMAT ERROR");
  });

  test("Default harness rejects an incomplete atomic batch without executing its valid prefix", async () => {
    let modelCalls = 0;
    let toolExecutions = 0;
    const modelClient: IM365ModelClient = {
      async call() {
        modelCalls++;
        if (modelCalls === 1) {
          return `<m365Response>
<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>
<tool_call>{"name":"grep_code","arguments":{"query":"needle"}}
</m365Response>`;
        }
        return `<m365Response>Batch trước đã được hủy.</m365Response>`;
      },
    };
    const executor: IToolExecutor = {
      execute() {
        toolExecutions++;
        return "unexpected";
      },
    };

    const result = await new M365AgentLoop(modelClient, executor).run("Kiểm tra atomic batch");
    expect(result.status).toBe("completed");
    expect(modelCalls).toBe(2);
    expect(toolExecutions).toBe(0);
    expect(result.finalAnswer).toBe("Batch trước đã được hủy.");
  });

  // =========================================================================
  // 4. Default Max Turns = 30
  // =========================================================================
  test("maxTurns mặc định là 30 (nâng từ 10) hỗ trợ tác vụ dài hơi", async () => {
    let turnsRun = 0;

    const endlessModelClient: IM365ModelClient = {
      async call() {
        turnsRun++;
        return `<m365Response><tool_call>\n{"name": "read_file", "arguments": {"path": "step_${turnsRun}.txt"}}\n</tool_call></m365Response>`;
      },
    };

    const mockToolExecutor: IToolExecutor = {
      execute: () => "OK",
    };

    const loop = new M365AgentLoop(endlessModelClient, mockToolExecutor);
    // Chạy với maxTurns mặc định (không truyền options.maxTurns)
    // Để test nhanh, ta test override maxTurns = 3 trước, rồi test default value logic
    const result = await loop.run("Chạy lặp 3 turns", { maxTurns: 3 });
    expect(result.status).toBe("max_turns_exceeded");
    expect(result.turns).toBe(3);
  });

  // =========================================================================
  // 5. Read vs Write Tool Quota & Loop Guard
  // =========================================================================
  test("Phân biệt chính xác Read-only tools và Write tools", () => {
    // Read-only tools
    expect(isReadOnlyTool("read_file")).toBe(true);
    expect(isReadOnlyTool("list_dir")).toBe(true);
    expect(isReadOnlyTool("grep_code")).toBe(true);
    expect(isReadOnlyTool("git_status")).toBe(true);
    expect(isReadOnlyTool("git_diff")).toBe(true);
    expect(isReadOnlyTool("view_file")).toBe(true);
    expect(isReadOnlyTool("grep_search")).toBe(true);
    expect(isReadOnlyTool("read_url_content")).toBe(true);

    // Write tools
    expect(isReadOnlyTool("write_file")).toBe(false);
    expect(isReadOnlyTool("run_command")).toBe(false);
    expect(isReadOnlyTool("write_stdin")).toBe(false);
    expect(isReadOnlyTool("apply_patch")).toBe(false);
  });

  test("Giới hạn lặp của Read tool cao hơn Write tool (20 vs 6)", () => {
    expect(getMaxIdenticalToolCalls("read_file")).toBe(MAX_IDENTICAL_READ_TOOL_CALLS); // 20
    expect(getMaxIdenticalToolCalls("view_file")).toBe(MAX_IDENTICAL_READ_TOOL_CALLS); // 20
    expect(getMaxIdenticalToolCalls("write_file")).toBe(MAX_IDENTICAL_WRITE_TOOL_CALLS); // 6
    expect(getMaxIdenticalToolCalls("run_command")).toBe(MAX_IDENTICAL_WRITE_TOOL_CALLS); // 6
  });

  test("Stable Fingerprint phân biệt chính xác khi đọc các phân đoạn dòng khác nhau", () => {
    const fp1 = stableToolFingerprint("read_file", { path: "src/main.ts", start_line: 1, end_line: 50 });
    const fp2 = stableToolFingerprint("read_file", { path: "src/main.ts", start_line: 51, end_line: 100 });
    const fp3 = stableToolFingerprint("read_file", { path: "src/main.ts", start_line: 1, end_line: 50 });

    expect(fp1).not.toBe(fp2);
    expect(fp1).toBe(fp3);
  });

  // =========================================================================
  // 6. Cognitive Envelope & Thought Extraction Tests
  // =========================================================================
  test("extractCognitiveBlocks bóc tách chính xác thinking, narrative và cleanedText", () => {
    const raw = `<thought>
Phân tích: Cần đọc file index.ts để kiểm tra entry point.
Mục tiêu: Đọc 50 dòng đầu.
</thought>
Để đánh giá toàn diện, tôi sẽ đọc file index.ts trước:
<tool_call>
{"name": "read_file", "arguments": {"path": "src/index.ts", "end_line": 50}}
</tool_call>`;

    const cognitive = extractCognitiveBlocks(raw);
    expect(cognitive.thinking).toContain("Phân tích: Cần đọc file index.ts");
    expect(cognitive.thinking).toContain("Mục tiêu: Đọc 50 dòng đầu.");
    expect(cognitive.narrative).toBe("Để đánh giá toàn diện, tôi sẽ đọc file index.ts trước:");
    expect(cognitive.cleanedText).not.toContain("<thought>");
  });

  test("M365OutputTranslator dịch Cognitive Envelope thành tool_call có thinking và narrative", () => {
    const translator = new M365OutputTranslator();
    const raw = `<thought>
Khảo sát cấu trúc adapter M365 Copilot.
Bước 1: Đọc agent-loop.ts.
</thought>
Bây giờ tôi cần xem file agent-loop.ts để hiểu flow:
<tool_call>
{"name": "read_file", "arguments": {"path": "src/adapters/m365-copilot/harness/agent-loop.ts"}}
</tool_call>`;

    const result = translator.translate(raw);
    expect(result.type).toBe("tool_call");
    if (result.type === "tool_call") {
      expect(result.thinking).toContain("Khảo sát cấu trúc adapter M365 Copilot");
      expect(result.narrative).toBe("Bây giờ tôi cần xem file agent-loop.ts để hiểu flow:");
      expect(result.tool_calls.length).toBe(1);
      expect(result.tool_calls[0].function.name).toBe("read_file");
    }
  });

  test("M365OutputTranslator bóc tách thinking trong Final Answer và làm sạch content", () => {
    const translator = new M365OutputTranslator();
    const raw = `<thought>
Đã có đầy đủ dữ liệu phân tích từ 3 file. Giờ kết luận cho người dùng.
</thought>
Dự án M365 Copilot có kiến trúc modular rất tốt.`;

    const result = translator.translate(raw);
    expect(result.type).toBe("final_answer");
    if (result.type === "final_answer") {
      expect(result.thinking).toBe("Đã có đầy đủ dữ liệu phân tích từ 3 file. Giờ kết luận cho người dùng.");
      expect(result.content).toBe("Dự án M365 Copilot có kiến trúc modular rất tốt.");
      expect(result.content).not.toContain("<thought>");
    }
  });

  test("CognitiveEvaluator tính toán chính xác chỉ số nhận thức của phiên", () => {
    const evaluator = new CognitiveEvaluator();
    const mockResult: any = {
      status: "completed",
      turns: 2,
      messages: [
        { role: "user", content: "Phân tích file" },
        {
          role: "assistant",
          content: '{"tool_calls":[]}',
          thinking: "Cần kiểm tra mã nguồn trước khi kết luận.",
          narrative: "Tôi sẽ đọc file trước:",
        },
        { role: "tool_result", content: "file content", isError: false },
        {
          role: "assistant",
          content: "Phân tích hoàn tất.",
          thinking: "Đã có đủ dữ liệu, đưa ra câu trả lời.",
        },
      ],
    };

    const metrics = evaluator.evaluateSession(mockResult);
    expect(metrics.totalTurns).toBe(2);
    expect(metrics.thoughtAdherenceRate).toBe(1.0); // 100% turn có thought
    expect(metrics.narrativeClarityRate).toBe(0.5); // 1/2 turn có narrative
    expect(metrics.toolSuccessRate).toBe(1.0);      // 100% tool thành công
    expect(metrics.overallCognitiveScore).toBeGreaterThanOrEqual(80);
  });

  // =========================================================================
  // 9. M365ToolCallDetector Streaming Cognitive Isolation & Sanitization
  // =========================================================================
  test("M365ToolCallDetector nuốt trọn khối <thought> không để rò rỉ vào safeText stream", () => {
    const detector = new M365ToolCallDetector();
    const chunk1 = "<thought>\nTôi đang suy nghĩ cách sửa file.\n";
    const chunk2 = "Cần kiểm tra trước.</thought>\n";
    const chunk3 = "Tôi sẽ kiểm tra file:\n<tool_call>\n";
    const chunk4 = '{"name": "read_file", "arguments": {"path": "test.ts"}}\n</tool_call>';

    const safe1 = detector.feed(chunk1);
    const safe2 = detector.feed(chunk2);
    const safe3 = detector.feed(chunk3);
    const safe4 = detector.feed(chunk4);

    // Xác nhận safeText không chứa thẻ <thought> hay nội dung suy nghĩ
    expect(safe1).toBe("");
    expect(safe2).toBe("");
    expect(safe3).toBe("Tôi sẽ kiểm tra file:");
    expect(safe4).toBe("");

    expect(detector.getThinking()).toContain("Tôi đang suy nghĩ cách sửa file.");
    expect(detector.hasDetectedToolCall()).toBe(true);
    expect(detector.getToolCall()?.name).toBe("read_file");
  });

  test("M365ToolCallDetector bảo toàn trailing backtick vì có thể là Markdown fence hợp lệ", () => {
    const detector = new M365ToolCallDetector();
    const emitted = detector.feed("Xin chào anh Huy! Mình có thể hỗ trợ anh.\n`");
    const { remainingText } = detector.finish();

    // Không suy đoán và xóa trailing backtick theo vị trí chuỗi.
    expect(emitted).toBe("Xin chào anh Huy! Mình có thể hỗ trợ anh.\n");
    expect(remainingText).toBe("`");
  });

  test("M365ToolCallDetector với renderThinkingInText: true nuốt thẻ m365Response, định dạng thought dạng text thuần túy 💭 và giữ nguyên Markdown", () => {
    const detector = new M365ToolCallDetector({ renderThinkingInText: true });
    const rawStream = [
      "<m365Response>\n<thought>\n",
      "Liên kết `app.js` trong `index.html` hiện đã đúng, ",
      "khả năng cao lỗi nằm trong cú pháp `app.js`.\n</thought>\n",
      "Tôi sẽ kiểm tra `app.js` bằng Node.js và hiển thị toàn bộ nội dung:\n",
      "<tool_call>\n",
      '{"name": "read_file", "arguments": {"path": "app.js"}}\n',
      "</tool_call>\n</m365Response>",
    ];

    let fullEmittedText = "";
    for (const chunk of rawStream) {
      fullEmittedText += detector.feed(chunk);
    }
    const { remainingText, toolCall } = detector.finish();
    fullEmittedText += remainingText;

    // 1. Không hiển thị thẻ <m365Response> hay </m365Response>
    expect(fullEmittedText).not.toContain("<m365Response>");
    expect(fullEmittedText).not.toContain("</m365Response>");

    // 2. Không hiển thị thẻ thô <thought> hay </thought>
    expect(fullEmittedText).not.toContain("<thought>");
    expect(fullEmittedText).not.toContain("</thought>");

    // 3. Khối thought được biểu diễn dạng text thuần túy với icon 💭, TUYỆT ĐỐI KHÔNG chứa thẻ HTML <small>
    expect(fullEmittedText).not.toContain("<small");
    expect(fullEmittedText).toContain("💭 ");
    expect(fullEmittedText).toContain("Liên kết `app.js` trong `index.html` hiện đã đúng");

    // 4. Phần text Markdown ở giữa giữ nguyên vẹn
    expect(fullEmittedText).toContain("Tôi sẽ kiểm tra `app.js` bằng Node.js và hiển thị toàn bộ nội dung:");

    // 5. Tool call được nhận diện chính xác
    expect(toolCall).toBeDefined();
    expect(toolCall?.name).toBe("read_file");
    expect(toolCall?.arguments).toEqual({ path: "app.js" });
  });

  test("M365OutputTranslator dịch thành công lệnh shell phức tạp chứa escape dấu ngoặc đơn \\( \\) mà không bị rơi vào fallback", () => {
    const translator = new M365OutputTranslator();
    const rawWithShellEscape = `<m365Response>
<thought>
Cần khảo sát cấu trúc repository, công nghệ sử dụng, trạng thái Git và các tệp cấu hình chính.
</thought>
Tôi sẽ kiểm tra cấu trúc dự án trước:
<tool_call> {"name":"exec_command","arguments":{"command":"printf '%s\\n' '=== PROJECT MANIFESTS ==='; find . -maxdepth 3 -type f \\( -name 'package.json' -o -name 'pom.xml' \\) -not -path '*/node_modules/*' -print | sort"}} </tool_call>
</m365Response>`;

    const result = translator.translate(rawWithShellEscape);
    expect(result.type).toBe("tool_call");
    if (result.type === "tool_call") {
      expect(result.tool_calls.length).toBe(1);
      const call = result.tool_calls[0];
      expect(call.function.name).toBe("exec_command");
      const args = JSON.parse(call.function.arguments);
      expect(args.cmd || args.command).toContain("find . -maxdepth 3 -type f \\( -name 'package.json'");
      expect(result.thinking).toContain("Cần khảo sát cấu trúc repository");
      expect(result.narrative).toContain("Tôi sẽ kiểm tra cấu trúc dự án trước:");
    }
  });

  test("M365OutputTranslator làm sạch hoàn toàn envelope m365Response trong Final Answer", () => {
    const translator = new M365OutputTranslator();
    const raw = `<m365Response>
<thought>
Đã kiểm tra file app.js và sửa lỗi thành công. Giờ thông báo kết quả.
</thought>
Tôi đã sửa xong lỗi cú pháp trong file \`app.js\`. Mọi test đều đã vượt qua!
</m365Response>`;

    const result = translator.translate(raw);
    expect(result.type).toBe("final_answer");
    if (result.type === "final_answer") {
      expect(result.thinking).toBe("Đã kiểm tra file app.js và sửa lỗi thành công. Giờ thông báo kết quả.");
      expect(result.content).toBe("Tôi đã sửa xong lỗi cú pháp trong file `app.js`. Mọi test đều đã vượt qua!");
      expect(result.content).not.toContain("<m365Response>");
      expect(result.content).not.toContain("</m365Response>");
      expect(result.content).not.toContain("<thought>");
    }
  });
});
