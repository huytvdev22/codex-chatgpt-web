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
  TurnTraceRecorder,
  WebPromptSessionStore,
  WebTurnEngine,
  type WebProviderDefinition,
} from "../src/adapters/web";
import {
  WebOutputTranslator,
  hasStandaloneProposedPlanTag,
  stripStandaloneProposedPlanTags,
} from "../src/adapters/web/protocol";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

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

  test("stripStandaloneProposedPlanTags lột thẻ ngoài code block nhưng bảo toàn snippet code", () => {
    const mixed = [
      "<proposed_plan>",
      "Nội dung review sạch.",
      "",
      "Trong file dùng thẻ `<proposed_plan>` và mẫu:",
      "````markdown",
      "```xml",
      "<proposed_plan>",
      "## Example",
      "</proposed_plan>",
      "```",
      "````",
      "</proposed_plan>",
    ].join("\n");

    expect(hasStandaloneProposedPlanTag(mixed)).toBe(true);
    const cleaned = stripStandaloneProposedPlanTags(mixed);
    expect(cleaned.startsWith("Nội dung review sạch.")).toBe(true);
    expect(cleaned).toContain("`<proposed_plan>`");
    expect(cleaned).toContain("```xml\n<proposed_plan>\n## Example\n</proposed_plan>\n```");
    expect(cleaned.endsWith("````")).toBe(true);
    expect(hasStandaloneProposedPlanTag(cleaned)).toBe(false);
  });

  test("WebTurnEngine tự lột <proposed_plan> ngoài code block ở Default Mode và giữ nguyên trong Plan Mode", async () => {
    let seenCalls = 0;
    const buildEngine = () => {
      const def: WebProviderDefinition = {
        id: "test-plan-guard",
        assistantName: "M365",
        logPrefix: "test-plan-guard",
        policies: { manageLauncherLeaseInEngine: false, maxFormatRetries: 1 },
        conversation: { resolveConversationKey: () => `conv_${seenCalls}` },
        browser: {
          launcherProviderId: "m365",
          connectorIdentity: "test-plan-guard",
          executeTurn: async () => {
            seenCalls += 1;
            return {
              rawResponse: [
                "````markdown",
                "<webResponse>",
                "<proposed_plan>",
                "## Kết quả review",
                "Code sạch, sẵn sàng merge.",
                "</proposed_plan>",
                "</webResponse>",
                "````",
              ].join("\n"),
              conversationId: "conv-web-1",
            };
          },
        },
      };
      return new WebTurnEngine(def, undefined, undefined, new TurnTraceRecorder({ enabled: false }), new WebPromptSessionStore());
    };

    // 1. Default Mode -> lột thẻ <proposed_plan>, chỉ chạy 1 lần
    seenCalls = 0;
    const defaultParsed = parseRequest({
      model: "m365-copilot/gpt-5.6",
      metadata: { thread_id: "th_default_guard", turn_id: "t1" },
      input: [
        { type: "message", role: "developer", content: "<collaboration_mode># Collaboration Mode: Default</collaboration_mode>" },
        { type: "message", role: "user", content: "review code giúp tôi" },
      ],
    });
    const defaultEvents: AdapterEvent[] = [];
    await buildEngine().runTurn(
      defaultParsed,
      { headers: new Headers(), abortSignal: new AbortController().signal },
      e => defaultEvents.push(e),
    );
    expect(seenCalls).toBe(1);
    const defaultText = defaultEvents
      .filter((e): e is Extract<AdapterEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map(e => e.text)
      .join("");
    expect(defaultText).toBe("## Kết quả review\nCode sạch, sẵn sàng merge.");

    // 2. Plan Mode -> giữ nguyên cặp thẻ <proposed_plan>
    seenCalls = 0;
    const planParsed = parseRequest({
      model: "m365-copilot/gpt-5.6",
      metadata: { thread_id: "th_plan_guard", turn_id: "t2" },
      input: [
        { type: "message", role: "developer", content: "<collaboration_mode># Plan Mode (Conversational)</collaboration_mode>" },
        { type: "message", role: "user", content: "lên kế hoạch giúp tôi" },
      ],
    });
    const planEvents: AdapterEvent[] = [];
    await buildEngine().runTurn(
      planParsed,
      { headers: new Headers(), abortSignal: new AbortController().signal },
      e => planEvents.push(e),
    );
    expect(seenCalls).toBe(1);
    const planText = planEvents
      .filter((e): e is Extract<AdapterEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map(e => e.text)
      .join("");
    expect(planText).toContain("<proposed_plan>");
  });

  test("WebTurnEngine từ chối và retry khi AI xuất lại <proposed_plan> lúc đã duyệt kế hoạch (isImplementingPlan)", async () => {
    const promptsSent: string[] = [];
    let attemptIdx = 0;
    const def: WebProviderDefinition = {
      id: "test-impl-guard",
      assistantName: "M365",
      logPrefix: "test-impl-guard",
      policies: { manageLauncherLeaseInEngine: false, maxFormatRetries: 1 },
      conversation: { resolveConversationKey: () => "th_impl_guard" },
      browser: {
        launcherProviderId: "m365",
        connectorIdentity: "test-impl-guard",
        executeTurn: async ({ prompt }) => {
          promptsSent.push(prompt);
          attemptIdx += 1;
          if (attemptIdx === 1) {
            return {
              rawResponse: [
                "````markdown",
                "<webResponse>",
                "<proposed_plan>",
                "## Kế hoạch lại",
                "</proposed_plan>",
                "</webResponse>",
                "````",
              ].join("\n"),
              conversationId: "conv-impl-1",
            };
          }
          return {
            rawResponse: [
              "````markdown",
              "<webResponse>",
              '<tool_call>{"name":"exec_command","arguments":{"cmd":"git status"}}</tool_call>',
              "</webResponse>",
              "````",
            ].join("\n"),
            conversationId: "conv-impl-1",
          };
        },
      },
    };

    const parsed = parseRequest({
      model: "m365-copilot/gpt-5.6",
      metadata: { thread_id: "th_impl_guard", turn_id: "t3" },
      tools: [
        {
          type: "function",
          name: "exec_command",
          description: "Run shell",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        },
      ],
      input: [
        { type: "message", role: "developer", content: "<collaboration_mode># Collaboration Mode: Default</collaboration_mode>" },
        { type: "message", role: "user", content: "PLEASE IMPLEMENT THIS PLAN:\n1. Kiểm tra git status" },
      ],
    });

    const events: AdapterEvent[] = [];
    const engine = new WebTurnEngine(def, undefined, undefined, new TurnTraceRecorder({ enabled: false }), new WebPromptSessionStore());
    await engine.runTurn(
      parsed,
      { headers: new Headers(), abortSignal: new AbortController().signal },
      e => events.push(e),
    );

    expect(attemptIdx).toBe(2);
    expect(promptsSent[1]).toContain("UNEXPECTED_PROPOSED_PLAN");
    expect(events.some(e => e.type === "tool_call_start" && e.name === "exec_command")).toBe(true);
  });
});
