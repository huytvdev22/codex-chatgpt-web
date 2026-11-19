import { describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { encodeCompactionSummary } from "../src/responses/compaction";
import { CodexRawPayload, type CodexRawRequestWire } from "../src/adapters/web/normalization/codex-raw-payload";
import { CodexPayloadNormalizer } from "../src/adapters/web/normalization/codex-normalizer";

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

  test("activeCodingTools: Bảo toàn toàn bộ công cụ thực sự có mặt trong request (Loại bỏ whitelist cứng)", () => {
    // Request 1: KHÔNG có write_stdin nhưng CÓ weather, exec_command, apply_patch
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
    expect(activeNames1).toContain("weather"); // Đã bảo toàn weather thay vì bị lọc bởi whitelist cũ
    expect(activeNames1).not.toContain("write_stdin");

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

    // Request 3: Chứa toàn bộ các công cụ Codex nâng cao (request_user_input, goals, web.run, tool_search)
    const rawWithAdvancedTools: CodexRawRequestWire = {
      model: "m365-copilot/think",
      tools: [
        { type: "function", name: "request_user_input", description: "Ask user" },
        { type: "function", name: "create_goal", description: "Create goal" },
        { type: "function", name: "update_goal", description: "Update goal" },
        { type: "function", name: "get_goal", description: "Get goal" },
        { type: "function", name: "tool_search", description: "Search tools" },
        {
          type: "namespace",
          name: "web",
          tools: [
            { type: "function", name: "run", description: "Run web command" },
          ],
        },
      ],
      input: [],
    };
    const norm3 = CodexPayloadNormalizer.normalize(CodexRawPayload.from(rawWithAdvancedTools));
    const activeNames3 = norm3.activeCodingTools.map(t => t.identity.name);
    expect(activeNames3).toContain("request_user_input");
    expect(activeNames3).toContain("create_goal");
    expect(activeNames3).toContain("update_goal");
    expect(activeNames3).toContain("get_goal");
    expect(activeNames3).toContain("tool_search");
    expect(activeNames3).toContain("run"); // web.run
    expect(norm3.activeCodingTools.some(t => t.identity.qualifiedName === "web.run")).toBe(true);
    expect(norm3.activeCodingTools.length).toBe(6);
  });

  test("Codex Desktop wire parity: bảo toàn tool_search không có name, deferredNamespaces, tool_search_output, view_image và lọc resize notice", () => {
    const validPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFElEQVR42mNk+M9Qz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC";
    const rawWire: CodexRawRequestWire = {
      model: "m365-copilot/gpt-5.6",
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "functions",
              tools: [
                { type: "function", name: "exec_command", description: "Run shell" },
                { type: "custom", name: "apply_patch", description: "Apply patch" },
                { type: "function", name: "view_image", description: "View image" },
              ],
            },
            {
              type: "namespace",
              name: "mcp__python",
              tools: [
                { type: "custom", name: "run_script", description: "Should stay hidden per responses_lite contract" },
              ],
            },
            {
              type: "tool_search",
              execution: "client",
            },
          ],
        },
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<tools>\nDeferred tool namespaces:\n- multi_agent_v1: Tools for spawning and managing sub-agents.\n</tools>",
            },
            {
              type: "input_text",
              text: "<image_resize_notice>\nImage 1 of 1 was resized.\n</image_resize_notice>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["tools.deferred_namespaces", "images.resize_notice"],
          },
        },
        {
          type: "compaction",
          encrypted_content: encodeCompactionSummary("Người dùng đang refactor Web Adapter."),
        },
        {
          type: "agent_message",
          author: "worker_1",
          recipient: "main",
          content: "Đã kiểm tra xong DOM observer.",
        },
        {
          type: "message",
          role: "user",
          content: "Mở khóa subagent và xem ảnh",
          internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
        },
        {
          type: "tool_search_call",
          call_id: "call_ts_1",
          arguments: { query: "multi_agent_v1" },
        },
        {
          type: "tool_search_output",
          call_id: "call_ts_1",
          status: "completed",
          tools: [
            {
              type: "namespace",
              name: "multi_agent_v1",
              tools: [
                { type: "function", name: "spawn_agent", description: "Spawn sub-agent", parameters: { type: "object" } },
              ],
            },
          ],
        },
        {
          type: "function_call",
          call_id: "call_img_1",
          name: "view_image",
          arguments: '{"path":"screenshot.png"}',
        },
        {
          type: "function_call_output",
          call_id: "call_img_1",
          output: [
            { type: "input_text", text: "Loaded image" },
            { type: "input_image", image_url: validPng, detail: "high" },
          ],
        },
      ],
    };

    const parsed = parseRequest(rawWire);
    const normalized = CodexPayloadNormalizer.normalize(CodexRawPayload.from(rawWire), { parsed });

    const names = normalized.activeCodingTools.map(t => t.identity.qualifiedName);
    expect(names).toContain("tool_search");
    expect(names).toContain("multi_agent_v1.spawn_agent");
    expect(names).not.toContain("mcp__python.run_script");

    expect(normalized.deferredNamespaces).toEqual([
      "multi_agent_v1: Tools for spawning and managing sub-agents.",
    ]);
    expect(normalized.developerInstructions).toBeUndefined();
    expect(normalized.priorHistory.some(h => h.content.includes("resize"))).toBe(false);
    expect(normalized.priorHistory.some(h => h.content.includes("Người dùng đang refactor Web Adapter"))).toBe(true);
    expect(normalized.priorHistory.some(h => h.content.includes("worker_1 -> main"))).toBe(true);

    expect(normalized.trailingToolResults.length).toBe(1);
    expect(normalized.trailingToolResults[0].toolName).toBe("view_image");
    expect(normalized.trailingToolResults[0].output).toContain("[image attached (high)]");
    expect(normalized.trailingToolResults[0].output).not.toContain("data:image/png;base64");
    expect(normalized.images?.length).toBe(1);

    // Fallback raw-only (không truyền parsed) cũng phải xử lý đồng nhất tool_search & tool_search_output
    const rawOnlyNorm = CodexPayloadNormalizer.normalize(CodexRawPayload.from(rawWire));
    const rawOnlyNames = rawOnlyNorm.activeCodingTools.map(t => t.identity.qualifiedName);
    expect(rawOnlyNames).toContain("tool_search");
    expect(rawOnlyNames).toContain("multi_agent_v1.spawn_agent");
    expect(rawOnlyNames).not.toContain("mcp__python.run_script");
  });
});
