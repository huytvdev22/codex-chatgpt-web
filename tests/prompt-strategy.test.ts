import { describe, expect, test } from "bun:test";
import { CodexRawPayload, type CodexRawRequestWire } from "../src/adapters/m365-copilot/codex-raw-payload";
import { CodexPayloadNormalizer } from "../src/adapters/m365-copilot/codex-normalizer";
import {
  renderDynamicToolDeclarations,
  promptCompiler,
  calculatePromptMetrics,
  UNIFIED_TOOL_PROTOCOL,
} from "../src/adapters/m365-copilot/prompt-strategy";
import {
  compileM365HybridForwardPrompt,
  compileM365HybridForwardPromptWithResult,
  isPlanModeRequest,
} from "../src/adapters/m365-copilot/temp-chat/compileHybridForwardPrompt";
import type { CodexParsedRequest } from "../src/types";

describe("Unified M365 Prompt & Intelligence Preservation Tests", () => {
  const sampleRaw: CodexRawRequestWire = {
    model: "m365-copilot/think",
    tools: [
      {
        type: "function",
        name: "exec_command",
        description: "Runs a command in a PTY session",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
      },
      {
        type: "custom",
        name: "apply_patch",
        description: "Edit files using patch grammar",
      },
      {
        type: "function",
        name: "request_user_input",
        description: "Ask the user follow-up questions",
      },
      {
        type: "function",
        name: "create_goal",
        description: "Create a goal for tracking progress",
      },
      {
        type: "namespace",
        name: "web",
        tools: [
          {
            type: "function",
            name: "run",
            description: "Runs web browsing automation",
          },
        ],
      },
    ],
    input: [
      {
        type: "message",
        role: "developer",
        content:
          "<environment_context>cwd: /workspace/project</environment_context>\n" +
          "<permissions instructions>\nFilesystem sandboxing defines which files can be read or written. `sandbox_mode` is `workspace-write`...\n# Escalation Requests\nCommands are run outside the sandbox...\n</permissions instructions>\n" +
          "<collaboration_mode># Collaboration Mode: Default\n\nYou are now in Default mode.</collaboration_mode>\n" +
          "Tuân thủ nguyên lý SOLID và viết code sạch.",
      },
      {
        type: "message",
        role: "user",
        content: "Lượt trước: hãy kiểm tra status",
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "exec_command",
        arguments: '{"cmd":"git status"}',
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "On branch main, working tree clean",
      },
      {
        type: "message",
        role: "user",
        content: "Bây giờ hãy tạo mới file OrderDetailDTO.java",
        internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
      },
    ],
  };

  test("Phase 1: activeCodingTools bảo toàn 100% công cụ từ request", () => {
    const payload = CodexRawPayload.from(sampleRaw);
    const normalized = CodexPayloadNormalizer.normalize(payload);

    expect(normalized.tools.length).toBe(5);
    expect(normalized.activeCodingTools.length).toBe(5);

    const activeNames = normalized.activeCodingTools.map(t => t.identity.name);
    expect(activeNames).toContain("exec_command");
    expect(activeNames).toContain("apply_patch");
    expect(activeNames).toContain("request_user_input");
    expect(activeNames).toContain("create_goal");
    expect(activeNames).toContain("run"); // web.run
  });

  test("Phase 2: renderDynamicToolDeclarations sử dụng định dạng tool duy nhất", () => {
    const payload = CodexRawPayload.from(sampleRaw);
    const normalized = CodexPayloadNormalizer.normalize(payload);

    const dynamicText = renderDynamicToolDeclarations(normalized.activeCodingTools);

    expect(dynamicText).toContain("AVAILABLE TOOLS");
    expect(dynamicText).toContain("- exec_command");
    expect(dynamicText).toContain("- apply_patch");
    expect(dynamicText).toContain("- request_user_input");
    expect(dynamicText).toContain("- create_goal");
    expect(dynamicText).toContain("- web.run");

    // Không còn các tên alias tự chế hay lẫn lộn
    expect(dynamicText).not.toContain("run_command(cmd)");
    expect(dynamicText).not.toContain("write_file(path");
  });

  test("Yêu cầu 1: Loại bỏ mâu thuẫn Plan Mode / Default Mode (kể cả khi có request_user_input)", () => {
    // Request ở Default Mode nhưng có tool request_user_input
    const payload = CodexRawPayload.from(sampleRaw);
    const normalized = CodexPayloadNormalizer.normalize(payload);

    expect(normalized.collaborationMode).toBe("default");

    const mockParsed: CodexParsedRequest = {
      modelId: "m365-copilot/think",
      context: {
        messages: [],
        tools: [
          { type: "function", function: { name: "request_user_input" } } as any,
          { type: "function", function: { name: "exec_command" } } as any,
        ],
      },
      _rawBody: sampleRaw,
    };

    expect(isPlanModeRequest(mockParsed)).toBe(false);

    const result = compileM365HybridForwardPromptWithResult(mockParsed, sampleRaw);
    expect(result.collaborationMode).toBe("default");
    expect(result.isPlanMode).toBe(false);
    // TUYỆT ĐỐI KHÔNG chứa cảnh báo cấm sửa file của Plan Mode
    expect(result.finalPrompt).not.toContain("[CHẾ ĐỘ LẬP KẾ HOẠCH - CODEX PLAN MODE ĐANG BẬT]");
    expect(result.finalPrompt).not.toContain("TUYỆT ĐỐI KHÔNG CHỈNH SỬA CODE");
  });

  test("Yêu cầu 2: Rút gọn mạnh permissions + sandbox instructions khỏi prompt", () => {
    const payload = CodexRawPayload.from(sampleRaw);
    const normalized = CodexPayloadNormalizer.normalize(payload);

    // Kiểm tra developer instructions đã được lọc sạch
    const devText = (normalized.developerInstructions || []).join("\n");
    expect(devText).not.toContain("<permissions instructions>");
    expect(devText).not.toContain("Filesystem sandboxing defines which files can be read or written");
    expect(devText).not.toContain("Escalation Requests");
    expect(devText).toContain("Tuân thủ nguyên lý SOLID và viết code sạch.");

    const mockParsed: CodexParsedRequest = {
      modelId: "m365-copilot/think",
      context: { messages: [], tools: [] },
      _rawBody: sampleRaw,
    };

    const finalPrompt = compileM365HybridForwardPrompt(mockParsed, sampleRaw);
    expect(finalPrompt).not.toContain("<permissions instructions>");
    expect(finalPrompt).not.toContain("Escalation Requests");
  });

  test("Yêu cầu 3 & 4: Format tool duy nhất và in đầy đủ log planMode, collaborationMode, finalPromptLength", () => {
    const mockParsed: CodexParsedRequest = {
      modelId: "m365-copilot/think",
      context: { messages: [], tools: [] },
      _rawBody: sampleRaw,
    };

    const result = compileM365HybridForwardPromptWithResult(mockParsed, sampleRaw);

    // Format tool chuẩn duy nhất
    expect(result.finalPrompt).toContain(UNIFIED_TOOL_PROTOCOL);
    expect(result.finalPrompt).toContain("<custom_tool_call name=\"apply_patch\">");

    // Metrics và Audit
    expect(result.metrics.toolDeclaration).toBeGreaterThan(0);
    expect(result.finalPrompt.length).toBeGreaterThan(0);
    expect(result.audit.toolsCount).toBe(5);
    expect(result.audit.finalPromptChars).toBe(result.finalPrompt.length);
  });
});
