import { describe, expect, test } from "bun:test";
import {
  INTERNAL_TOOL_DESCRIBE_NAME,
  WebToolBridge,
  WebToolRegistry,
  isReadOnlyTool,
  normalizeWebToolName,
  type NormalizedTool,
} from "../src/adapters/web";
import { validateWebToolCall } from "../src/adapters/web/tools/tool-validator";
import type { CodexTool } from "../src/types";

describe("WebToolRegistry (Single Source of Truth)", () => {
  const sampleNormalizedTools: NormalizedTool[] = [
    {
      kind: "function",
      identity: { name: "exec_command", qualifiedName: "exec_command" },
      description: "Run shell command",
      rawParameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
      },
    },
    {
      kind: "custom",
      identity: { name: "apply_patch", qualifiedName: "apply_patch" },
      description: "Apply patch",
    },
    {
      kind: "function",
      identity: { name: "tool_search", qualifiedName: "tool_search" },
      description: "Search deferred tools",
      isToolSearch: true,
      rawParameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    {
      kind: "function",
      identity: { namespace: "web", name: "run", qualifiedName: "web.run" },
      description: "Browse the web",
      rawParameters: {
        type: "object",
        properties: { search_query: { type: "array" } },
      },
    },
    {
      kind: "function",
      identity: { name: "create_goal", qualifiedName: "create_goal" },
      description: "Create tracking goal",
      rawParameters: {
        type: "object",
        properties: { objective: { type: "string" } },
        required: ["objective"],
      },
    },
  ];

  test("phân tầng chính xác Tier 1 (core) và Tier 2 (extended)", () => {
    expect(WebToolRegistry.getTier(sampleNormalizedTools[0])).toBe("core");
    expect(WebToolRegistry.getTier(sampleNormalizedTools[1])).toBe("core");
    expect(WebToolRegistry.getTier(sampleNormalizedTools[2])).toBe("core");
    expect(WebToolRegistry.getTier(sampleNormalizedTools[3])).toBe("extended");
    expect(WebToolRegistry.getTier(sampleNormalizedTools[4])).toBe("extended");
  });

  test("describeTools tra cứu theo dotted name, __ name và trả suggestions khi không tìm thấy", () => {
    const res = WebToolRegistry.describeTools(
      ["web.run", "create_goal", "web__run", "web_nope"],
      sampleNormalizedTools,
    );

    expect(res.found.length).toBe(2);
    expect(res.found.map(f => f.name)).toEqual(["web.run", "create_goal"]);
    expect(res.found[0].inputSchema).toEqual({
      type: "object",
      properties: { search_query: { type: "array" } },
    });
    expect(res.notFound).toEqual([
      expect.objectContaining({
        requestedName: "web_nope",
      }),
    ]);
  });

  test("khớp và chuyển tiếp namespaced tool (web.run -> web__run) qua validator & WebToolBridge", () => {
    const clientTools: CodexTool[] = [
      {
        name: "run",
        namespace: "web",
        description: "Run web tool",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    ];

    expect(validateWebToolCall("web.run", { q: "news" }, clientTools)).toEqual({ ok: true });
    const mapped = WebToolBridge.mapToolCall(
      { name: "web.run", arguments: { q: "news" } },
      clientTools,
    );
    expect(mapped.name).toBe("web__run");
    expect(JSON.parse(mapped.arguments)).toEqual({ q: "news" });
  });

  test("chuẩn hóa aliases và metadata read-only tập trung qua WebToolRegistry", () => {
    expect(normalizeWebToolName("tools_describe")).toBe(INTERNAL_TOOL_DESCRIBE_NAME);
    expect(normalizeWebToolName("bash")).toBe("exec_command");
    expect(isReadOnlyTool("read_file")).toBe(true);
    expect(isReadOnlyTool("tool_search")).toBe(true);
    expect(isReadOnlyTool("apply_patch")).toBe(false);
  });
});
