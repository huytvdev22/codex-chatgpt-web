import { describe, expect, test } from "bun:test";
import { M365OutputTranslator } from "../src/adapters/m365-copilot/translation/output-translator";
import { XmlToolCallDetector } from "../src/adapters/m365-copilot/translation/detectors/xml-detector";
import {
  UNIFIED_TOOL_PROTOCOL,
  CORE_CODING_TOOLS_DECLARATION,
  CANONICAL_TOOL_EXAMPLES,
  promptCompiler,
} from "../src/adapters/m365-copilot/prompts/compiler";
import {
  FILE_REFERENCING_CONVENTION_PROMPT,
  TOOL_REMINDER_PROMPT,
  PLAN_MODE_PROMPT,
  IMPLEMENT_PLAN_PROMPT,
  COMPACT_CORE_TOOLS_DECLARATION,
  COMPACT_APPLY_PATCH_EXAMPLES,
} from "../src/adapters/m365-copilot/prompts/templates";
import { M365ToolBridge, normalizeRequestUserInputArgs } from "../src/adapters/m365-copilot/tools/tool-bridge";

describe("M365 Prompt Simplification & Parallel Tool Calls Tests", () => {
  test("1. UNIFIED_TOOL_PROTOCOL đã loại bỏ hoàn toàn <thought> và hướng dẫn xuất trực tiếp", () => {
    // Không còn khối khai báo cấu trúc <thought>
    expect(UNIFIED_TOOL_PROTOCOL).not.toContain("[Suy luận nội tâm");
    expect(UNIFIED_TOOL_PROTOCOL).toContain("TUYỆT ĐỐI KHÔNG VIẾT THẺ <thought>...</thought>");

    // Có chỉ thị xuất trực tiếp và cấm văn bản rườm rà
    expect(UNIFIED_TOOL_PROTOCOL).toContain("XUẤT THẲNG KHỐI <tool_call>");
    expect(UNIFIED_TOOL_PROTOCOL).toContain("TUYỆT ĐỐI KHÔNG CHÊM VĂN BẢN DẪN DẮT RƯỜM RÀ");

    // Hỗ trợ gọi nhiều tool đồng thời
    expect(UNIFIED_TOOL_PROTOCOL).toContain("PARALLEL TOOL CALLS");

    // Bảo toàn các quy tắc cốt lõi đã kiểm chứng
    expect(UNIFIED_TOOL_PROTOCOL).toContain("apply_patch");
    expect(UNIFIED_TOOL_PROTOCOL).toContain("write_file");
    expect(UNIFIED_TOOL_PROTOCOL).toContain("cat <<EOF");
    expect(UNIFIED_TOOL_PROTOCOL).toContain("ĐỌC FILE AN TOÀN (SAFE READING)");
    expect(UNIFIED_TOOL_PROTOCOL).toContain("150 dòng");
    expect(UNIFIED_TOOL_PROTOCOL).toContain("node_modules");
  });

  test("2. Cảnh báo quét đệ quy node_modules hiện diện trong các mẫu templates", () => {
    expect(UNIFIED_TOOL_PROTOCOL).toContain("node_modules");
    expect(PLAN_MODE_PROMPT).toContain("node_modules");
    expect(IMPLEMENT_PLAN_PROMPT).toContain("node_modules");
    expect(TOOL_REMINDER_PROMPT).toContain("node_modules");
  });

  test("3. Ví dụ mẫu CANONICAL_TOOL_EXAMPLES chứa mẫu gọi nhiều tool song song", () => {
    expect(CANONICAL_TOOL_EXAMPLES).toContain("Parallel Tool Calls");
  });

  test("4. XmlToolCallDetector phát hiện nhiều khối <tool_call> song song (Multi-Tool)", () => {
    const detector = new XmlToolCallDetector();
    const raw = `
<tool_call>
{"name": "exec_command", "arguments": {"command": "head -n 150 README.md"}}
</tool_call>
<tool_call>
{"name": "exec_command", "arguments": {"command": "git status --short"}}
</tool_call>
<tool_call>
{"name": "exec_command", "arguments": {"command": "ls -la src"}}
</tool_call>
`;
    const detected = detector.detect(raw);
    expect(Array.isArray(detected)).toBe(true);
    const list = detected as any[];
    expect(list.length).toBe(3);
    expect(list[0].name).toBe("exec_command");
    expect(list[0].arguments.command).toBe("head -n 150 README.md");
    expect(list[1].name).toBe("exec_command");
    expect(list[1].arguments.command).toBe("git status --short");
    expect(list[2].name).toBe("exec_command");
    expect(list[2].arguments.command).toBe("ls -la src");
  });

  test("5. XmlToolCallDetector kết hợp đồng thời cả <custom_tool_call> patch và <tool_call>", () => {
    const detector = new XmlToolCallDetector();
    const raw = `
<custom_tool_call name="apply_patch">
*** Begin Patch
*** Update File: src/test.ts
@@ -1,1 +1,2 @@
+console.log('patched');
*** End Patch
</custom_tool_call>
<tool_call>
{"name": "exec_command", "arguments": {"command": "bun test"}}
</tool_call>
`;
    const detected = detector.detect(raw);
    expect(Array.isArray(detected)).toBe(true);
    const list = detected as any[];
    expect(list.length).toBe(2);
    expect(list[0].name).toBe("apply_patch");
    expect(list[0].arguments.input).toContain("*** Begin Patch");
    expect(list[1].name).toBe("exec_command");
    expect(list[1].arguments.command).toBe("bun test");
  });

  test("6. M365OutputTranslator dịch trọn vẹn chuỗi phản hồi song song không có thought", () => {
    const translator = new M365OutputTranslator();
    const raw = `
<tool_call>
{"name": "exec_command", "arguments": {"command": "git log -n 5"}}
</tool_call>
<tool_call>
{"name": "exec_command", "arguments": {"command": "bun --version"}}
</tool_call>
`;
    const res = translator.translate(raw);
    expect(res.type).toBe("tool_call");
    if (res.type === "tool_call") {
      expect(res.tool_calls.length).toBe(2);
      expect(res.thinking).toBeUndefined();
      expect(res.tool_calls[0].function.name).toBe("exec_command");
      expect(res.tool_calls[0].function.arguments).toContain("git log");
      expect(res.tool_calls[1].function.name).toBe("exec_command");
      expect(res.tool_calls[1].function.arguments).toContain("bun --version");
    }
  });

  test("7. normalizeRequestUserInputArgs chuẩn hóa mềm dẻo các định dạng câu hỏi và tùy chọn", () => {
    // Trường hợp 1: Mảng câu hỏi chuẩn với choices là string array
    const raw1 = {
      questions: [
        {
          id: "architecture",
          header: "Kiến trúc",
          question: "Bạn muốn dùng mẫu thiết kế nào?",
          choices: ["Modular Strategy (Recommended)", "Monolithic"],
        },
      ],
    };
    const norm1 = normalizeRequestUserInputArgs(raw1);
    expect(norm1.questions.length).toBe(1);
    expect(norm1.questions[0].id).toBe("architecture");
    expect(norm1.questions[0].header).toBe("Kiến trúc");
    expect(norm1.questions[0].is_other).toBe(true);
    expect(norm1.questions[0].is_secret).toBe(false);
    expect(norm1.questions[0].options.length).toBe(2);
    expect(norm1.questions[0].options[0].label).toBe("Modular Strategy (Recommended)");
    expect(norm1.questions[0].options[0].description).toBe("");

    // Trường hợp 2: Single question truyền trực tiếp ở root (không bọc trong questions)
    const raw2 = {
      prompt: "Chọn framework CSS mong muốn?",
      options: [
        { name: "Tailwind CSS (Recommended)", desc: "Utility-first CSS framework" },
        { name: "Vanilla CSS", desc: "No runtime dependency" },
      ],
    };
    const norm2 = normalizeRequestUserInputArgs(raw2);
    expect(norm2.questions.length).toBe(1);
    expect(norm2.questions[0].question).toBe("Chọn framework CSS mong muốn?");
    expect(norm2.questions[0].header).toBe("Chọn framework CSS mong");
    expect(norm2.questions[0].options[0].label).toBe("Tailwind CSS (Recommended)");
    expect(norm2.questions[0].options[0].description).toBe("Utility-first CSS framework");
  });

  test("8. M365ToolBridge map request_user_input chính xác cho Codex native", () => {
    const rawCall = {
      name: "request_user_input",
      arguments: JSON.stringify({
        question: "Phương án triển khai tiếp theo?",
        header: "Approach",
        options: ["Tạo file mới (Recommended)", "Sửa file hiện có"],
      }),
    };
    const mapped = M365ToolBridge.mapToolCall(rawCall, [
      { name: "request_user_input", description: "", parameters: {} } as any,
    ]);
    expect(mapped.name).toBe("request_user_input");
    const args = JSON.parse(mapped.arguments);
    expect(args.questions.length).toBe(1);
    expect(args.questions[0].header).toBe("Approach");
    expect(args.questions[0].is_other).toBe(true);
    expect(args.questions[0].options[0].label).toContain("(Recommended)");
  });

  test("9. XmlToolCallDetector & OutputTranslator phát hiện và dịch request_user_input đầy đủ", () => {
    const translator = new M365OutputTranslator();
    const raw = `
<tool_call>
{
  "name": "request_user_input",
  "arguments": {
    "questions": [
      {
        "id": "ui_choice",
        "header": "Giao diện",
        "question": "Bạn thích phong cách giao diện nào?",
        "options": [
          {"label": "Dark Mode (Recommended)", "description": "Hiện đại, tiết kiệm pin"},
          {"label": "Light Mode", "description": "Sáng sủa, cổ điển"}
        ]
      }
    ]
  }
}
</tool_call>
`;
    const res = translator.translate(raw);
    expect(res.type).toBe("tool_call");
    if (res.type === "tool_call") {
      expect(res.tool_calls.length).toBe(1);
      expect(res.tool_calls[0].function.name).toBe("request_user_input");
      const parsed = JSON.parse(res.tool_calls[0].function.arguments);
      expect(parsed.questions.length).toBe(1);
      expect(parsed.questions[0].id).toBe("ui_choice");
      expect(parsed.questions[0].options[0].label).toBe("Dark Mode (Recommended)");
    }
  });

  test("10. Prompts và templates chứa đầy đủ hướng dẫn phỏng vấn request_user_input", () => {
    expect(CORE_CODING_TOOLS_DECLARATION).toContain("request_user_input");
    expect(CORE_CODING_TOOLS_DECLARATION).toContain("Interactive User Interview Wizard");
    expect(CORE_CODING_TOOLS_DECLARATION).toContain("(Recommended)");
    expect(CANONICAL_TOOL_EXAMPLES).toContain("request_user_input");
    expect(PLAN_MODE_PROMPT).toContain("request_user_input");
    expect(PLAN_MODE_PROMPT).toContain("Interactive User Interview Wizard");
  });

  test("11. COMPACT_CORE_TOOLS_DECLARATION và COMPACT_APPLY_PATCH_EXAMPLES định nghĩa tóm tắt súc tích", () => {
    // Bản compact có tên các tool chính
    expect(COMPACT_CORE_TOOLS_DECLARATION).toContain("AVAILABLE TOOLS (COMPACT):");
    expect(COMPACT_CORE_TOOLS_DECLARATION).toContain("apply_patch");
    expect(COMPACT_CORE_TOOLS_DECLARATION).toContain("read_file");
    expect(COMPACT_CORE_TOOLS_DECLARATION).toContain("exec_command");
    expect(COMPACT_CORE_TOOLS_DECLARATION).toContain("request_user_input");

    // Bản compact ví dụ: CHỈ GIỮ LẠI cú pháp apply_patch
    expect(COMPACT_APPLY_PATCH_EXAMPLES).toContain("VÍ DỤ MẪU DUY NHẤT: CÚ PHÁP apply_patch");
    expect(COMPACT_APPLY_PATCH_EXAMPLES).toContain("*** Update File:");
    expect(COMPACT_APPLY_PATCH_EXAMPLES).toContain("*** Add File:");
    // Tuyệt đối không chứa các ví dụ thừa khác
    expect(COMPACT_APPLY_PATCH_EXAMPLES).not.toContain("git_status");
    expect(COMPACT_APPLY_PATCH_EXAMPLES).not.toContain("grep_code");
    expect(COMPACT_APPLY_PATCH_EXAMPLES).not.toContain("search_files");
  });

  test("12. promptCompiler từ Turn 2 (isNewConversation: false) sinh ra Compact Prompt và bảo toàn Environment Context", () => {
    const mockNormalized: any = {
      threadId: "th_123",
      turnId: "tu_123",
      activeCodingTools: [],
      priorHistory: [],
      trailingToolResults: [
        { callId: "c_1", toolName: "apply_patch", kind: "custom", output: "Success. Updated styles.css" },
      ],
      latestUserInstruction: "tiếp tục sửa js/app.js",
      environmentContext: "- Thư mục làm việc (cwd): /workspace/app\n- Shell: zsh",
    };
    const mockParsed: any = {
      modelId: "m365-copilot/think",
      stream: true,
      options: {},
      context: { messages: [] },
    };

    // 1. Turn 1 (isNewConversation: true) -> Full Prompt
    const resTurn1 = promptCompiler.compile({
      normalized: mockNormalized,
      parsed: mockParsed,
      isNewConversation: true,
    });
    expect(resTurn1.finalPrompt).toContain("AVAILABLE TOOLS\n");
    expect(resTurn1.finalPrompt).toContain("VÍ DỤ MẪU GỌI CÔNG CỤ CHUẨN");
    expect(resTurn1.finalPrompt).toContain("git_status");

    // 2. Turn 2 (isNewConversation: false) -> Compact Prompt
    const resTurn2 = promptCompiler.compile({
      normalized: mockNormalized,
      parsed: mockParsed,
      isNewConversation: false,
    });
    expect(resTurn2.finalPrompt).toContain("AVAILABLE TOOLS (COMPACT):");
    expect(resTurn2.finalPrompt).toContain("VÍ DỤ MẪU DUY NHẤT: CÚ PHÁP apply_patch");
    // Bảo toàn Ngữ cảnh Môi trường
    expect(resTurn2.finalPrompt).toContain("[NGỮ CẢNH DỰ ÁN & MÔI TRƯỜNG]:");
    expect(resTurn2.finalPrompt).toContain("/workspace/app");
    // Loại bỏ các ví dụ dài dòng không cần thiết
    expect(resTurn2.finalPrompt).not.toContain('{"name": "git_status"');
    expect(resTurn2.finalPrompt).not.toContain('{"name": "grep_code"');

    // Dung lượng Turn 2 compact hơn nhiều so với Turn 1
    expect(resTurn2.finalPrompt.length).toBeLessThan(resTurn1.finalPrompt.length);
  });

  test("13. Quy chuẩn tham chiếu file bằng Markdown link tương đối hiện diện đầy đủ trong các bộ prompt", () => {
    // 1. FILE_REFERENCING_CONVENTION_PROMPT
    expect(FILE_REFERENCING_CONVENTION_PROMPT).toContain("[tên_file](đường_dẫn_tương_đối)");
    expect(FILE_REFERENCING_CONVENTION_PROMPT).toContain("[index.html](index.html)");
    expect(FILE_REFERENCING_CONVENTION_PROMPT).toContain("[index.html — dòng 12](index.html#L12)");

    // 2. UNIFIED_TOOL_PROTOCOL
    expect(UNIFIED_TOOL_PROTOCOL).toContain("QUY TẮC THAM CHIẾU TỆP TIN (CLICKABLE LINKS)");
    expect(UNIFIED_TOOL_PROTOCOL).toContain("[index.html](index.html)");
    expect(UNIFIED_TOOL_PROTOCOL).toContain("[index.html — dòng 12](index.html#L12)");

    // 3. PLAN_MODE_PROMPT
    expect(PLAN_MODE_PROMPT).toContain("QUY TẮC THAM CHIẾU TỆP TIN");
    expect(PLAN_MODE_PROMPT).toContain("[index.html](index.html)");
    expect(PLAN_MODE_PROMPT).toContain("[index.html — dòng 12](index.html#L12)");

    // 4. IMPLEMENT_PLAN_PROMPT
    expect(IMPLEMENT_PLAN_PROMPT).toContain("QUY TẮC THAM CHIẾU TỆP TIN");
    expect(IMPLEMENT_PLAN_PROMPT).toContain("[index.html](index.html)");
    expect(IMPLEMENT_PLAN_PROMPT).toContain("[index.html — dòng 12](index.html#L12)");

    // 5. TOOL_REMINDER_PROMPT
    expect(TOOL_REMINDER_PROMPT).toContain("QUY TẮC THAM CHIẾU TỆP TIN");
    expect(TOOL_REMINDER_PROMPT).toContain("[index.html](index.html)");
    expect(TOOL_REMINDER_PROMPT).toContain("[index.html — dòng 12](index.html#L12)");

    // 6. COMPACT_CORE_TOOLS_DECLARATION (Turn 2 trở đi)
    expect(COMPACT_CORE_TOOLS_DECLARATION).toContain("[index.html](index.html)");
    expect(COMPACT_CORE_TOOLS_DECLARATION).toContain("[index.html — dòng 12](index.html#L12)");
  });
});

