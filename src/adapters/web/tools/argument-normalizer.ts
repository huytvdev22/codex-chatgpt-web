import { WebToolRegistry } from "./web-tool-registry";

const TOOL_NAME_ALIASES = WebToolRegistry.ALIASES;

export interface NormalizedToolArguments {
  name: string;
  arguments: Record<string, unknown>;
}

export function normalizeWebToolName(name: string): string {
  return WebToolRegistry.normalizeToolName(name);
}

function parseArguments(argumentsValue: Record<string, unknown> | string): Record<string, unknown> {
  if (argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)) {
    return { ...argumentsValue };
  }
  if (typeof argumentsValue !== "string") return {};
  try {
    const parsed = JSON.parse(argumentsValue);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...parsed } : {};
  } catch {
    return {};
  }
}

/** Chuẩn hóa alias cấu trúc; tuyệt đối không decode hay sửa nội dung file/patch. */
export function normalizeWebToolArguments(
  name: string,
  argumentsValue: Record<string, unknown> | string
): NormalizedToolArguments {
  const normalizedName = normalizeWebToolName(name);
  const args = parseArguments(argumentsValue);

  if (normalizedName === "exec_command" || normalizedName === "run_command") {
    if (args.cmd === undefined && args.command !== undefined) args.cmd = args.command;
  }
  if (["read_file", "write_file", "list_dir", "search_files", "grep_code", "git_diff", "view_image"].includes(normalizedName)) {
    if (args.path === undefined && args.file !== undefined) args.path = args.file;
    if (args.path === undefined && args.dir !== undefined) args.path = args.dir;
  }
  if (normalizedName === "apply_patch") {
    if (args.input === undefined && args.patch !== undefined) args.input = args.patch;
    if (args.input === undefined && args.content !== undefined) args.input = args.content;
  }

  return { name: normalizedName, arguments: args };
}

export { TOOL_NAME_ALIASES };
