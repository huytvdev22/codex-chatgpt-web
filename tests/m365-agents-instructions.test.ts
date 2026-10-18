import { describe, expect, test } from "bun:test";
import { CodexPayloadNormalizer } from "../src/adapters/m365-copilot/normalization/codex-normalizer";
import { CodexRawPayload } from "../src/adapters/m365-copilot/normalization/codex-raw-payload";
import { promptCompiler } from "../src/adapters/m365-copilot/prompts/compiler";

describe("M365 & ChatGPT Web AGENTS.md Instructions Extraction Tests", () => {
  test("Trích xuất thành công AGENTS.md khi Codex gửi role user kèm environment_context", () => {
    const rawPayload: any = {
      model: "chatgpt-web",
      input: [
        {
          type: "message",
          id: "msg_preamble",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "# AGENTS.md instructions for /Users/huytv/IdeaProjects/1.m365-codex/test-5\n\n<INSTRUCTIONS>\n# Project Agent Instructions\n\n## Project Overview\nTodoDay is a simple todo web app.\n\n## Guidelines\n- Luôn kiểm tra file trước khi sửa.\n- Không dùng python.\n</INSTRUCTIONS>",
            },
            {
              type: "input_text",
              text: "<environment_context>\n  <cwd>/Users/huytv/IdeaProjects/1.m365-codex/test-5</cwd>\n  <shell>zsh</shell>\n</environment_context>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            turn_id: "01a14fd6-1968-72a2-bff6-41b7f5b3247e",
            content_item_kinds: [
              "agents_md.instructions",
              "environments.environment_context",
            ],
          },
        },
        {
          type: "message",
          id: "msg_user_request",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "# Context from my IDE setup:\n\n## Open tabs:\n- agents.md: agents.md\n\n## My request:\nxin chào",
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "exec_command",
          description: "Run command",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        },
      ],
    };

    const payload = CodexRawPayload.from(rawPayload);
    const normalized = CodexPayloadNormalizer.normalize(payload);

    // 1. Kiểm tra developerInstructions được trích xuất
    expect(normalized.developerInstructions).toBeDefined();
    expect(normalized.developerInstructions?.length).toBeGreaterThan(0);
    const inst = normalized.developerInstructions?.[0] || "";
    expect(inst).toContain("TodoDay is a simple todo web app");
    expect(inst).toContain("Luôn kiểm tra file trước khi sửa");

    // 2. Kiểm tra priorHistory không bị ô nhiễm bởi tin nhắn preamble này
    expect(normalized.priorHistory.length).toBe(0);

    // 3. Kiểm tra environmentContext vẫn được trích xuất chính xác
    expect(normalized.environmentContext).toContain("/Users/huytv/IdeaProjects/1.m365-codex/test-5");

    // 4. Kiểm tra Prompt Compiler biên dịch đầy đủ vào lượt đầu tiên (FIRST_HANDSHAKE)
    const compileResult = promptCompiler.compile({
      normalized,
      parsed: { context: { messages: [] }, options: {} } as any,
      isNewConversation: true,
      assistantName: "ChatGPT",
    });

    expect(compileResult.finalPrompt).toContain("[Một số quy ước làm việc trong dự án của mình]");
    expect(compileResult.finalPrompt).toContain("TodoDay is a simple todo web app");
    expect(compileResult.finalPrompt).toContain("Luôn kiểm tra file trước khi sửa");
    expect(compileResult.finalPrompt).toContain("[Thư mục làm việc trên máy mình]");
    expect(compileResult.finalPrompt).toContain("[Yêu cầu cụ thể của mình]:\nxin chào");
  });

  test("Trích xuất AGENTS.md khi Codex gửi role developer riêng biệt", () => {
    const rawPayload: any = {
      model: "gpt-5.6-sol",
      input: [
        {
          type: "message",
          role: "developer",
          content: "<INSTRUCTIONS>\nQuy tắc: Luôn phản hồi bằng tiếng Việt.\n</INSTRUCTIONS>",
        },
        {
          type: "message",
          role: "user",
          content: "Tôi muốn thêm tính năng mới",
        },
      ],
      tools: [],
    };

    const payload = CodexRawPayload.from(rawPayload);
    const normalized = CodexPayloadNormalizer.normalize(payload);

    expect(normalized.developerInstructions).toBeDefined();
    expect(normalized.developerInstructions?.some(i => i.includes("Luôn phản hồi bằng tiếng Việt"))).toBe(true);

    const compileResult = promptCompiler.compile({
      normalized,
      parsed: { context: { messages: [] }, options: {} } as any,
      isNewConversation: true,
      assistantName: "Copilot",
    });

    expect(compileResult.finalPrompt).toContain("[Một số quy ước làm việc trong dự án của mình]");
    expect(compileResult.finalPrompt).toContain("Luôn phản hồi bằng tiếng Việt");
  });
});
