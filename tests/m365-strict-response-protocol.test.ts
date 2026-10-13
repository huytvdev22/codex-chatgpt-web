import { describe, expect, test } from "bun:test";
import { M365OutputTranslator, parseStrictM365Response } from "../src/adapters/base-web/translation";

describe("M365 strict response protocol", () => {
  test("default output translator does not infer tools from shell fences or standalone JSON", () => {
    const translator = new M365OutputTranslator();
    expect(translator.translate("```bash\ngit status\n```").type).toBe("final_answer");
    expect(translator.translate('{"name":"exec_command","arguments":{"cmd":"git status"}}').type)
      .toBe("final_answer");
  });

  test("Markdown shell code fences remain final answer content", () => {
    const raw = `<webResponse>
## Lệnh mẫu

\`\`\`powershell
Invoke-RestMethod -Uri "https://YOUR_HOST/api"
\`\`\`
</webResponse>`;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("final_answer");
    if (result.kind === "final_answer") {
      expect(result.content).toContain("Invoke-RestMethod");
      expect(result.content).toEndWith("```");
    }
  });

  test("parses a complete atomic multi-tool batch", () => {
    const raw = `<webResponse>
<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>
<tool_call>{"name":"grep_code","arguments":{"query":"needle","path":"src"}}</tool_call>
</webResponse>`;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("tool_calls");
    if (result.kind === "tool_calls") {
      expect(result.calls).toHaveLength(2);
      expect(result.calls.map(call => call.name)).toEqual(["read_file", "grep_code"]);
    }
  });

  test("rejects whole batch when final tool call is truncated", () => {
    const raw = `<webResponse>
<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>
<tool_call>{"name":"grep_code","arguments":{"query":"needle","path":"src"}}
</webResponse>`;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("INCOMPLETE_TOOL_CALL");
    }
  });

  test("rejects mixed narrative and tool syntax instead of guessing intent", () => {
    const raw = `<webResponse>
Ví dụ tool call:
<tool_call>{"name":"exec_command","arguments":{"cmd":"git status"}}</tool_call>
</webResponse>`;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("MIXED_TOOL_AND_TEXT_CONTENT");
    }
  });

  test("rejects plain final answers without the required transport fence", () => {
    const result = parseStrictM365Response("Đây là câu trả lời Markdown thông thường.");
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("MISSING_TRANSPORT_FENCE");
    }
  });

  test("rejects standalone JSON without the required transport fence", () => {
    const raw = '{"name":"exec_command","arguments":{"cmd":"git status"}}';
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("MISSING_TRANSPORT_FENCE");
    }
  });

  test("rejects an unfenced narrative final answer like the M365 UI regression", () => {
    const raw = `Mình chưa truy cập được repo của bạn từ môi trường hiện tại nên không thể đánh giá thực tế mã nguồn.

Để mình review nhanh, hãy gửi cây thư mục hoặc nội dung các file chính.`;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("MISSING_TRANSPORT_FENCE");
    }
  });

  test("accepts fenced plain final answers without response envelope", () => {
    const raw = `\`\`\`\`markdown
# Kết quả

Không cần gọi công cụ.
\`\`\`\``;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("final_answer");
    if (result.kind === "final_answer") {
      expect(result.content).toBe("# Kết quả\n\nKhông cần gọi công cụ.");
    }
  });

  test("rejects action syntax without response envelope", () => {
    const toolOpen = `${"<"}tool_call>`;
    const toolClose = `${"<"}/tool_call>`;
    const raw = `${toolOpen}{"name":"exec_command","arguments":{"cmd":"git status"}}${toolClose}`;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("MISSING_RESPONSE_ENVELOPE");
    }
  });

  test("rejects incomplete response envelope even for plain text", () => {
    const responseOpen = `${"<"}webResponse>`;
    const result = parseStrictM365Response(`${responseOpen}Câu trả lời chưa đóng envelope`);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("MISSING_RESPONSE_ENVELOPE");
    }
  });

  test("rejects patch markers without response envelope", () => {
    const raw = `*** Begin Patch
*** Add File: a.txt
+hello
*** End Patch`;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("MISSING_RESPONSE_ENVELOPE");
    }
  });

  test("rejects malformed JSON without auto-healing", () => {
    const raw = `<webResponse>
<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}</tool_call>
</webResponse>`;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") expect(result.code).toBe("INVALID_TOOL_JSON");
  });

  test("requires complete apply_patch envelope", () => {
    const raw = `<webResponse>
<custom_tool_call name="apply_patch">
*** Begin Patch
*** Add File: a.txt
+hello
</custom_tool_call>
</webResponse>`;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") expect(result.code).toBe("INVALID_PATCH_ENVELOPE");
  });

  test("rejects truncated apply_patch carried inside function tool JSON", () => {
    const raw = `<webResponse>
<tool_call>{"name":"apply_patch","arguments":{"input":"*** Begin Patch\\n*** Add File: a.txt\\n+hello"}}</tool_call>
</webResponse>`;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") expect(result.code).toBe("INVALID_PATCH_ENVELOPE");
  });

  test("rejects truncated apply_patch aliases before tool-name normalization", () => {
    for (const name of ["applypatch", "functions.apply_patch"]) {
      const raw = `<webResponse>
<tool_call>{"name":"${name}","arguments":{"input":"*** Begin Patch\\n*** Add File: a.txt\\n+hello"}}</tool_call>
</webResponse>`;
      const result = parseStrictM365Response(raw);
      expect(result.kind).toBe("protocol_error");
      if (result.kind === "protocol_error") expect(result.code).toBe("INVALID_PATCH_ENVELOPE");
    }
  });

  test("rejects nested patch control envelopes", () => {
    const raw = `<webResponse>
<custom_tool_call name="apply_patch">
*** Begin Patch
*** Begin Patch
*** End Patch
*** End Patch
</custom_tool_call>
</webResponse>`;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") expect(result.code).toBe("INVALID_PATCH_ENVELOPE");
  });

  test("accepts valid Add File patch when every content line starts with +", () => {
    const rootName = "webResponse";
    const customName = "custom_tool_call";
    const responseOpen = `<${rootName}>`;
    const responseClose = `</${rootName}>`;
    const actionOpen = `<${customName} name="apply_patch">`;
    const actionClose = `</${customName}>`;
    const patchBegin = ["***", "Begin", "Patch"].join(" ");
    const patchEnd = ["***", "End", "Patch"].join(" ");
    const addFile = ["***", "Add", "File:", "a.txt"].join(" ");
    const raw = [
      responseOpen,
      actionOpen,
      patchBegin,
      addFile,
      "+first line",
      "+",
      "+third line",
      patchEnd,
      actionClose,
      responseClose,
    ].join("\n");

    const result = parseStrictM365Response(raw);

    expect(result.kind).toBe("tool_calls");
    if (result.kind === "tool_calls") {
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]?.name).toBe("apply_patch");
    }
  });

  test("classifies invalid Add File line prefix as patch grammar error", () => {
    const rootName = "webResponse";
    const customName = "custom_tool_call";
    const responseOpen = `<${rootName}>`;
    const responseClose = `</${rootName}>`;
    const actionOpen = `<${customName} name="apply_patch">`;
    const actionClose = `</${customName}>`;
    const patchBegin = ["***", "Begin", "Patch"].join(" ");
    const patchEnd = ["***", "End", "Patch"].join(" ");
    const addFile = ["***", "Add", "File:", "a.txt"].join(" ");
    const raw = [
      responseOpen,
      actionOpen,
      patchBegin,
      addFile,
      "+first line",
      "missing plus prefix",
      "+third line",
      patchEnd,
      actionClose,
      responseClose,
    ].join("\n");

    const result = parseStrictM365Response(raw);

    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("INVALID_PATCH_GRAMMAR");
      expect(result.message).toContain("Add File");
      expect(result.message).toContain("dấu +");
    }
  });

  test("classifies Delete File content as patch grammar error", () => {
    const rootName = "webResponse";
    const customName = "custom_tool_call";
    const responseOpen = `<${rootName}>`;
    const responseClose = `</${rootName}>`;
    const actionOpen = `<${customName} name="apply_patch">`;
    const actionClose = `</${customName}>`;
    const patchBegin = ["***", "Begin", "Patch"].join(" ");
    const patchEnd = ["***", "End", "Patch"].join(" ");
    const deleteFile = ["***", "Delete", "File:", "a.txt"].join(" ");
    const raw = [
      responseOpen,
      actionOpen,
      patchBegin,
      deleteFile,
      "+unexpected content",
      patchEnd,
      actionClose,
      responseClose,
    ].join("\n");

    const result = parseStrictM365Response(raw);

    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("INVALID_PATCH_GRAMMAR");
      expect(result.message).toContain("Delete File");
    }
  });

  test("accepts exact outer 4-backtick transport wrapper", () => {
    const raw = `\`\`\`\`markdown
<webResponse>
Hoàn tất.
</webResponse>
\`\`\`\``;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("final_answer");
  });

  test("reports readable marker syntax instead of internal enum codes when envelope is missing", () => {
    const raw = `\`\`\`\`markdown
Dưới đây là bản vá:
<webResponse>
<custom_tool_call name="apply_patch">
*** Begin Patch
*** Update File: a.ts
@@ anchor @@
-old
+new
*** End Patch
</custom_tool_call>
\`\`\`\``;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("MISSING_RESPONSE_ENVELOPE");
      // Phải chứa cú pháp thực tế
      expect(result.message).toContain('<custom_tool_call name="apply_patch">');
      expect(result.message).toContain("*** Begin Patch");
      expect(result.message).toContain("<webResponse>");
      // Tuyệt đối không chứa enum nội bộ
      expect(result.message).not.toContain("CUSTOM_ACTION_OPEN");
      expect(result.message).not.toContain("PATCH_BEGIN");
      expect(result.message).not.toContain("ROOT_OPEN");
      // Chẩn đoán thiếu thẻ đóng
      expect(result.message).toContain("THIẾU thẻ đóng </webResponse>");
      // Chứa mẫu chuẩn của apply_patch
      expect(result.message).toContain("Mẫu chuẩn bắt buộc khi gọi apply_patch:");
    }
  });

  test("diagnoses narrative text outside envelope when both open and close tags exist", () => {
    const raw = `\`\`\`\`markdown
Lời dẫn trước envelope:
<webResponse>
<custom_tool_call name="apply_patch">
*** Begin Patch
*** Update File: a.ts
@@ anchor @@
-old
+new
*** End Patch
</custom_tool_call>
</webResponse>
\`\`\`\``;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("MISSING_RESPONSE_ENVELOPE");
      expect(result.message).toContain("BÊN NGOÀI cặp thẻ <webResponse>...</webResponse>");
    }
  });

  test("hỗ trợ chuẩn xác và đồng chất webResponse envelope cho tool calls", () => {
    const raw = "````markdown\n<webResponse>\n<tool_call>\n{\"name\": \"exec_command\", \"arguments\": {\"cmd\": \"ls -la\"}}\n</tool_call>\n</webResponse>\n````";
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("tool_calls");
    if (result.kind === "tool_calls") {
      expect(result.calls.length).toBe(1);
      expect(result.calls[0].name).toBe("exec_command");
    }
  });

  test("chẩn đoán lỗi thiếu thẻ đóng </webResponse>", () => {
    const raw = "````markdown\n<webResponse>\n<tool_call>\n{\"name\": \"exec_command\", \"arguments\": {\"cmd\": \"pwd\"}}\n</tool_call>\n````";
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("MISSING_RESPONSE_ENVELOPE");
      expect(result.message).toContain("THIẾU thẻ đóng </webResponse>");
    }
  });
});
