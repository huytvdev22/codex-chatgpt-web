import { describe, expect, test } from "bun:test";
import { M365OutputTranslator, parseStrictM365Response } from "../src/adapters/m365-copilot/translation";

describe("M365 strict response protocol", () => {
  test("default output translator does not infer tools from shell fences or standalone JSON", () => {
    const translator = new M365OutputTranslator();
    expect(translator.translate("```bash\ngit status\n```").type).toBe("final_answer");
    expect(translator.translate('{"name":"exec_command","arguments":{"cmd":"git status"}}').type)
      .toBe("final_answer");
  });

  test("Markdown shell code fences remain final answer content", () => {
    const raw = `<m365Response>
## Lệnh mẫu

\`\`\`powershell
Invoke-RestMethod -Uri "https://YOUR_HOST/api"
\`\`\`
</m365Response>`;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("final_answer");
    if (result.kind === "final_answer") {
      expect(result.content).toContain("Invoke-RestMethod");
      expect(result.content).toEndWith("```");
    }
  });

  test("parses a complete atomic multi-tool batch", () => {
    const raw = `<m365Response>
<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>
<tool_call>{"name":"grep_code","arguments":{"query":"needle","path":"src"}}</tool_call>
</m365Response>`;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("tool_calls");
    if (result.kind === "tool_calls") {
      expect(result.calls).toHaveLength(2);
      expect(result.calls.map(call => call.name)).toEqual(["read_file", "grep_code"]);
    }
  });

  test("rejects whole batch when final tool call is truncated", () => {
    const raw = `<m365Response>
<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>
<tool_call>{"name":"grep_code","arguments":{"query":"needle","path":"src"}}
</m365Response>`;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("INCOMPLETE_TOOL_CALL");
    }
  });

  test("rejects mixed narrative and tool syntax instead of guessing intent", () => {
    const raw = `<m365Response>
Ví dụ tool call:
<tool_call>{"name":"exec_command","arguments":{"cmd":"git status"}}</tool_call>
</m365Response>`;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("MIXED_TOOL_AND_TEXT_CONTENT");
    }
  });

  test("rejects missing response root and standalone JSON", () => {
    expect(parseStrictM365Response('{"name":"exec_command","arguments":{"cmd":"git status"}}').kind)
      .toBe("protocol_error");
  });

  test("rejects malformed JSON without auto-healing", () => {
    const raw = `<m365Response>
<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}</tool_call>
</m365Response>`;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") expect(result.code).toBe("INVALID_TOOL_JSON");
  });

  test("requires complete apply_patch envelope", () => {
    const raw = `<m365Response>
<custom_tool_call name="apply_patch">
*** Begin Patch
*** Add File: a.txt
+hello
</custom_tool_call>
</m365Response>`;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") expect(result.code).toBe("INVALID_PATCH_ENVELOPE");
  });

  test("rejects truncated apply_patch carried inside function tool JSON", () => {
    const raw = `<m365Response>
<tool_call>{"name":"apply_patch","arguments":{"input":"*** Begin Patch\\n*** Add File: a.txt\\n+hello"}}</tool_call>
</m365Response>`;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") expect(result.code).toBe("INVALID_PATCH_ENVELOPE");
  });

  test("rejects truncated apply_patch aliases before tool-name normalization", () => {
    for (const name of ["applypatch", "functions.apply_patch"]) {
      const raw = `<m365Response>
<tool_call>{"name":"${name}","arguments":{"input":"*** Begin Patch\\n*** Add File: a.txt\\n+hello"}}</tool_call>
</m365Response>`;
      const result = parseStrictM365Response(raw);
      expect(result.kind).toBe("protocol_error");
      if (result.kind === "protocol_error") expect(result.code).toBe("INVALID_PATCH_ENVELOPE");
    }
  });

  test("rejects nested patch control envelopes", () => {
    const raw = `<m365Response>
<custom_tool_call name="apply_patch">
*** Begin Patch
*** Begin Patch
*** End Patch
*** End Patch
</custom_tool_call>
</m365Response>`;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") expect(result.code).toBe("INVALID_PATCH_ENVELOPE");
  });

  test("accepts exact outer 4-backtick transport wrapper", () => {
    const raw = `\`\`\`\`markdown
<m365Response>
Hoàn tất.
</m365Response>
\`\`\`\``;
    const result = parseStrictM365Response(raw);
    expect(result.kind).toBe("final_answer");
  });
});
