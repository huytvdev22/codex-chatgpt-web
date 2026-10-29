import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { parseStrictM365Response } from "../src/adapters/m365-copilot/translation/strict-response-parser";
import { buildM365FormatRetryPrompt } from "../src/adapters/m365-copilot/prompts/format-retry";
import { validateM365ToolCall } from "../src/adapters/m365-copilot/tools/tool-validator";

describe("M365 Raw Response Reproduction & Analysis", () => {
  let rawContent = "";
  const rawFilePath = path.resolve(".m365_conversation/m365-rawressponse.txt");
  if (fs.existsSync(rawFilePath)) {
    rawContent = fs.readFileSync(rawFilePath, "utf-8").trim();
  }

  // Nếu file text bị xóa hoặc rỗng, trích xuất từ snapshot m365-resposne-element.html
  if (!rawContent) {
    const htmlPath = path.resolve(".m365_conversation/m365-resposne-element.html");
    if (fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, "utf-8");
      const regex = /<div\s+data-line-index="(\d+)"[^>]*>([\s\S]*?)<\/div>/g;
      let m;
      const map = new Map<number, string>();
      while ((m = regex.exec(html)) !== null) {
        const idx = parseInt(m[1], 10);
        let text = m[2]
          .replace(/<[^>]+>/g, "")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, "\"")
          .replace(/\u00a0/g, " ")
          .replace(/\r?\n\s*/g, " ");
        map.set(idx, text);
      }
      const keys = Array.from(map.keys()).sort((a, b) => a - b);
      const lines: string[] = [];
      for (let i = keys[0]; i <= keys[keys.length - 1]; i++) {
        lines.push(map.get(i) ?? "");
      }
      rawContent = lines.join("\n").replace(/^\n+|\n+$/g, "");
    }
  }

  test("khi phản hồi đầy đủ 465 dòng: parseStrictM365Response thành công và trích xuất đúng tool call apply_patch", () => {
    if (!rawContent) return;
    const result = parseStrictM365Response(rawContent);

    // Không được báo lỗi protocol
    expect(result.kind).toBe("tool_calls");

    if (result.kind === "tool_calls") {
      expect(result.calls).toHaveLength(1);
      const call = result.calls[0];
      expect(call.name).toBe("apply_patch");
      expect(typeof call.arguments.input).toBe("string");

      const patch = call.arguments.input as string;
      expect(patch).toStartWith("*** Begin Patch");
      expect(patch).toEndWith("*** End Patch");
      expect(patch).toContain("*** Add File: corp-sale-lead-service/src/main/java/vn/com/gpbank/corp/sale/lead/service/impl/TaskImportServiceImpl.java");
      expect(patch).toContain("+package vn.com.gpbank.corp.sale.lead.service.impl;");
      expect(patch).toContain("+public class TaskImportServiceImpl implements TaskImportService {");
    }
  });

  test("khi phản hồi bị cắt tại dòng 74 (do DOM Virtualization của M365 UI): tái hiện CHÍNH XÁC lỗi MISSING_RESPONSE_ENVELOPE", () => {
    if (!rawContent) return;
    const lines = rawContent.split("\n");
    const truncatedContent = lines.slice(0, 74).join("\n");

    const result = parseStrictM365Response(truncatedContent);

    expect(result.kind).toBe("protocol_error");

    if (result.kind === "protocol_error") {
      expect(result.code).toBe("MISSING_RESPONSE_ENVELOPE");

      expect(result.message).toContain("Phản hồi không có root response envelope hợp lệ nhưng chứa reserved control marker.");
      expect(result.message).toContain("Các cú pháp điều khiển được phát hiện trong phản hồi: <custom_tool_call name=\"apply_patch\">, *** Begin Patch, <webResponse>.");
      expect(result.message).toContain("Chẩn đoán lỗi: Bạn đã mở thẻ <webResponse> nhưng THIẾU thẻ đóng </webResponse> ở cuối phản hồi.");

      const retryPrompt = buildM365FormatRetryPrompt({
        code: result.code,
        message: result.message,
      });

      expect(retryPrompt).toContain("Bạn ơi, tin nhắn vừa rồi bạn gửi hơi lệch quy ước định dạng một chút");
      expect(retryPrompt).toContain("[MISSING_RESPONSE_ENVELOPE]");
    }
  });

  test("khi phản hồi thiếu thẻ đóng </webResponse> nhưng có đủ patch: vẫn kích hoạt MISSING_RESPONSE_ENVELOPE", () => {
    if (!rawContent) return;
    const lines = rawContent.split("\n");
    const missingClosingRoot = lines.slice(0, lines.length - 1).join("\n");

    const result = parseStrictM365Response(missingClosingRoot);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("MISSING_RESPONSE_ENVELOPE");
      expect(result.message).toContain("<custom_tool_call name=\"apply_patch\">");
      expect(result.message).toContain("</custom_tool_call>");
      expect(result.message).toContain("*** Begin Patch");
      expect(result.message).toContain("*** End Patch");
      expect(result.message).toContain("<webResponse>");
    }
  });

  test("khi phản hồi chứa lệnh exec_command vi phạm quy tắc quét đệ quy: trả về DISALLOWED_COMMAND tường minh", () => {
    const raw = "````markdown\n<webResponse>\n<tool_call>\n{\"name\": \"exec_command\", \"arguments\": {\"cmd\": \"Write-Output '=== ROOT ==='; Get-ChildItem -Recurse | Select-Object Name\"}}\n</tool_call>\n</webResponse>\n````";
    const result = parseStrictM365Response(raw);

    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("DISALLOWED_COMMAND");
      expect(result.message).toContain("RECURSIVE_SCAN_DISALLOWED");
      expect(result.message).toContain("Recursive directory scan");

      const retryPrompt = buildM365FormatRetryPrompt({
        code: result.code,
        message: result.message,
      });

      expect(retryPrompt).toContain("câu lệnh shell bạn yêu cầu vừa bị chính sách an toàn của IDE từ chối");
      expect(retryPrompt).toContain("[DISALLOWED_COMMAND]");
      expect(retryPrompt).toContain("inventory hiện tại");
      expect(retryPrompt).toContain("exec_command");
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

  test("tái hiện chính xác response thực tế từ M365: phát hiện vi phạm RECURSIVE_SCAN_DISALLOWED và trả về DISALLOWED_COMMAND an toàn", () => {
    const actualM365Response = `<webResponse>
<tool_call>
{"name":"exec_command","arguments":{"cmd":"$ErrorActionPreference='Stop'; Write-Output '=== LEAD DIFF ==='; git diff -- src/main/java/vn/com/gpbank/corp/sale/lead/dto/bsp/response/CustomerCoreResponse.java src/main/java/vn/com/gpbank/corp/sale/lead/dto/request/TaskRequest.java; Write-Output '=== SQL PREVIEWS ==='; Get-Content .\\\\add_acquisition_source_to_program.sql -TotalCount 150; Write-Output '--- add_business_line_to_task.sql ---'; Get-Content .\\\\add_business_line_to_task.sql -TotalCount 150; Write-Output '--- clear_task_data.sql ---'; Get-Content .\\\\clear_task_data.sql -TotalCount 150; Write-Output '=== AUTH CANDIDATE PATHS ==='; Get-ChildItem ..\\\\corp-sale-auth-service\\\\src\\\\main\\\\java -Recurse -File -Filter '*.java' | Where-Object { $_.Name -in @('CustomerCoreResponse.java','TaskRequest.java') -or $_.FullName -match '\\\\\\\\dto\\\\\\\\(bsp\\\\\\\\response|request)\\\\\\\\' } | Select-Object -First 100 -ExpandProperty FullName; Write-Output '=== AUTH TOP LEVEL ==='; Get-ChildItem ..\\\\corp-sale-auth-service -Force | Select-Object Mode,Name","workdir":"D:\\\\GP\\\\2.WORK\\\\2.projects\\\\2.SalePortal\\\\corp-sale-lead-service","yield_time_ms":10000,"max_output_tokens":30000}}
</tool_call>
</webResponse>`;

    const result = parseStrictM365Response(actualM365Response);

    // Không được để lọt thành tool_calls hợp lệ (vì lệnh chứa Get-ChildItem ... -Recurse)
    // Và phải trả về protocol_error với mã DISALLOWED_COMMAND
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("DISALLOWED_COMMAND");
      expect(result.message).toContain("RECURSIVE_SCAN_DISALLOWED");
      expect(result.message).toContain("Recursive directory scan across the repository is disallowed");

      const retryPrompt = buildM365FormatRetryPrompt({
        code: result.code,
        message: result.message,
      });

      expect(retryPrompt).toContain("câu lệnh shell bạn yêu cầu vừa bị chính sách an toàn của IDE từ chối");
      expect(retryPrompt).toContain("[DISALLOWED_COMMAND]");
      expect(retryPrompt).toContain("inventory hiện tại");
      expect(retryPrompt).toContain("exec_command");
    }
  });

  test("khi M365 gọi công cụ không có trong clientTools: validateM365ToolCall trả về UNKNOWN_TOOL kèm danh sách tool khả dụng", () => {
    const activeClientTools = [
      { name: "read_file", description: "Read a file", parameters: {} },
      { name: "exec_command", description: "Run shell command", parameters: {} },
      { name: "apply_patch", description: "Apply a patch", parameters: {} },
    ] as any[];

    // write_stdin nằm trong BRIDGE_TOOLS tĩnh nhưng KHÔNG có trong activeClientTools của lượt này
    const result = validateM365ToolCall("write_stdin", { session_id: 1, chars: "ls" }, activeClientTools);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_TOOL");
      expect(result.message).toContain("Công cụ 'write_stdin' không được Codex IDE hỗ trợ");
      expect(result.message).toContain("Các công cụ khả dụng: [read_file, exec_command, apply_patch]");

      const retryPrompt = buildM365FormatRetryPrompt({
        code: result.code,
        message: result.message,
      });

      expect(retryPrompt).toContain("công cụ bạn vừa yêu cầu gọi không tồn tại hoặc không được Codex IDE hỗ trợ");
      expect(retryPrompt).toContain("[UNKNOWN_TOOL]");
      expect(retryPrompt).toContain("read_file");
      expect(retryPrompt).toContain("apply_patch");
    }
  });

  test("khi M365 gọi công cụ hoàn toàn lạ: validateM365ToolCall phát hiện UNKNOWN_TOOL và hướng dẫn AI tự chọn lại", () => {
    const activeClientTools = [
      { name: "read_file", description: "Read a file", parameters: {} },
      { name: "list_dir", description: "List directory", parameters: {} },
    ] as any[];

    const result = validateM365ToolCall("fetch_url_content", { url: "https://example.com" }, activeClientTools);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_TOOL");
      expect(result.message).toContain("fetch_url_content");
      expect(result.message).toContain("Các công cụ khả dụng: [read_file, list_dir]");
    }
  });
});



