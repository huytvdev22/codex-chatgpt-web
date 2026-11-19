import { describe, expect, test } from "bun:test";
import {
  compileWebPrompt,
  isPlanModeRequest,
  isImplementingPlanRequest,
  PLAN_MODE_PROMPT,
  IMPLEMENT_PLAN_PROMPT,
  IMPLEMENT_PLAN_CONTINUATION_PROMPT,
  TOOL_REMINDER_PROMPT,
  SHORT_OUTPUT_FORMAT_ANCHOR,
  SHORT_OUTPUT_FORMAT_PLAN_ANCHOR,
} from "../src/adapters/web";
import { WebOutputTranslator } from "../src/adapters/web/protocol";
import type { CodexParsedRequest } from "../src/types";

function compileM365PromptViaWebCompiler(
  parsed: CodexParsedRequest,
  isNewConversation = true,
): string {
  return compileWebPrompt(parsed, {
    assistantName: "M365",
    isNewConversation,
  }).finalPrompt;
}

describe("M365 Plan Mode Support", () => {
  test("isPlanModeRequest detects plan mode from developer collaboration_mode block", () => {
    const parsed: CodexParsedRequest = {
      modelId: "m365-copilot/gpt-5",
      stream: false,
      options: {},
      context: {
        messages: [
          {
            role: "developer",
            content: "<collaboration_mode># Plan Mode (Conversational)\nWrap plan in <proposed_plan></collaboration_mode>",
            timestamp: Date.now(),
          },
          {
            role: "user",
            content: "Thêm hàm tính median vào math.js",
            timestamp: Date.now(),
          },
        ],
      },
    };

    expect(isPlanModeRequest(parsed)).toBe(true);
    expect(isImplementingPlanRequest(parsed)).toBe(false);
  });

  test("isPlanModeRequest detects plan mode from _rawBody collaboration_mode", () => {
    const parsed: CodexParsedRequest = {
      modelId: "m365-copilot/gpt-5",
      stream: false,
      options: {},
      _rawBody: {
        collaboration_mode: { mode: "plan" },
      },
      context: {
        messages: [
          {
            role: "user",
            content: "Lập kế hoạch tái cấu trúc",
            timestamp: Date.now(),
          },
        ],
      },
    };

    expect(isPlanModeRequest(parsed)).toBe(true);
    expect(isImplementingPlanRequest(parsed)).toBe(false);
  });

  test("isPlanModeRequest returns false for normal non-plan request", () => {
    const parsed: CodexParsedRequest = {
      modelId: "m365-copilot/gpt-5",
      stream: false,
      options: {},
      context: {
        messages: [
          {
            role: "user",
            content: "Sửa hàm add trong math.js",
            timestamp: Date.now(),
          },
        ],
      },
    };

    expect(isPlanModeRequest(parsed)).toBe(false);
    expect(isImplementingPlanRequest(parsed)).toBe(false);
  });

  test("isPlanModeRequest switches to false when user approves plan with PLEASE IMPLEMENT THIS PLAN", () => {
    const parsed: CodexParsedRequest = {
      modelId: "m365-copilot/gpt-5",
      stream: false,
      options: {},
      context: {
        messages: [
          {
            role: "developer",
            content: "<collaboration_mode># Plan Mode (Conversational)</collaboration_mode>",
            timestamp: Date.now() - 2000,
          },
          {
            role: "user",
            content: "Đọc math.js và lên kế hoạch",
            timestamp: Date.now() - 1500,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "<proposed_plan>\n## Plan\n1. Sửa math.js\n</proposed_plan>" }],
            timestamp: Date.now() - 1000,
          },
          {
            role: "developer",
            content: "<collaboration_mode># Collaboration Mode: Default\n\nYou are now in Default mode.</collaboration_mode>",
            timestamp: Date.now() - 500,
          },
          {
            role: "user",
            content: "PLEASE IMPLEMENT THIS PLAN:\n## Plan\n1. Sửa math.js",
            timestamp: Date.now(),
          },
        ],
      },
    };

    expect(isImplementingPlanRequest(parsed)).toBe(true);
    expect(isPlanModeRequest(parsed)).toBe(false);

    const prompt = compileM365PromptViaWebCompiler(parsed, false);
    expect(prompt).not.toContain(PLAN_MODE_PROMPT);
    expect(prompt).toContain(IMPLEMENT_PLAN_PROMPT);
    expect(prompt).toContain("Bản kế hoạch bạn vừa lên rất chi tiết và hợp lý");
    expect(prompt).toContain("apply_patch");
  });

  test("compileWebPrompt injects PLAN_MODE_PROMPT and strict rules when plan mode is active", () => {
    const parsed: CodexParsedRequest = {
      modelId: "m365-copilot/gpt-5",
      stream: false,
      options: {},
      context: {
        messages: [
          {
            role: "developer",
            content: "<collaboration_mode># Plan Mode\nmode=\"plan\"</collaboration_mode>",
            timestamp: Date.now(),
          },
          {
            role: "user",
            content: "Đọc math.js và lên kế hoạch",
            timestamp: Date.now(),
          },
        ],
      },
    };

    const prompt = compileM365PromptViaWebCompiler(parsed, true);
    expect(prompt).toContain(PLAN_MODE_PROMPT);
    expect(prompt).toContain("<proposed_plan>");
    expect(prompt).toContain("TUYỆT ĐỐI KHÔNG CHỈNH SỬA CODE");
  });

  test("compileWebPrompt urges proposed_plan after toolResult instead of edit tools in plan mode", () => {
    const parsed: CodexParsedRequest = {
      modelId: "m365-copilot/gpt-5",
      stream: false,
      options: {},
      context: {
        messages: [
          {
            role: "developer",
            content: "<collaboration_mode># Plan Mode</collaboration_mode>",
            timestamp: Date.now(),
          },
          {
            role: "user",
            content: "Khảo sát math.js",
            timestamp: Date.now(),
          },
          {
            role: "toolResult",
            toolCallId: "call_123",
            toolName: "read_file",
            content: "const add = (a, b) => a + b;",
            isError: false,
            timestamp: Date.now(),
          },
        ],
      },
    };

    const prompt = compileM365PromptViaWebCompiler(parsed, false);
    expect(prompt).toContain("<proposed_plan>");
    expect(prompt).toContain("chưa sửa code (chưa dùng apply_patch/write_file)");
    expect(prompt).toContain("xuất bản kế hoạch hoàn chỉnh");
    expect(prompt).toContain(SHORT_OUTPUT_FORMAT_PLAN_ANCHOR);
  });

  test("WebOutputTranslator treats proposed_plan response as final_answer even with sample code blocks", () => {
    const translator = new WebOutputTranslator();
    const rawWithPlan = `Dưới đây là kế hoạch chi tiết:

<proposed_plan>
## Summary
Bổ sung các hàm thống kê vào math.js.

## Key Changes
1. Thêm hàm variance, standardDeviation, median.
2. Cập nhật math.test.js và chạy:
\`\`\`bash
node math.test.js
\`\`\`
</proposed_plan>`;

    const result = translator.translate(rawWithPlan);
    expect(result.type).toBe("final_answer");
    if (result.type === "final_answer") {
      expect(result.content).toContain("<proposed_plan>");
      expect(result.content).toContain("node math.test.js");
    }
  });

  test("compileWebPrompt injects TOOL_REMINDER_PROMPT during toolResult turns to prevent Copilot refusal", () => {
    const parsed: CodexParsedRequest = {
      modelId: "m365-copilot/gpt-5",
      stream: false,
      options: {},
      context: {
        messages: [
          {
            role: "user",
            content: "Tạo một web app mới",
            timestamp: Date.now(),
          },
          {
            role: "toolResult",
            toolCallId: "call_abc",
            toolName: "run_command",
            content: "Chunk ID: 01cb56\nProcess exited with code 0\nOutput:\n",
            isError: false,
            timestamp: Date.now(),
          },
        ],
      },
    };

    const prompt = compileM365PromptViaWebCompiler(parsed, false);
    // Khi có toolResult, cần có TOOL_REMINDER_PROMPT tập trung vào <tool_result> mà không lặp lại danh sách tool
    expect(prompt).toContain(TOOL_REMINDER_PROMPT);
    expect(prompt).toContain("mỗi lượt 1 file");
    expect(prompt).toContain("mã thoát `0`");
    expect(prompt).toContain("apply_patch");
    expect(prompt).not.toContain("[MCP TOOL CATALOG]");
  });

  test("compileWebPrompt provides apply_patch guidance when implementing approved plan with toolResult", () => {
    const parsed: CodexParsedRequest = {
      modelId: "m365-copilot/gpt-5",
      stream: false,
      options: {},
      context: {
        messages: [
          {
            role: "user",
            content: "PLEASE IMPLEMENT THIS PLAN:\n## Plan\n1. Tạo server.js",
            timestamp: Date.now(),
          },
          {
            role: "toolResult",
            toolCallId: "call_def",
            toolName: "run_command",
            content: "fatal: not a git repository\nCannot read file: ENOENT package.json",
            isError: false,
            timestamp: Date.now(),
          },
        ],
      },
    };

    const prompt = compileM365PromptViaWebCompiler(parsed, false);
    expect(prompt).toContain(IMPLEMENT_PLAN_CONTINUATION_PROMPT);
    expect(prompt).toContain("Luôn dùng <custom_tool_call name=\"apply_patch\">".slice(-20));
    expect(prompt).toContain("<custom_tool_call name=\"apply_patch\">");
    expect(prompt).toContain(SHORT_OUTPUT_FORMAT_ANCHOR);
  });
});
