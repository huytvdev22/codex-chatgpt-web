import { describe, expect, test } from "bun:test";
import { M365OutputTranslator } from "../src/adapters/m365-copilot/translation/output-translator";
import { XmlToolCallDetector } from "../src/adapters/m365-copilot/translation/detectors/xml-detector";
import { UNIFIED_TOOL_PROTOCOL, CORE_CODING_TOOLS_DECLARATION, CANONICAL_TOOL_EXAMPLES } from "../src/adapters/m365-copilot/prompts/compiler";
import { TOOL_REMINDER_PROMPT, PLAN_MODE_PROMPT, IMPLEMENT_PLAN_PROMPT } from "../src/adapters/m365-copilot/prompts/templates";
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
    expect(res.tool_calls.length).toBe(2);
    expect(res.thinking).toBeUndefined();
    expect(res.tool_calls[0].function.name).toBe("exec_command");
    expect(res.tool_calls[0].function.arguments).toContain("git log");
    expect(res.tool_calls[1].function.name).toBe("exec_command");
    expect(res.tool_calls[1].function.arguments).toContain("bun --version");
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
    expect(res.tool_calls.length).toBe(1);
    expect(res.tool_calls[0].function.name).toBe("request_user_input");
    const parsed = JSON.parse(res.tool_calls[0].function.arguments);
    expect(parsed.questions.length).toBe(1);
    expect(parsed.questions[0].id).toBe("ui_choice");
    expect(parsed.questions[0].options[0].label).toBe("Dark Mode (Recommended)");
  });

  test("10. Prompts và templates chứa đầy đủ hướng dẫn phỏng vấn request_user_input", () => {
    expect(CORE_CODING_TOOLS_DECLARATION).toContain("request_user_input");
    expect(CORE_CODING_TOOLS_DECLARATION).toContain("Interactive User Interview Wizard");
    expect(CORE_CODING_TOOLS_DECLARATION).toContain("(Recommended)");
    expect(CANONICAL_TOOL_EXAMPLES).toContain("request_user_input");
    expect(PLAN_MODE_PROMPT).toContain("request_user_input");
    expect(PLAN_MODE_PROMPT).toContain("Interactive User Interview Wizard");
  });
});
