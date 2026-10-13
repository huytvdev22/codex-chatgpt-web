import {
  ToolApprovalPolicy,
  type SandboxPermission,
  type CodexExecCommandArguments,
  type CommandApprovalDecision,
} from "../../base-web/tools";

export type { SandboxPermission, CodexExecCommandArguments, CommandApprovalDecision };

export function validateCommandApproval(args: Record<string, unknown>): CommandApprovalDecision {
  return ToolApprovalPolicy.validateCommandApproval(args);
}

export function buildCodexExecCommandArguments(
  args: Record<string, unknown>,
  commandOverride?: string
): CodexExecCommandArguments {
  return ToolApprovalPolicy.buildCodexExecCommandArguments(args, commandOverride);
}
