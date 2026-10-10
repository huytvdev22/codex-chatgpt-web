export type SandboxPermission = "use_default" | "require_escalated";

export interface CodexExecCommandArguments {
  cmd: string;
  sandbox_permissions: SandboxPermission;
  justification?: string;
  prefix_rule?: string[];
  workdir?: string;
  shell?: string;
  tty?: boolean;
  login?: boolean;
  yield_time_ms?: number;
  max_output_tokens?: number;
}

export interface CommandApprovalDecision {
  sandboxPermissions: SandboxPermission;
  justification?: string;
  prefixRule?: string[];
}

/**
 * Kiểm tra approval metadata theo contract do adapter sở hữu.
 * Không suy đoán quyền từ nội dung command và không hard-code chính sách theo từng lệnh.
 */
export function validateCommandApproval(
  args: Record<string, unknown>
): CommandApprovalDecision {
  const requested = args.sandbox_permissions;
  if (
    requested !== undefined
    && requested !== "use_default"
    && requested !== "require_escalated"
  ) {
    throw new Error(
      "[M365 Tool Approval Error] sandbox_permissions must be use_default or require_escalated."
    );
  }

  if (requested !== "require_escalated") {
    return { sandboxPermissions: "use_default" };
  }

  const justification = typeof args.justification === "string"
    ? args.justification.trim()
    : "";
  if (!justification) {
    throw new Error(
      "[M365 Tool Approval Error] justification is required for require_escalated."
    );
  }

  let prefixRule: string[] | undefined;
  if (args.prefix_rule !== undefined) {
    if (
      !Array.isArray(args.prefix_rule)
      || args.prefix_rule.length === 0
      || args.prefix_rule.some(
        part => typeof part !== "string" || part.trim().length === 0
      )
    ) {
      throw new Error(
        "[M365 Tool Approval Error] prefix_rule must be a non-empty string array."
      );
    }
    prefixRule = args.prefix_rule.map(part => String(part).trim());
  }

  return {
    sandboxPermissions: "require_escalated",
    justification,
    ...(prefixRule ? { prefixRule } : {}),
  };
}

/**
 * Chuyển contract exec_command nội bộ sang đúng wire format mà Codex quảng bá.
 * Adapter chỉ validate và forward approval metadata, không phân loại command.
 */
export function buildCodexExecCommandArguments(
  args: Record<string, unknown>,
  commandOverride?: string
): CodexExecCommandArguments {
  const cmd = String(commandOverride ?? args.cmd ?? args.command ?? "").trim();
  const decision = validateCommandApproval(args);

  const result: CodexExecCommandArguments = {
    cmd,
    sandbox_permissions: decision.sandboxPermissions,
  };

  if (decision.justification) result.justification = decision.justification;
  if (decision.prefixRule) result.prefix_rule = decision.prefixRule;
  if (typeof args.workdir === "string" && args.workdir.trim()) result.workdir = args.workdir;
  if (typeof args.shell === "string" && args.shell.trim()) result.shell = args.shell;
  if (typeof args.tty === "boolean") result.tty = args.tty;
  if (typeof args.login === "boolean") result.login = args.login;
  if (typeof args.yield_time_ms === "number") result.yield_time_ms = args.yield_time_ms;
  if (typeof args.max_output_tokens === "number") result.max_output_tokens = args.max_output_tokens;

  return result;
}
