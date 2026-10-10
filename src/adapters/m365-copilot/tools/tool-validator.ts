import type { CodexTool } from "../../../types";

export interface ToolValidationSuccess {
  ok: true;
}

export interface ToolValidationFailure {
  ok: false;
  code: "UNKNOWN_TOOL" | "MISSING_ARGUMENT" | "INVALID_ARGUMENT";
  message: string;
}

export type ToolValidationResult = ToolValidationSuccess | ToolValidationFailure;

const BRIDGE_TOOLS = new Set([
  "read_file", "list_dir", "search_files", "grep_code", "git_status", "git_diff",
  "run_command", "exec_command", "write_file", "apply_patch", "write_stdin",
  "view_image", "request_user_input", "create_goal", "update_goal", "get_goal",
]);

function requireString(args: Record<string, unknown>, key: string): ToolValidationResult {
  return typeof args[key] === "string" && (args[key] as string).length > 0
    ? { ok: true }
    : { ok: false, code: "MISSING_ARGUMENT", message: `Tool argument ${key} must be a non-empty string.` };
}

function validateApplyPatch(args: Record<string, unknown>): ToolValidationResult {
  const required = requireString(args, "input");
  if (!required.ok) return required;

  const lines = (args.input as string).trim().split(/\r?\n/);
  if (lines[0] !== "*** Begin Patch" || lines[lines.length - 1] !== "*** End Patch") {
    return {
      ok: false,
      code: "INVALID_ARGUMENT",
      message: "apply_patch.input must contain a complete *** Begin Patch ... *** End Patch envelope.",
    };
  }
  if (lines.slice(1, -1).some(line => line === "*** Begin Patch" || line === "*** End Patch")) {
    return {
      ok: false,
      code: "INVALID_ARGUMENT",
      message: "apply_patch.input must contain exactly one outer patch envelope.",
    };
  }
  return { ok: true };
}

function validateExecCommand(args: Record<string, unknown>): ToolValidationResult {
  const command = requireString(args, "cmd");
  if (!command.ok) return command;

  const permission = args.sandbox_permissions;
  if (
    permission !== undefined
    && permission !== "use_default"
    && permission !== "require_escalated"
  ) {
    return {
      ok: false,
      code: "INVALID_ARGUMENT",
      message: "exec_command.sandbox_permissions must be use_default or require_escalated.",
    };
  }

  if (
    permission === "require_escalated"
    && (
      typeof args.justification !== "string"
      || args.justification.trim().length === 0
    )
  ) {
    return {
      ok: false,
      code: "MISSING_ARGUMENT",
      message: "exec_command.justification is required for require_escalated.",
    };
  }

  if (args.justification !== undefined && typeof args.justification !== "string") {
    return {
      ok: false,
      code: "INVALID_ARGUMENT",
      message: "exec_command.justification must be a string.",
    };
  }

  if (args.prefix_rule !== undefined) {
    if (
      !Array.isArray(args.prefix_rule)
      || args.prefix_rule.length === 0
      || args.prefix_rule.some(
        value => typeof value !== "string" || value.trim().length === 0
      )
    ) {
      return {
        ok: false,
        code: "INVALID_ARGUMENT",
        message: "exec_command.prefix_rule must be a non-empty string array.",
      };
    }

    if (permission !== "require_escalated") {
      return {
        ok: false,
        code: "INVALID_ARGUMENT",
        message: "exec_command.prefix_rule is only valid with require_escalated.",
      };
    }
  }

  if (args.workdir !== undefined && typeof args.workdir !== "string") {
    return {
      ok: false,
      code: "INVALID_ARGUMENT",
      message: "exec_command.workdir must be a string.",
    };
  }

  if (args.shell !== undefined && typeof args.shell !== "string") {
    return {
      ok: false,
      code: "INVALID_ARGUMENT",
      message: "exec_command.shell must be a string.",
    };
  }

  if (args.tty !== undefined && typeof args.tty !== "boolean") {
    return {
      ok: false,
      code: "INVALID_ARGUMENT",
      message: "exec_command.tty must be a boolean.",
    };
  }

  if (args.login !== undefined && typeof args.login !== "boolean") {
    return {
      ok: false,
      code: "INVALID_ARGUMENT",
      message: "exec_command.login must be a boolean.",
    };
  }

  if (args.yield_time_ms !== undefined && typeof args.yield_time_ms !== "number") {
    return {
      ok: false,
      code: "INVALID_ARGUMENT",
      message: "exec_command.yield_time_ms must be a number.",
    };
  }

  if (
    args.max_output_tokens !== undefined
    && typeof args.max_output_tokens !== "number"
  ) {
    return {
      ok: false,
      code: "INVALID_ARGUMENT",
      message: "exec_command.max_output_tokens must be a number.",
    };
  }

  return { ok: true };
}

/** Validate tool inventory và các trường bắt buộc sau normalization, trước mapping/execution. */
export function validateM365ToolCall(
  name: string,
  args: Record<string, unknown>,
  clientTools: CodexTool[] = []
): ToolValidationResult {
  const advertised = clientTools.some(tool => tool.name === name);
  if (!advertised && !BRIDGE_TOOLS.has(name)) {
    return { ok: false, code: "UNKNOWN_TOOL", message: `Tool '${name}' is not advertised or supported by the M365 bridge.` };
  }

  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, code: "INVALID_ARGUMENT", message: "Tool arguments must be a JSON object." };
  }

  switch (name) {
    case "read_file":
    case "write_file":
    case "view_image": {
      const pathResult = requireString(args, "path");
      if (!pathResult.ok) return pathResult;
      if (name === "write_file" && typeof args.content !== "string") {
        return { ok: false, code: "MISSING_ARGUMENT", message: "write_file.content must be a string." };
      }
      if (name === "write_file" && args.content_encoding !== undefined
        && args.content_encoding !== "plain" && args.content_encoding !== "base64") {
        return { ok: false, code: "INVALID_ARGUMENT", message: "write_file.content_encoding must be plain or base64." };
      }
      return { ok: true };
    }
    case "apply_patch":
      return validateApplyPatch(args);
    case "exec_command":
    case "run_command":
      return validateExecCommand(args);
    case "grep_code":
      return requireString(args, "query");
    case "create_goal":
      return requireString(args, "objective");
    case "update_goal":
      return requireString(args, "status");
    default:
      return { ok: true };
  }
}

export { BRIDGE_TOOLS };
