import { describe, expect, test } from "bun:test";
import {
  buildCodexExecCommandArguments,
  validateCommandApproval,
  M365ToolBridge,
} from "../src/adapters/m365-copilot/tools";

const EXEC_COMMAND_TOOL = [{
  type: "function" as const,
  name: "exec_command",
  description: "Run a command",
  parameters: {
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
    },
    required: ["cmd"],
    additionalProperties: false,
  },
}];

describe("M365 local approval policy", () => {
  test("uses the default sandbox when escalation is not requested", () => {
    expect(validateCommandApproval({
      command: "git status",
    })).toEqual({
      sandboxPermissions: "use_default",
    });

    expect(buildCodexExecCommandArguments({
      cmd: "git diff --check",
    })).toEqual({
      cmd: "git diff --check",
      sandbox_permissions: "use_default",
    });
  });

  test("forwards a valid generic escalation request", () => {
    const result = buildCodexExecCommandArguments({
      command: "git init",
      sandbox_permissions: "require_escalated",
      justification: "Cho phép tạo Git metadata trong thư mục dự án?",
      prefix_rule: ["git", "init"],
    });

    expect(result).toEqual({
      cmd: "git init",
      sandbox_permissions: "require_escalated",
      justification: "Cho phép tạo Git metadata trong thư mục dự án?",
      prefix_rule: ["git", "init"],
    });
  });

  test("does not infer escalation from command content", () => {
    const result = buildCodexExecCommandArguments({
      cmd: "git commit -m \"feat: test approval\"",
    });

    expect(result).toEqual({
      cmd: "git commit -m \"feat: test approval\"",
      sandbox_permissions: "use_default",
    });
  });

  test("preserves supported execution and approval fields", () => {
    const result = buildCodexExecCommandArguments({
      cmd: "custom-cli deploy",
      sandbox_permissions: "require_escalated",
      justification: "Cho phép chạy deployment ngoài sandbox?",
      prefix_rule: ["custom-cli", "deploy"],
      workdir: "/workspace",
      shell: "/bin/zsh",
      tty: true,
      login: false,
      yield_time_ms: 5000,
      max_output_tokens: 2000,
    });

    expect(result).toEqual({
      cmd: "custom-cli deploy",
      sandbox_permissions: "require_escalated",
      justification: "Cho phép chạy deployment ngoài sandbox?",
      prefix_rule: ["custom-cli", "deploy"],
      workdir: "/workspace",
      shell: "/bin/zsh",
      tty: true,
      login: false,
      yield_time_ms: 5000,
      max_output_tokens: 2000,
    });
  });

  test("rejects an unknown sandbox permission", () => {
    expect(() => validateCommandApproval({
      command: "custom-cli deploy",
      sandbox_permissions: "full_access",
    })).toThrow(
      "sandbox_permissions must be use_default or require_escalated"
    );
  });

  test("requires justification for escalation", () => {
    expect(() => validateCommandApproval({
      command: "git init",
      sandbox_permissions: "require_escalated",
      prefix_rule: ["git", "init"],
    })).toThrow(
      "justification is required for require_escalated"
    );
  });

  test("rejects malformed prefix rules", () => {
    expect(() => validateCommandApproval({
      command: "git init",
      sandbox_permissions: "require_escalated",
      justification: "Cho phép tạo Git metadata?",
      prefix_rule: [],
    })).toThrow(
      "prefix_rule must be a non-empty string array"
    );
  });

  test("tool bridge emits the Codex approval wire fields", () => {
    const mapped = M365ToolBridge.mapToolCall(
      {
        name: "exec_command",
        arguments: {
          command: "git init",
          sandbox_permissions: "require_escalated",
          justification: "Cho phép tạo Git metadata trong thư mục dự án?",
          prefix_rule: ["git", "init"],
        },
      },
      EXEC_COMMAND_TOOL,
      { platform: "darwin" }
    );

    expect(mapped.name).toBe("exec_command");
    expect(JSON.parse(mapped.arguments)).toEqual({
      cmd: "git init",
      sandbox_permissions: "require_escalated",
      justification: "Cho phép tạo Git metadata trong thư mục dự án?",
      prefix_rule: ["git", "init"],
    });
  });
});
