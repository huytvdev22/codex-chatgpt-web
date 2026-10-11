import { describe, expect, test } from "bun:test";
import type { CodexTool } from "../src/types";
import { M365ToolBridge } from "../src/adapters/m365-copilot/tools/tool-bridge";

const functionTool = (
  name: string,
  parameters: Record<string, unknown> = {}
): CodexTool => ({
  name,
  description: `${name} test tool`,
  parameters,
});

const EXEC_COMMAND_TOOL = functionTool("exec_command", {
  type: "object",
  properties: {
    cmd: { type: "string" },
    sandbox_permissions: {
      type: "string",
      enum: ["use_default", "require_escalated"],
    },
    justification: { type: "string" },
    prefix_rule: {
      type: "array",
      items: { type: "string" },
    },
    workdir: { type: "string" },
    shell: { type: "string" },
    tty: { type: "boolean" },
    login: { type: "boolean" },
    yield_time_ms: { type: "number" },
    max_output_tokens: { type: "number" },
  },
  required: ["cmd"],
  additionalProperties: false,
});

const WRITE_STDIN_TOOL = functionTool("write_stdin", {
  type: "object",
  properties: {
    session_id: { type: "number" },
    chars: { type: "string" },
    yield_time_ms: { type: "number" },
    max_output_tokens: { type: "number" },
  },
  required: ["session_id"],
  additionalProperties: false,
});

const APPLY_PATCH_TOOL = functionTool("apply_patch", {
  type: "object",
  properties: {
    input: { type: "string" },
  },
  required: ["input"],
  additionalProperties: false,
});

describe("M365 native tool forwarding regression coverage", () => {
  test("forwards the exact wire name advertised by the active inventory", () => {
    const mapped = M365ToolBridge.mapToolCall(
      {
        name: "write_stdin",
        arguments: {
          session_id: 42,
          chars: "continue\n",
          yield_time_ms: 500,
        },
      },
      [WRITE_STDIN_TOOL]
    );

    expect(mapped.name).toBe("write_stdin");
    expect(JSON.parse(mapped.arguments)).toEqual({
      session_id: 42,
      chars: "continue\n",
      yield_time_ms: 500,
    });
  });

  test("preserves the write_stdin session identifier without coercion or fallback", () => {
    const mapped = M365ToolBridge.mapToolCall(
      {
        name: "write_stdin",
        arguments: {
          session_id: 9876,
          chars: "",
          yield_time_ms: 5000,
          max_output_tokens: 2000,
        },
      },
      [EXEC_COMMAND_TOOL, WRITE_STDIN_TOOL]
    );

    expect(mapped.name).toBe("write_stdin");
    expect(JSON.parse(mapped.arguments)).toEqual({
      session_id: 9876,
      chars: "",
      yield_time_ms: 5000,
      max_output_tokens: 2000,
    });
  });

  test("forwards function arguments and supported execution metadata", () => {
    const mapped = M365ToolBridge.mapToolCall(
      {
        name: "exec_command",
        arguments: {
          cmd: "git status --short",
          workdir: "/workspace/project",
          shell: "/bin/zsh",
          tty: false,
          login: false,
          yield_time_ms: 2500,
          max_output_tokens: 4000,
        },
      },
      [EXEC_COMMAND_TOOL]
    );

    expect(mapped.name).toBe("exec_command");
    expect(JSON.parse(mapped.arguments)).toEqual({
      cmd: "git status --short",
      sandbox_permissions: "use_default",
      workdir: "/workspace/project",
      shell: "/bin/zsh",
      tty: false,
      login: false,
      yield_time_ms: 2500,
      max_output_tokens: 4000,
    });
  });

  test("preserves explicit approval metadata without inferring escalation", () => {
    const mapped = M365ToolBridge.mapToolCall(
      {
        name: "exec_command",
        arguments: {
          cmd: "custom-cli deploy",
          sandbox_permissions: "require_escalated",
          justification: "Cho phép chạy deployment ngoài sandbox?",
          prefix_rule: ["custom-cli", "deploy"],
        },
      },
      [EXEC_COMMAND_TOOL]
    );

    expect(JSON.parse(mapped.arguments)).toEqual({
      cmd: "custom-cli deploy",
      sandbox_permissions: "require_escalated",
      justification: "Cho phép chạy deployment ngoài sandbox?",
      prefix_rule: ["custom-cli", "deploy"],
    });
  });

  test("forwards apply_patch raw input without converting it to a shell command", () => {
    const patch = `*** Begin Patch
*** Update File: src/example.ts
@@
-export const value = 1;
+export const value = 2;
*** End Patch`;

    const mapped = M365ToolBridge.mapToolCall(
      {
        name: "apply_patch",
        arguments: { input: `\n${patch}\n` },
      },
      [APPLY_PATCH_TOOL, EXEC_COMMAND_TOOL]
    );

    expect(mapped.name).toBe("apply_patch");
    expect(JSON.parse(mapped.arguments)).toEqual({ input: patch });
  });

  test("rejects an action that is absent from the current active inventory", () => {
    expect(() =>
      M365ToolBridge.mapToolCall(
        {
          name: "write_stdin",
          arguments: {
            session_id: 42,
            chars: "continue",
          },
        },
        [EXEC_COMMAND_TOOL]
      )
    ).toThrow(/does not advertise native write_stdin|Tool Validation Error/i);
  });

  test("does not replace an unavailable semantic action with exec_command", () => {
    expect(() =>
      M365ToolBridge.mapToolCall(
        {
          name: "apply_patch",
          arguments: {
            input: "*** Begin Patch\n*** End Patch",
          },
        },
        [EXEC_COMMAND_TOOL]
      )
    ).toThrow(/does not advertise native apply_patch|Tool Validation Error/i);
  });

  test("rejects a completely unknown action instead of inventing an alias", () => {
    expect(() =>
      M365ToolBridge.mapToolCall(
        {
          name: "made_up_action",
          arguments: {
            value: "unexpected",
          },
        },
        [EXEC_COMMAND_TOOL, WRITE_STDIN_TOOL, APPLY_PATCH_TOOL]
      )
    ).toThrow(/Tool Validation Error|Capability Error/i);
  });

  test("normalizes only the supported functions namespace prefix", () => {
    const mapped = M365ToolBridge.mapToolCall(
      {
        name: "functions.write_stdin",
        arguments: {
          session_id: 73,
          chars: "next",
        },
      },
      [WRITE_STDIN_TOOL]
    );

    expect(mapped.name).toBe("write_stdin");
    expect(JSON.parse(mapped.arguments)).toEqual({
      session_id: 73,
      chars: "next",
    });
  });

  test("maps the same input deterministically without retaining stale turn state", () => {
    const raw = {
      name: "write_stdin",
      arguments: {
        session_id: 101,
        chars: "poll",
      },
    };

    const first = M365ToolBridge.mapToolCall(raw, [WRITE_STDIN_TOOL]);
    const second = M365ToolBridge.mapToolCall(raw, [WRITE_STDIN_TOOL]);

    expect(second).toEqual(first);
    expect(JSON.parse(second.arguments).session_id).toBe(101);
  });
});
