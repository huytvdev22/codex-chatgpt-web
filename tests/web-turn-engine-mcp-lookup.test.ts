import { describe, expect, test } from "bun:test";
import {
  TurnTraceRecorder,
  WebPromptSessionStore,
  WebTurnEngine,
  type WebProviderDefinition,
} from "../src/adapters/web";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent } from "../src/types";

function baseWireRequest(input: any[], toolsOverride?: any[]): any {
  const additionalTools = toolsOverride ?? [
    {
      type: "namespace",
      name: "functions",
      tools: [
        {
          type: "function",
          name: "exec_command",
          description: "Run CLI",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string", description: "Shell command" } },
            required: ["cmd"],
          },
        },
        {
          type: "custom",
          name: "apply_patch",
          description: "Apply patch",
        },
      ],
    },
    {
      type: "namespace",
      name: "web",
      tools: [
        {
          type: "function",
          name: "run",
          description: "Browse the web",
          parameters: {
            type: "object",
            properties: {
              search_query: { type: "array", description: "Queries to search" },
            },
            required: ["search_query"],
          },
        },
      ],
    },
    { type: "tool_search", execution: "client" },
  ];

  return {
    model: "m365-copilot/gpt-5.6",
    metadata: { thread_id: "th_session_demo", turn_id: "turn_session_1" },
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: additionalTools,
      },
      {
        type: "message",
        role: "user",
        content: "<environment_context><cwd>/repo/demo</cwd><shell>zsh</shell></environment_context>",
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ["environments.environment_context"],
        },
      },
      ...input,
    ],
  };
}

