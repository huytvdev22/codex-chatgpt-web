import { describe, expect, test } from "bun:test";
import {
  M365OutputTranslator,
  extractCognitiveBlocks,
  M365ToolCallDetector,
} from "../src/adapters/web/protocol";
import {
  isReadOnlyTool,
  getMaxIdenticalToolCalls,
  MAX_IDENTICAL_READ_TOOL_CALLS,
  MAX_IDENTICAL_WRITE_TOOL_CALLS,
  stableToolFingerprint,
  WebTurnLoopGuard,
  conversationGuard,
} from "../src/adapters/web/execution";
import type { AdapterEvent } from "../src/types";

describe("M365 Cognitive Loop & Turn Guard Tests", () => {
  // =========================================================================
  // 1. WebTurnLoopGuard Behavioral Tests (Extracted from WebTurnEngine)
  // =========================================================================
  test("WebTurnLoopGuard ngắt vòng lặp khi cùng write tool bị gọi lặp lại >= 6 lần", () => {
    const guard = new WebTurnLoopGuard();
    const convKey = `test-loop-${Date.now()}`;
    const events: AdapterEvent[] = [];
    const clientTools = [
      {
        name: "write_file",
        description: "Write file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ] as any;
    const protocolResult: any = {
      kind: "tool_calls",
      calls: [{ name: "write_file", arguments: { path: "app.ts", content: "x" } }],
      cognitive: { cleanedText: "" },
    };

    try {
      for (let i = 0; i < MAX_IDENTICAL_WRITE_TOOL_CALLS - 1; i++) {
        const stopped = guard.evaluate({
          protocolResult,
          clientTools,
          conversationKey: convKey,
          logPrefix: "test-web",
          emit: event => events.push(event),
        });
        expect(stopped).toBe(false);
      }

      const stoppedAtLimit = guard.evaluate({
        protocolResult,
        clientTools,
        conversationKey: convKey,
        logPrefix: "test-web",
        emit: event => events.push(event),
      });
      expect(stoppedAtLimit).toBe(true);
      expect(events.some(e => e.type === "text_delta" && e.text.includes("Phát hiện vòng lặp vô hạn"))).toBe(true);
      expect(events.some(e => e.type === "done" && e.endTurn === true)).toBe(true);
    } finally {
      guard.clear(convKey);
      conversationGuard.delete(convKey);
    }
  });

  // =========================================================================
  // 2. Read vs Write Tool Quota & Loop Guard
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

  // =========================================================================
  // 4. M365ToolCallDetector Streaming Cognitive Isolation & Sanitization
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

  test("M365ToolCallDetector với renderThinkingInText: true nuốt thẻ webResponse, định dạng thought dạng text thuần túy 💭 và giữ nguyên Markdown", () => {
    const detector = new M365ToolCallDetector({ renderThinkingInText: true });
    const rawStream = [
      "<webResponse>\n<thought>\n",
      "Liên kết `app.js` trong `index.html` hiện đã đúng, ",
      "khả năng cao lỗi nằm trong cú pháp `app.js`.\n</thought>\n",
      "Tôi sẽ kiểm tra `app.js` bằng Node.js và hiển thị toàn bộ nội dung:\n",
      "<tool_call>\n",
      '{"name": "read_file", "arguments": {"path": "app.js"}}\n',
      "</tool_call>\n</webResponse>",
    ];

    let fullEmittedText = "";
    for (const chunk of rawStream) {
      fullEmittedText += detector.feed(chunk);
    }
    const { remainingText, toolCall } = detector.finish();
    fullEmittedText += remainingText;

    // 1. Không hiển thị thẻ <webResponse> hay </webResponse>
    expect(fullEmittedText).not.toContain("<webResponse>");
    expect(fullEmittedText).not.toContain("</webResponse>");

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
    const rawWithShellEscape = `<webResponse>
<thought>
Cần khảo sát cấu trúc repository, công nghệ sử dụng, trạng thái Git và các tệp cấu hình chính.
</thought>
Tôi sẽ kiểm tra cấu trúc dự án trước:
<tool_call> {"name":"exec_command","arguments":{"command":"printf '%s\\n' '=== PROJECT MANIFESTS ==='; find . -maxdepth 3 -type f \\( -name 'package.json' -o -name 'pom.xml' \\) -not -path '*/node_modules/*' -print | sort"}} </tool_call>
</webResponse>`;

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

  test("M365OutputTranslator làm sạch hoàn toàn envelope webResponse trong Final Answer", () => {
    const translator = new M365OutputTranslator();
    const raw = `<webResponse>
<thought>
Đã kiểm tra file app.js và sửa lỗi thành công. Giờ thông báo kết quả.
</thought>
Tôi đã sửa xong lỗi cú pháp trong file \`app.js\`. Mọi test đều đã vượt qua!
</webResponse>`;

    const result = translator.translate(raw);
    expect(result.type).toBe("final_answer");
    if (result.type === "final_answer") {
      expect(result.thinking).toBe("Đã kiểm tra file app.js và sửa lỗi thành công. Giờ thông báo kết quả.");
      expect(result.content).toBe("Tôi đã sửa xong lỗi cú pháp trong file `app.js`. Mọi test đều đã vượt qua!");
      expect(result.content).not.toContain("<webResponse>");
      expect(result.content).not.toContain("</webResponse>");
      expect(result.content).not.toContain("<thought>");
    }
  });
});
