const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  readfile: "read_file",
  listdir: "list_dir",
  searchfiles: "search_files",
  grepcode: "grep_code",
  gitstatus: "git_status",
  gitdiff: "git_diff",
  execcommand: "exec_command",
  applypatch: "apply_patch",
  writefile: "write_file",
  requestuserinput: "request_user_input",
};

export interface NormalizedToolArguments {
  name: string;
  arguments: Record<string, unknown>;
}

export function normalizeM365ToolName(name: string): string {
  const withoutNamespace = name.startsWith("functions.") ? name.slice("functions.".length) : name;
  return TOOL_NAME_ALIASES[withoutNamespace] || withoutNamespace;
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
export function normalizeM365ToolArguments(
  name: string,
  argumentsValue: Record<string, unknown> | string
): NormalizedToolArguments {
  const normalizedName = normalizeM365ToolName(name);
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
