import { describe, expect, test } from "bun:test";
import {
  CodexPayloadNormalizer,
  CodexRawPayload,
  compileWebPrompt,
  mcpToolCatalogRenderer,
  promptCompiler,
} from "../src/adapters/web";
import { parseRequest } from "../src/responses/parser";

describe("McpToolCatalogRenderer & Lean Turn 2+ Tests", () => {
  test("renderInitialCatalog tách Core tools vs Extended catalog + tools.describe + deferred_namespaces", () => {
    const rawWire: any = {
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
                {
                  type: "function",
                  name: "exec_command",
                  description: "Run CLI command",
                  parameters: {
                    type: "object",
                    properties: { cmd: { type: "string", description: "Command" } },
                    required: ["cmd"],
                  },
                },
                {
                  type: "custom",
                  name: "apply_patch",
                  description: "Edit file",
                },
                {
                  type: "function",
                  name: "create_goal",
                  description: "Create tracking goal",
                  parameters: {
                    type: "object",
                    properties: { objective: { type: "string", description: "Goal objective" } },
                    required: ["objective"],
                  },
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
                  description: "Browse live web",
                  parameters: {
                    type: "object",
                    properties: { search_query: { type: "array" } },
                  },
                },
              ],
            },
            { type: "tool_search", execution: "client" },
          ],
        },
        {
          type: "message",
          role: "developer",
          content: "<tools>\nDeferred tool namespaces:\n- multi_agent_v1: Subagent tools\n</tools>",
          internal_chat_message_metadata_passthrough: { content_item_kinds: ["tools.deferred_namespaces"] },
        },
        {
          type: "message",
          role: "user",
          content: "Kiểm tra repo",
        },
      ],
    };

    const parsed = parseRequest(rawWire);
    const normalized = CodexPayloadNormalizer.normalize(CodexRawPayload.from(rawWire), { parsed });
    const catalog = mcpToolCatalogRenderer.renderInitialCatalog({
      tools: normalized.activeCodingTools,
      deferredNamespaces: normalized.deferredNamespaces,
      assistantName: "M365",
    });

    const jsonBlock = catalog.match(/```json\n([\s\S]*?)\n```/)?.[1];
    expect(jsonBlock).toBeDefined();
    const spec = JSON.parse(jsonBlock!);

    expect(spec.core_tools.map((t: any) => t.name)).toEqual(["exec_command", "apply_patch", "tool_search"]);
    expect(spec.core_tools[0].inputSchema.required).toEqual(["cmd"]);
    expect(spec.extended_catalog.map((t: any) => t.name)).toEqual(["create_goal", "web.run"]);
    expect(spec.extended_catalog[0].inputSchema).toBeUndefined();
    expect(spec.lookup_tool.name).toBe("tools.describe");
    expect(spec.deferred_namespaces).toEqual(["multi_agent_v1: Subagent tools"]);
  });

  test("renderToolDelta chỉ sinh output khi có delta hoặc schema correction", () => {
    const execTool: any = {
      kind: "function",
      identity: { name: "exec_command", qualifiedName: "exec_command" },
      description: "Run cmd",
      rawParameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
      },
    };
    const spawnTool: any = {
      kind: "function",
      identity: { namespace: "multi_agent_v1", name: "spawn_agent", qualifiedName: "multi_agent_v1.spawn_agent" },
      description: "Spawn agent",
      rawParameters: {
        type: "object",
        properties: { prompt: { type: "string" } },
        required: ["prompt"],
      },
    };

    expect(mcpToolCatalogRenderer.renderToolDelta({ currentTools: [execTool] })).toBe("");

    const deltaText = mcpToolCatalogRenderer.renderToolDelta({
      currentTools: [execTool, spawnTool],
      addedTools: [spawnTool],
      removedToolNames: ["old_tool"],
      failedToolName: "exec_command",
      failedErrorCode: "MISSING_ARGUMENT",
      failedErrorMessage: "cmd is required",
    });

    expect(deltaText).toContain("[MCP TOOL DELTA / SCHEMA CORRECTION: MISSING_ARGUMENT]");
    expect(deltaText).toContain('"multi_agent_v1.spawn_agent"');
    expect(deltaText).toContain('"removed": [\n    "old_tool"\n  ]');
    expect(deltaText).toContain('"schema_fix"');
  });

  test("STRUCTURED_JSON_OUTPUT loại bỏ AGENTS.md (developerInstructions) để gọn nhẹ tối đa", () => {
    const parsed = parseRequest({
      model: "m365-copilot/gpt-5.6",
      instructions: "Generate concise title JSON.",
      input: [
        {
          type: "message",
          role: "user",
          content: "<INSTRUCTIONS>\n# Quy Tắc Dự Án Dài 2000 Ký Tự\n- Không dùng Python\n</INSTRUCTIONS>",
          internal_chat_message_metadata_passthrough: { content_item_kinds: ["agents_md.instructions"] },
        },
        {
          type: "message",
          role: "user",
          content: "Tóm tắt thread fix bug DOM",
          internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "codex_output_schema",
          strict: true,
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
    });

    const compiled = compileWebPrompt(parsed, {
      assistantName: "M365",
      isNewConversation: true,
    });

    expect(compiled.scenario).toBe("STRUCTURED_JSON_OUTPUT");
    expect(compiled.finalPrompt).not.toContain("Quy Tắc Dự Án Dài");
    expect(compiled.finalPrompt).toContain("Generate concise title JSON.");
    expect(compiled.audit.developerRulesCount).toBe(0);
  });

  test("FIRST_HANDSHAKE không nhân đôi AGENTS.md và PLAN_CONTINUATION có includeUserInstruction=false siêu gọn", () => {
    const longAgentsRule = "Quy ước dự án độc nhất chỉ xuất hiện đúng 1 lần.";
    const rawWire: any = {
      model: "m365-copilot/gpt-5.6",
      input: [
        {
          type: "message",
          role: "user",
          content: `<INSTRUCTIONS>\n${longAgentsRule}\n</INSTRUCTIONS>`,
          internal_chat_message_metadata_passthrough: { content_item_kinds: ["agents_md.instructions"] },
        },
        {
          type: "message",
          role: "user",
          content: "PLEASE IMPLEMENT THIS PLAN:\n" + "B".repeat(2_000),
          internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
        },
        {
          type: "custom_tool_call",
          call_id: "call_p1",
          name: "apply_patch",
          input: "*** Begin Patch\n*** End Patch",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_p1",
          output: "Success. Updated a.ts",
        },
      ],
    };

    const parsed = parseRequest(rawWire);
    const normalized = CodexPayloadNormalizer.normalize(CodexRawPayload.from(rawWire), { parsed });

    const turn1 = promptCompiler.compile({
      normalized,
      parsed,
      isNewConversation: true,
    });
    expect(turn1.finalPrompt.split(longAgentsRule).length - 1).toBe(1);

    const leanPlanTurn = promptCompiler.compile({
      normalized,
      parsed,
      isNewConversation: false,
      isImplementingPlan: true,
      includeEnvironment: false,
      includeUserInstruction: false,
    });

    expect(leanPlanTurn.finalPrompt).toContain("<tool_result id=\"call_p1\">");
    expect(leanPlanTurn.finalPrompt).not.toContain("BBBBBBBB");
    expect(leanPlanTurn.finalPrompt).not.toContain("[MCP TOOL CATALOG]");
    expect(leanPlanTurn.finalPrompt.length).toBeLessThan(650);
  });
});