describe("WebTurnEngine MCP Catalog, Internal Lookup & Session Delta", () => {
  test("internal tools.describe trả JSON Schema trên web chat và KHÔNG phát event ra Codex", async () => {
    const capturedPrompts: string[] = [];
    let callStep = 0;

    const definition: WebProviderDefinition = {
      id: "test-web",
      assistantName: "Copilot",
      logPrefix: "test-lookup",
      policies: { manageLauncherLeaseInEngine: false, maxFormatRetries: 1 },
      conversation: { resolveConversationKey: () => "conv_lookup_1" },
      browser: {
        launcherProviderId: "m365",
        connectorIdentity: "test-web",
        executeTurn: async ({ prompt, isNewConversation }) => {
          capturedPrompts.push(prompt);
          callStep += 1;
          if (callStep === 1) {
            expect(isNewConversation).toBe(true);
            return {
              rawResponse: '````markdown\n<webResponse>\n<tool_call>\n{"name":"tools.describe","arguments":{"names":["web.run"]}}\n</tool_call>\n</webResponse>\n````',
              conversationId: "web_c_1",
            };
          }
          expect(isNewConversation).toBe(false);
          return {
            rawResponse: '````markdown\n<webResponse>\n<tool_call>\n{"name":"web.run","arguments":{"search_query":["bun 1.4"]}}\n</tool_call>\n</webResponse>\n````',
            conversationId: "web_c_1",
          };
        },
      },
    };

    const sessionStore = new WebPromptSessionStore();
    const engine = new WebTurnEngine(
      definition,
      undefined,
      undefined,
      new TurnTraceRecorder({ enabled: false }),
      sessionStore,
    );

    const parsed = parseRequest(
      baseWireRequest([
        {
          type: "message",
          role: "user",
          content: "Tìm thông tin Bun 1.4 giúp tôi",
          internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
        },
      ]),
    );

    const events: AdapterEvent[] = [];
    await engine.runTurn(
      parsed,
      { headers: new Headers(), abortSignal: new AbortController().signal },
      ev => events.push(ev),
    );

    expect(capturedPrompts.length).toBe(2);
    expect(capturedPrompts[0]).toContain("[MCP TOOL CATALOG]");
    expect(capturedPrompts[1]).toContain('<tool_result name="tools.describe">');
    expect(capturedPrompts[1]).toContain('"search_query"');

    const emittedTools = events
      .filter((e): e is Extract<AdapterEvent, { type: "tool_call_start" }> => e.type === "tool_call_start")
      .map(e => e.name);
    expect(emittedTools).toEqual(["web__run"]);
    expect(emittedTools).not.toContain("tools.describe");
  });

  test("chặn lặp vô hạn khi chatbot gọi tools.describe quá MAX_TOOL_DESCRIBE_ROUNDS = 2", async () => {
    const capturedPrompts: string[] = [];
    const definition: WebProviderDefinition = {
      id: "test-web",
      assistantName: "Copilot",
      logPrefix: "test-lookup-limit",
      policies: { manageLauncherLeaseInEngine: false, maxFormatRetries: 1 },
      conversation: { resolveConversationKey: () => "conv_lookup_limit" },
      browser: {
        launcherProviderId: "m365",
        connectorIdentity: "test-web",
        executeTurn: async ({ prompt }) => {
          capturedPrompts.push(prompt);
          if (capturedPrompts.length <= 3) {
            return {
              rawResponse: '````markdown\n<webResponse>\n<tool_call>\n{"name":"tools.describe","arguments":{"names":["web.run"]}}\n</tool_call>\n</webResponse>\n````',
              conversationId: "web_c_limit",
            };
          }
          return {
            rawResponse: '````markdown\n<webResponse>\nĐã thôi gọi tools.describe và kết luận.\n</webResponse>\n````',
            conversationId: "web_c_limit",
          };
        },
      },
    };

    const engine = new WebTurnEngine(
      definition,
      undefined,
      undefined,
      new TurnTraceRecorder({ enabled: false }),
      new WebPromptSessionStore(),
    );

    const parsed = parseRequest(
      baseWireRequest([{ type: "message", role: "user", content: "Thử lookup liên tục" }]),
    );

    const events: AdapterEvent[] = [];
    await engine.runTurn(
      parsed,
      { headers: new Headers(), abortSignal: new AbortController().signal },
      ev => events.push(ev),
    );

    expect(capturedPrompts.length).toBe(4);
    expect(capturedPrompts[3]).toContain("INVALID_TOOL_CALL");
    expect(capturedPrompts[3]).toContain("giới hạn số lần gọi tools.describe");
    expect(events.some(e => e.type === "text_delta" && e.text.includes("Đã thôi gọi tools.describe"))).toBe(true);
  });

  test("Session Store bỏ lặp userInstruction/env/tool catalog ở Turn 2+ và chỉ bơm Tool Delta khi có tool mới", async () => {
    const sentPrompts: string[] = [];
    let isNewFlag = true;

    const definition: WebProviderDefinition = {
      id: "test-web",
      assistantName: "Copilot",
      logPrefix: "test-session",
      policies: { manageLauncherLeaseInEngine: false, maxFormatRetries: 0 },
      conversation: {
        resolveConversationKey: () => "conv_session_delta",
        resolveState: () => ({
          existingConversationId: isNewFlag ? undefined : "web_session_1",
          isNewConversation: isNewFlag,
        }),
      },
      browser: {
        launcherProviderId: "m365",
        connectorIdentity: "test-web",
        executeTurn: async ({ prompt }) => {
          sentPrompts.push(prompt);
          return {
            rawResponse: '````markdown\n<webResponse>\nOK.\n</webResponse>\n````',
            conversationId: "web_session_1",
          };
        },
      },
    };

    const sessionStore = new WebPromptSessionStore();
    const engine = new WebTurnEngine(
      definition,
      undefined,
      undefined,
      new TurnTraceRecorder({ enabled: false }),
      sessionStore,
    );

    const longPlan = "PLEASE IMPLEMENT THIS PLAN:\n" + "X".repeat(1_500);

    // Turn 1: New conversation -> Full catalog + env + user request
    isNewFlag = true;
    await engine.runTurn(
      parseRequest(
        baseWireRequest([
          {
            type: "message",
            role: "user",
            content: longPlan,
            internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
          },
        ]),
      ),
      { headers: new Headers(), abortSignal: new AbortController().signal },
      () => {},
    );

    // Turn 2: Tool result continuation với cùng toolset, cùng env, cùng longPlan -> Siêu gọn!
    isNewFlag = false;
    await engine.runTurn(
      parseRequest(
        baseWireRequest([
          {
            type: "message",
            role: "user",
            content: longPlan,
            internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
          },
          {
            type: "function_call",
            call_id: "c_1",
            name: "exec_command",
            arguments: '{"cmd":"ls"}',
          },
          {
            type: "function_call_output",
            call_id: "c_1",
            output: "package.json\nsrc",
          },
        ]),
      ),
      { headers: new Headers(), abortSignal: new AbortController().signal },
      () => {},
    );

    // Turn 3: tool_search_output mở khóa multi_agent_v1.spawn_agent -> Bơm đúng [MCP TOOL DELTA]
    await engine.runTurn(
      parseRequest(
        baseWireRequest([
          {
            type: "message",
            role: "user",
            content: longPlan,
            internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
          },
          {
            type: "tool_search_call",
            call_id: "c_ts_1",
            arguments: { query: "multi_agent_v1" },
          },
          {
            type: "tool_search_output",
            call_id: "c_ts_1",
            status: "completed",
            tools: [
              {
                type: "namespace",
                name: "multi_agent_v1",
                tools: [
                  {
                    type: "function",
                    name: "spawn_agent",
                    description: "Spawn worker agent",
                    parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
                  },
                ],
              },
            ],
          },
        ]),
      ),
      { headers: new Headers(), abortSignal: new AbortController().signal },
      () => {},
    );

    expect(sentPrompts[0]).toContain("[MCP TOOL CATALOG]");
    expect(sentPrompts[0]).toContain("/repo/demo");

    // Turn 2 phải siêu gọn: không có MCP TOOL CATALOG, không lặp lại cwd, không lặp lại longPlan!
    expect(sentPrompts[1]).not.toContain("[MCP TOOL CATALOG]");
    expect(sentPrompts[1]).not.toContain("[MCP TOOL DELTA]");
    expect(sentPrompts[1]).not.toContain("/repo/demo");
    expect(sentPrompts[1]).not.toContain("XXXXXXXX");
    expect(sentPrompts[1]).toContain("package.json");
    expect(sentPrompts[1].length).toBeLessThan(650);

    // Turn 3 phải bơm [MCP TOOL DELTA] chỉ chứa tool mới spawn_agent
    expect(sentPrompts[2]).toContain("[MCP TOOL DELTA]");
    expect(sentPrompts[2]).toContain("multi_agent_v1.spawn_agent");
    expect(sentPrompts[2]).not.toContain("XXXXXXXX");
  });

  test("tự động chèn schema_fix khi format retry do MISSING_ARGUMENT", async () => {
    const prompts: string[] = [];
    let attempt = 0;

    const definition: WebProviderDefinition = {
      id: "test-web",
      assistantName: "Copilot",
      logPrefix: "test-schema-fix",
      policies: { manageLauncherLeaseInEngine: false, maxFormatRetries: 1 },
      conversation: { resolveConversationKey: () => "conv_schema_fix" },
      browser: {
        launcherProviderId: "m365",
        connectorIdentity: "test-web",
        executeTurn: async ({ prompt }) => {
          prompts.push(prompt);
          attempt += 1;
          if (attempt === 1) {
            return {
              rawResponse: '````markdown\n<webResponse>\n<tool_call>\n{"name":"exec_command","arguments":{}}\n</tool_call>\n</webResponse>\n````',
            };
          }
          return {
            rawResponse: '````markdown\n<webResponse>\n<tool_call>\n{"name":"exec_command","arguments":{"cmd":"pwd"}}\n</tool_call>\n</webResponse>\n````',
          };
        },
      },
    };

    const engine = new WebTurnEngine(
      definition,
      undefined,
      undefined,
      new TurnTraceRecorder({ enabled: false }),
      new WebPromptSessionStore(),
    );

    const events: AdapterEvent[] = [];
    await engine.runTurn(
      parseRequest(baseWireRequest([{ type: "message", role: "user", content: "Chạy pwd" }])),
      { headers: new Headers(), abortSignal: new AbortController().signal },
      ev => events.push(ev),
    );

    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain("[MCP TOOL DELTA / SCHEMA CORRECTION: MISSING_ARGUMENT]");
    expect(prompts[1]).toContain('"schema_fix"');
    expect(prompts[1]).toContain('"cmd"');
    expect(events.some(e => e.type === "tool_call_start" && e.name === "exec_command")).toBe(true);
  });
});
