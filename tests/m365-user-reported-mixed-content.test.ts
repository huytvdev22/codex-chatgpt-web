import { describe, expect, test } from "bun:test";
import { parseStrictM365Response } from "../src/adapters/m365-copilot/translation";

describe("User reported cases for MIXED_TOOL_AND_TEXT_CONTENT and DISALLOWED_COMMAND", () => {
  // Case 1 nguyên văn
  const case1Raw = `<webResponse>

Mình hiểu rồi 👍

Codebase **\`codex-chatgpt-web\`** đang mở chính là lớp cầu nối giữa:

1. **Bạn** gửi yêu cầu trong giao diện web.
2. **Mình** trả về các lệnh có cấu trúc như \`<tool_call>\` hoặc \`<custom_tool_call>\`.
3. **Tool của bạn** bóc tách phản hồi, ánh xạ tên công cụ và tham số.
4. Tool thực thi thao tác thật trên máy cá nhân hoặc trong IDE.
5. Kết quả được gửi ngược lại cho mình qua \`<tool_result>\`.
6. Mình tiếp tục phân tích, sửa code, chạy kiểm tra và lặp lại cho đến khi hoàn tất.

Như vậy, khi làm việc trên chính codebase này, chúng ta đang **dùng cầu nối để phát triển và sửa chính cầu nối đó**. Mình sẽ đặc biệt cẩn thận với các phần liên quan đến parser, định dạng XML, vòng lặp thực thi và xử lý phản hồi để tránh làm gián đoạn kênh giao tiếp hiện tại.

Mình cũng đã hiểu rằng các công cụ được liệt kê trong prompt không phải công cụ mô phỏng. Chúng là giao thức thật mà dự án của bạn sẽ chuyển thành thao tác trên máy. Khi bạn giao một nhiệm vụ cụ thể, mình sẽ chủ động khảo sát codebase và làm việc qua đúng giao thức này.

</webResponse>`;

  // Case 1 biến thể text trần không bọc backtick quanh thẻ <tool_call>
  const case1RawNoBackticks = `<webResponse>

Mình hiểu rồi 👍

Codebase **codex-chatgpt-web** đang mở chính là lớp cầu nối giữa:

1. **Bạn** gửi yêu cầu trong giao diện web.
2. **Mình** trả về các lệnh có cấu trúc như <tool_call> hoặc <custom_tool_call>.
3. **Tool của bạn** bóc tách phản hồi, ánh xạ tên công cụ và tham số.
4. Tool thực thi thao tác thật trên máy cá nhân hoặc trong IDE.
5. Kết quả được gửi ngược lại cho mình qua <tool_result>.
6. Mình tiếp tục phân tích, sửa code, chạy kiểm tra và lặp lại cho đến khi hoàn tất.

Như vậy, khi làm việc trên chính codebase này, chúng ta đang **dùng cầu nối để phát triển và sửa chính cầu nối đó**. Mình sẽ đặc biệt cẩn thận với các phần liên quan đến parser, định dạng XML, vòng lặp thực thi và xử lý phản hồi để tránh làm gián đoạn kênh giao tiếp hiện tại.

Mình cũng đã hiểu rằng các công cụ được liệt kê trong prompt không phải công cụ mô phỏng. Chúng là giao thức thật mà dự án của bạn sẽ chuyển thành thao tác trên máy. Khi bạn giao một nhiệm vụ cụ thể, mình sẽ chủ động khảo sát codebase và làm việc qua đúng giao thức này.

</webResponse>`;

  // Case 2 nguyên văn
  const case2Raw = case1Raw;

  // Case 3 nguyên văn
  const case3Raw = `<webResponse>
✅ Tool call đã hoạt động thành công.

Lệnh PowerShell đã được thực thi tại thư mục dự án và trả về:

- **Exit code:** \`0\`
- **Output:** \`Tool call hoạt động thành công\`

Như vậy, cầu nối đã bóc tách đúng \`<tool_call>\`, thực thi lệnh trên máy và gửi kết quả trở lại cuộc trò chuyện thành công.
</webResponse>`;

  // Case 3 biến thể không backticks quanh <tool_call>
  const case3RawNoBackticks = `<webResponse>
✅ Tool call đã hoạt động thành công.

Lệnh PowerShell đã được thực thi tại thư mục dự án và trả về:

- **Exit code:** \`0\`
- **Output:** \`Tool call hoạt động thành công\`

Như vậy, cầu nối đã bóc tách đúng <tool_call>, thực thi lệnh trên máy và gửi kết quả trở lại cuộc trò chuyện thành công.
</webResponse>`;

  // Case 4 nguyên văn: Lệnh exec_command chứa vòng lặp $files = @(...) foreach (...) { Get-Content ... }
  const case4Raw = `<webResponse>
<tool_call>
{"name":"exec_command","arguments":{"cmd":"$ErrorActionPreference = 'Stop'; $files = @('docs/troubleshooting/010-m365-final-answer-envelope-false-positive.md','src/adapters/web/protocol/strict-response-parser.ts','src/adapters/m365-copilot/translation/strip-code-fence.ts','src/adapters/m365-copilot/translation/toolcall-detector.ts','src/adapters/m365-copilot/translation/output-translator.ts','tests/m365-strict-response-protocol.test.ts','tests/m365-output-translator.test.ts'); foreach ($file in $files) { if (Test-Path $file) { Write-Output \\"\`n===== $file =====\\"; Get-Content $file -Encoding UTF8 -Raw } }; Write-Output \\"\`n===== MIXED_TOOL_AND_TEXT_CONTENT REFERENCES =====\\"; Get-ChildItem src,tests -Recurse -File | Select-String -Pattern 'MIXED_TOOL_AND_TEXT_CONTENT|webResponse|tool_call|custom_tool_call' -CaseSensitive:$false | Select-Object Path,LineNumber,Line | Format-List","workdir":"D:\\\\HUYTVDEV\\\\codex-chatgpt-web","yield_time_ms":10000,"max_output_tokens":30000}}
</tool_call>
</webResponse>`;

  test("Kiểm thử Case 1 (Nguyên văn có inline code backticks): trả về final_answer", () => {
    const result = parseStrictM365Response(case1Raw);
    expect(result.kind).toBe("final_answer");
    if (result.kind === "final_answer") {
      expect(result.content).toContain("codex-chatgpt-web");
      expect(result.content).toContain("`<tool_call>`");
    }
  });

  test("Kiểm thử Case 1 biến thể (Không có inline code backticks quanh thẻ XML): trả về final_answer không bị chặn nhầm", () => {
    const result = parseStrictM365Response(case1RawNoBackticks);
    expect(result.kind).toBe("final_answer");
    if (result.kind === "final_answer") {
      expect(result.content).toContain("codex-chatgpt-web");
      expect(result.content).toContain("<tool_call>");
    }
  });

  test("Kiểm thử Case 2 (Nguyên văn): trả về final_answer", () => {
    const result = parseStrictM365Response(case2Raw);
    expect(result.kind).toBe("final_answer");
  });

  test("Kiểm thử Case 3 (Nguyên văn có inline code backticks): trả về final_answer", () => {
    const result = parseStrictM365Response(case3Raw);
    expect(result.kind).toBe("final_answer");
    if (result.kind === "final_answer") {
      expect(result.content).toContain("Tool call đã hoạt động thành công");
      expect(result.content).toContain("`<tool_call>`");
    }
  });

  test("Kiểm thử Case 3 biến thể (Không có inline code backticks quanh <tool_call>): trả về final_answer không bị chặn nhầm", () => {
    const result = parseStrictM365Response(case3RawNoBackticks);
    expect(result.kind).toBe("final_answer");
    if (result.kind === "final_answer") {
      expect(result.content).toContain("Tool call đã hoạt động thành công");
      expect(result.content).toContain("<tool_call>");
    }
  });

  test("Kiểm thử Case 4 (Lệnh shell chứa batch foreach reading): cho phép thực thi bình thường theo quyền tự chủ", () => {
    const result = parseStrictM365Response(case4Raw);
    expect(result.kind).toBe("tool_calls");
    if (result.kind === "tool_calls") {
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].name).toBe("exec_command");
      expect(result.calls[0].arguments.cmd).toContain("$files = @(");
      expect(result.calls[0].arguments.cmd).toContain("foreach ($file in $files)");
    }
  });

  test("Kiểm thử ví dụ tool call nằm trong Markdown code block: trả về final_answer an toàn", () => {
    const tutorialMarkdown = `<webResponse>
Bạn có thể tham khảo mẫu gọi công cụ sau:
\`\`\`xml
<tool_call>
{"name": "read_file", "arguments": {"path": "src/index.ts"}}
</tool_call>
\`\`\`
Mẫu trên giúp bạn đọc file.
</webResponse>`;
    const result = parseStrictM365Response(tutorialMarkdown);
    expect(result.kind).toBe("final_answer");
    if (result.kind === "final_answer") {
      expect(result.content).toContain("Bạn có thể tham khảo mẫu");
      expect(result.content).toContain("<tool_call>");
    }
  });
});
