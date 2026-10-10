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
      return requireString(args, "cmd");
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
