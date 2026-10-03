import { describe, expect, test } from "bun:test";
import { CodexRawPayload, type CodexRawRequestWire } from "../src/adapters/m365-copilot/codex-raw-payload";
import { CodexPayloadNormalizer } from "../src/adapters/m365-copilot/codex-normalizer";

describe("CodexPayloadNormalizer Tests (Giai đoạn 2)", () => {
  test("Namespace preservation & lookup collision handling", () => {
    const raw: CodexRawRequestWire = {
      model: "m365-copilot/think",
      tools: [
        {
          type: "namespace",
          name: "web",
          tools: [
            { type: "function", name: "run", description: "Run web command", parameters: { type: "object" } },
            { type: "function", name: "search", description: "Search the web" },
          ],
        },
        {
          type: "namespace",
          name: "database",
          tools: [
            { type: "function", name: "run", description: "Run sql query", parameters: { type: "object" } },
          ],
        },
        {
          type: "function",
          name: "exec_command",
          description: "Runs terminal command",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" } },
            required: ["cmd"],
          },
        },
      ],
      input: [],
    };

    const payload = CodexRawPayload.from(raw);
    const normalized = CodexPayloadNormalizer.normalize(payload);

    // Kiểm tra danh sách tools trích xuất bảo toàn namespace
    expect(normalized.tools.length).toBe(4);
    const qualifiedNames = normalized.tools.map(t => t.identity.qualifiedName);
    expect(qualifiedNames).toContain("web.run");
    expect(qualifiedNames).toContain("web.search");
    expect(qualifiedNames).toContain("database.run");
    expect(qualifiedNames).toContain("exec_command");

    // 1. Lookup qualified name chính xác
    const resWeb = CodexPayloadNormalizer.resolveToolByName(normalized.tools, "web.run");
    expect(resWeb.tool?.identity.qualifiedName).toBe("web.run");
    expect(resWeb.ambiguous).toBeFalsy();

    // 2. Lookup short name duy nhất (exec_command) -> thành công
    const resExec = CodexPayloadNormalizer.resolveToolByName(normalized.tools, "exec_command");
    expect(resExec.tool?.identity.name).toBe("exec_command");
    expect(resExec.ambiguous).toBeFalsy();

    // 3. Lookup short name bị trùng (run có cả trong web và database) -> ambiguous = true
    const resAmbiguous = CodexPayloadNormalizer.resolveToolByName(normalized.tools, "run");
    expect(resAmbiguous.tool).toBeNull();
    expect(resAmbiguous.ambiguous).toBe(true);

    // 4. Lookup tool không tồn tại
    const resNotFound = CodexPayloadNormalizer.resolveToolByName(normalized.tools, "non_existent");
    expect(resNotFound.tool).toBeNull();
    expect(resNotFound.ambiguous).toBeFalsy();
  });

  test("Function Tool vs Custom Tool (apply_patch) separation", () => {
    const raw: CodexRawRequestWire = {
      model: "m365-copilot/think",
      input: [
        {
          type: "additional_tools",
          tools: [
            {
              type: "function",
              name: "exec_command",
              description: "Terminal runner",
              strict: true,
              parameters: {
                type: "object",
                properties: { cmd: { type: "string" } },
                required: ["cmd"],
              },
            },
            {
              type: "custom",
              name: "apply_patch",
              description: "Freeform patch editor",
              format: { type: "grammar", syntax: "lark", definition: "patch ::= ..." },
            },
          ],
        },
      ],
    };

    const payload = CodexRawPayload.from(raw);
    const normalized = CodexPayloadNormalizer.normalize(payload);

    expect(normalized.tools.length).toBe(2);

    const execTool = normalized.tools.find(t => t.identity.name === "exec_command");
    expect(execTool?.kind).toBe("function");
    if (execTool?.kind === "function") {
      expect(execTool.strict).toBe(true);
      expect(execTool.rawParameters).toEqual({
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
      });
    }

    const patchTool = normalized.tools.find(t => t.identity.name === "apply_patch");
    expect(patchTool?.kind).toBe("custom");
    if (patchTool?.kind === "custom") {
      expect(patchTool.format).toEqual({ type: "grammar", syntax: "lark", definition: "patch ::= ..." });
    }
  });

  test("Trailing Tool Results: Bỏ qua compaction_trigger và ghép đúng call_id với tool name", () => {
    const raw: CodexRawRequestWire = {
      model: "m365-copilot/think",
      input: [
        // Turn 1 cũ
        { type: "message", role: "user", content: "Lượt 1: kiểm tra file" },
        { type: "function_call", call_id: "call_old_1", name: "read_file", arguments: '{"path":"a.txt"}' },
        { type: "function_call_output", call_id: "call_old_1", output: "content of a.txt" },
        { type: "message", role: "assistant", content: "Tôi đã đọc xong file a.txt" },

        // Turn 2 hiện tại (vừa gọi tool và nhận kết quả)
        { type: "message", role: "user", content: "Lượt 2: chạy lệnh test" },
        { type: "function_call", call_id: "call_new_2", name: "exec_command", arguments: '{"cmd":"bun test"}' },
        { type: "function_call_output", call_id: "call_new_2", output: "Tests passed 10/10" },
        // Item control trong suốt xen giữa
        { type: "compaction_trigger" },
      ],
    };

    const payload = CodexRawPayload.from(raw);
    const normalized = CodexPayloadNormalizer.normalize(payload);

    // Chỉ lấy kết quả của turn mới nhất (Turn 2), bỏ qua Turn 1
    expect(normalized.trailingToolResults.length).toBe(1);
    expect(normalized.trailingToolResults[0].callId).toBe("call_new_2");
    expect(normalized.trailingToolResults[0].toolName).toBe("exec_command");
    expect(normalized.trailingToolResults[0].kind).toBe("function");
    expect(normalized.trailingToolResults[0].output).toBe("Tests passed 10/10");
  });

  test("User Prompt Deduplication: latestUserInstruction được tách biệt khỏi priorHistory", () => {
    const raw: CodexRawRequestWire = {
      model: "m365-copilot/think",
      input: [
        {
          type: "message",
          role: "user",
          content: "Yêu cầu cũ 1",
          internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
        },
        { type: "message", role: "assistant", content: "Phản hồi cũ 1" },
        {
          type: "message",
          role: "user",
          content: "<environment_context>cwd: /project</environment_context>",
          internal_chat_message_metadata_passthrough: { content_item_kinds: ["environments.environment_context"] },
        },
        {
          type: "message",
          role: "user",
          content: "Hãy sửa lỗi typo trong file readme.md",
          internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
        },
      ],
    };

    const payload = CodexRawPayload.from(raw);
    const normalized = CodexPayloadNormalizer.normalize(payload);

    // Latest user instruction lấy đúng user.text thật
    expect(normalized.latestUserInstruction).toBe("Hãy sửa lỗi typo trong file readme.md");

    // priorHistory KHÔNG chứa latest user instruction (không bị lặp lại)
    const priorContents = normalized.priorHistory.map(h => h.content);
    expect(priorContents).not.toContain("Hãy sửa lỗi typo trong file readme.md");
    expect(priorContents).toContain("Yêu cầu cũ 1");
    expect(priorContents).toContain("Phản hồi cũ 1");
  });

  test("activeCodingTools: Chỉ đưa write_stdin vào khi tool đó thực sự tồn tại trong turn", () => {
    // Request 1: KHÔNG có write_stdin
    const rawWithoutStdin: CodexRawRequestWire = {
      model: "m365-copilot/think",
      tools: [
        { type: "function", name: "exec_command", description: "Run cmd" },
        { type: "custom", name: "apply_patch", description: "Apply patch" },
        { type: "function", name: "weather", description: "Weather info" },
      ],
      input: [],
    };
    const norm1 = CodexPayloadNormalizer.normalize(CodexRawPayload.from(rawWithoutStdin));
    const activeNames1 = norm1.activeCodingTools.map(t => t.identity.name);
    expect(activeNames1).toContain("exec_command");
    expect(activeNames1).toContain("apply_patch");
    expect(activeNames1).not.toContain("write_stdin");
    expect(activeNames1).not.toContain("weather");

    // Request 2: CÓ write_stdin
    const rawWithStdin: CodexRawRequestWire = {
      model: "m365-copilot/think",
      tools: [
        { type: "function", name: "exec_command", description: "Run cmd" },
        { type: "function", name: "write_stdin", description: "Send stdin chars" },
      ],
      input: [],
    };
    const norm2 = CodexPayloadNormalizer.normalize(CodexRawPayload.from(rawWithStdin));
    const activeNames2 = norm2.activeCodingTools.map(t => t.identity.name);
    expect(activeNames2).toContain("exec_command");
    expect(activeNames2).toContain("write_stdin");
  });
});
