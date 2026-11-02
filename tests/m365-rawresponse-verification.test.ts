import { describe, expect, test } from "bun:test";
import { parseStrictM365Response } from "../src/adapters/m365-copilot/translation";
import { buildM365FormatRetryPrompt } from "../src/adapters/m365-copilot/prompts";
import { validateM365ToolCall } from "../src/adapters/m365-copilot/tools";

describe("M365 Raw Response Reproduction & Analysis", () => {
  test("tái hiện chính xác response thực tế từ M365: phát hiện thiếu transport wrapper 4-backtick và trả về MISSING_TRANSPORT_FENCE", () => {
    const actualM365Response = `<webResponse>
<tool_call>
{"name":"exec_command","arguments":{"cmd":"$ErrorActionPreference='Stop'; Write-Output '=== LEAD DIFF ==='; git diff -- src/main/java/vn/com/gpbank/corp/sale/lead/dto/bsp/response/CustomerCoreResponse.java src/main/java/vn/com/gpbank/corp/sale/lead/dto/request/TaskRequest.java; Write-Output '=== SQL PREVIEWS ==='; Get-Content .\\\\add_acquisition_source_to_program.sql -TotalCount 150; Write-Output '--- add_business_line_to_task.sql ---'; Get-Content .\\\\add_business_line_to_task.sql -TotalCount 150; Write-Output '--- clear_task_data.sql ---'; Get-Content .\\\\clear_task_data.sql -TotalCount 150; Write-Output '=== AUTH CANDIDATE PATHS ==='; Get-ChildItem ..\\\\corp-sale-auth-service\\\\src\\\\main\\\\java -Recurse -File -Filter '*.java' | Where-Object { $_.Name -in @('CustomerCoreResponse.java','TaskRequest.java') -or $_.FullName -match '\\\\\\\\dto\\\\\\\\(bsp\\\\\\\\response|request)\\\\\\\\' } | Select-Object -First 100 -ExpandProperty FullName; Write-Output '=== AUTH TOP LEVEL ==='; Get-ChildItem ..\\\\corp-sale-auth-service -Force | Select-Object Mode,Name","workdir":"D:\\\\GP\\\\2.WORK\\\\2.projects\\\\2.SalePortal\\\\corp-sale-lead-service","yield_time_ms":10000,"max_output_tokens":30000}}
</tool_call>
</webResponse>`;

    // Gọi parser nghiêm ngặt
    const result = parseStrictM365Response(actualM365Response);

    // BẮT BUỘC phải nhận diện là tool_calls hợp lệ vì có envelope <webResponse> hoàn chỉnh
    expect(result.kind).toBe("tool_calls");
    if (result.kind === "tool_calls") {
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].name).toBe("exec_command");
    }
  });

  test("tái hiện chính xác response từ M365 khi có text trần không bọc 4-backtick: trả về MISSING_TRANSPORT_FENCE", () => {
    const rawNoFence = "Đây là câu trả lời trần không có bọc gì cả.";
    const result = parseStrictM365Response(rawNoFence);

    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("MISSING_TRANSPORT_FENCE");
      expect(result.message).toContain("4-backtick");

      // Verify format retry prompt được sinh ra chính xác để hướng dẫn AI
      const retryPrompt = buildM365FormatRetryPrompt({
        code: result.code,
        message: result.message,
      });

      expect(retryPrompt).toContain("bạn gửi hơi lệch quy ước định dạng một chút");
      expect(retryPrompt).toContain("[MISSING_TRANSPORT_FENCE]");
      expect(retryPrompt).toContain("<webResponse>");
      expect(retryPrompt).toContain("````markdown");
    }
  });

  test("tái hiện chính xác response từ M365 khi có bọc 4-backtick nhưng thiếu envelope <webResponse>: trả về MISSING_RESPONSE_ENVELOPE", () => {
    // Model gửi khối code 4-backtick nhưng quên mở thẻ <webResponse>
    const rawFencedNoEnvelope = `\`\`\`\`markdown
<tool_call>
{"name": "exec_command", "arguments": {"cmd": "git status"}}
</tool_call>
\`\`\`\``;

    const result = parseStrictM365Response(rawFencedNoEnvelope);

    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("MISSING_RESPONSE_ENVELOPE");
      expect(result.message).toContain("Phản hồi không có root response envelope");
      expect(result.message).toContain("<tool_call>");

      // Verify format retry prompt
      const retryPrompt = buildM365FormatRetryPrompt({
        code: result.code,
        message: result.message,
      });

      expect(retryPrompt).toContain("[MISSING_RESPONSE_ENVELOPE]");
      expect(retryPrompt).toContain("<webResponse>");
    }
  });

  test("khi phản hồi chứa lệnh exec_command quét đệ quy Get-ChildItem -Recurse: cho phép model tự chủ tư duy và parse thành tool_call", () => {
    const raw = "````markdown\n<webResponse>\n<tool_call>\n{\"name\": \"exec_command\", \"arguments\": {\"cmd\": \"Write-Output '=== ROOT ==='; Get-ChildItem -Recurse | Select-Object Name\"}}\n</tool_call>\n</webResponse>\n````";
    const result = parseStrictM365Response(raw);

    // Đã bỏ chặn RECURSIVE_SCAN_DISALLOWED để model tự chủ tư duy
    expect(result.kind).toBe("tool_calls");
    if (result.kind === "tool_calls") {
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].name).toBe("exec_command");
      expect(result.calls[0].arguments.cmd).toContain("Get-ChildItem -Recurse");
    }
  });

  test("khi phản hồi chứa lệnh exec_command vi phạm batch read foreach: trả về DISALLOWED_COMMAND", () => {
    const raw = "````markdown\n<webResponse>\n<tool_call>\n{\"name\": \"exec_command\", \"arguments\": {\"cmd\": \"$files = @('a.java', 'b.java'); foreach ($f in $files) { Get-Content $f }\"}}\n</tool_call>\n</webResponse>\n````";
    const result = parseStrictM365Response(raw);

    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("DISALLOWED_COMMAND");
      expect(result.message).toContain("BATCH_READ_DISALLOWED");
    }
  });

  test("khi phản hồi chứa lệnh exec_command vi phạm wildcard read *.sql: trả về DISALLOWED_COMMAND", () => {
    const raw = "````markdown\n<webResponse>\n<tool_call>\n{\"name\": \"exec_command\", \"arguments\": {\"cmd\": \"Get-Content *.sql\"}}\n</tool_call>\n</webResponse>\n````";
    const result = parseStrictM365Response(raw);

    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("DISALLOWED_COMMAND");
      expect(result.message).toContain("WILDCARD_READ_DISALLOWED");
    }
  });

  test("tái hiện chính xác response thực tế từ M365: cho phép lệnh chứa Get-ChildItem -Recurse thực thi bình thường theo quyền tự chủ của model", () => {
    const actualM365Response = `<webResponse>
<tool_call>
{"name":"exec_command","arguments":{"cmd":"$ErrorActionPreference='Stop'; Write-Output '=== LEAD DIFF ==='; git diff -- src/main/java/vn/com/gpbank/corp/sale/lead/dto/bsp/response/CustomerCoreResponse.java src/main/java/vn/com/gpbank/corp/sale/lead/dto/request/TaskRequest.java; Write-Output '=== SQL PREVIEWS ==='; Get-Content .\\\\add_acquisition_source_to_program.sql -TotalCount 150; Write-Output '--- add_business_line_to_task.sql ---'; Get-Content .\\\\add_business_line_to_task.sql -TotalCount 150; Write-Output '--- clear_task_data.sql ---'; Get-Content .\\\\clear_task_data.sql -TotalCount 150; Write-Output '=== AUTH CANDIDATE PATHS ==='; Get-ChildItem ..\\\\corp-sale-auth-service\\\\src\\\\main\\\\java -Recurse -File -Filter '*.java' | Where-Object { $_.Name -in @('CustomerCoreResponse.java','TaskRequest.java') -or $_.FullName -match '\\\\\\\\dto\\\\\\\\(bsp\\\\\\\\response|request)\\\\\\\\' } | Select-Object -First 100 -ExpandProperty FullName; Write-Output '=== AUTH TOP LEVEL ==='; Get-ChildItem ..\\\\corp-sale-auth-service -Force | Select-Object Mode,Name","workdir":"D:\\\\GP\\\\2.WORK\\\\2.projects\\\\2.SalePortal\\\\corp-sale-lead-service","yield_time_ms":10000,"max_output_tokens":30000}}
</tool_call>
</webResponse>`;

    const result = parseStrictM365Response(actualM365Response);

    // Không còn bị reject vì Get-ChildItem -Recurse nữa
    expect(result.kind).toBe("tool_calls");
    if (result.kind === "tool_calls") {
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].name).toBe("exec_command");
      expect(result.calls[0].arguments.cmd).toContain("Get-ChildItem");
      expect(result.calls[0].arguments.cmd).toContain("-Recurse");
    }
  });

  test("khi M365 gọi công cụ không có trong clientTools: validateM365ToolCall trả về UNKNOWN_TOOL kèm danh sách tool khả dụng", () => {
    const activeClientTools = [
      { name: "read_file", description: "Read a file", parameters: {} },
      { name: "exec_command", description: "Run shell command", parameters: {} },
      { name: "apply_patch", description: "Apply a patch", parameters: {} },
    ] as any[];

    // write_stdin nằm trong BRIDGE_TOOLS tĩnh nhưng KHÔNG có trong activeClientTools của lượt này
    const validation = validateM365ToolCall("write_stdin", { session_id: 1, chars: "ls" }, activeClientTools);

    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.code).toBe("UNKNOWN_TOOL");
      expect(validation.message).toContain("Công cụ 'write_stdin' không được Codex IDE hỗ trợ");
      expect(validation.message).toContain("Các công cụ khả dụng: [read_file, exec_command, apply_patch]");

      // Verify format retry prompt tương ứng
      const retryPrompt = buildM365FormatRetryPrompt({
        code: validation.code,
        message: validation.message,
      });

      expect(retryPrompt).toContain("công cụ bạn vừa yêu cầu gọi không tồn tại");
      expect(retryPrompt).toContain("[UNKNOWN_TOOL]");
      expect(retryPrompt).toContain("chỉ sử dụng công cụ đang xuất hiện trong danh sách AVAILABLE TOOLS");
    }
  });

  test("khi M365 gọi công cụ hoàn toàn lạ: validateM365ToolCall phát hiện UNKNOWN_TOOL và hướng dẫn AI tự chọn lại", () => {
    const activeClientTools = [
      { name: "read_file", description: "Read a file", parameters: {} },
      { name: "list_dir", description: "List directory", parameters: {} },
    ] as any[];

    const validation = validateM365ToolCall("fetch_url_content", { url: "https://example.com" }, activeClientTools);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.code).toBe("UNKNOWN_TOOL");
      expect(validation.message).toContain("fetch_url_content");
      expect(validation.message).toContain("Các công cụ khả dụng: [read_file, list_dir]");
    }
  });
});
