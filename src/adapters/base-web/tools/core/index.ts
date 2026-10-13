export { SafeCommandGuard, type StructuredRefusalPayload, type CommandValidationResult } from "./safe-command-guard";
export { ToolArgumentNormalizer, DEFAULT_TOOL_NAME_ALIASES, type NormalizedToolArguments } from "./argument-normalizer";
export { ToolContentDecoder, type ContentEncoding, type DecodeContentOptions, type NormalizeFileContentOptions } from "./content-decoder";
export { ToolApprovalPolicy, type SandboxPermission, type CodexExecCommandArguments, type CommandApprovalDecision } from "./approval-policy";
export { ToolCallValidator, DEFAULT_BRIDGE_TOOLS, type ToolValidationResult, type ToolValidationSuccess, type ToolValidationFailure } from "./tool-validator";
export { BaseToolBridge } from "./base-tool-bridge";
export {
  AtomicFileWriter,
  defaultAtomicFileWriter,
  computeSha256,
  createStagingFile,
  type AtomicWriteResult,
  type StagingFileResult,
  type AtomicWriteOptions,
  type IAtomicFileWriter,
} from "./atomic-file-writer";

import { ToolArgumentNormalizer } from "./argument-normalizer";
import { ToolCallValidator } from "./tool-validator";
import { ToolApprovalPolicy } from "./approval-policy";
import { ToolContentDecoder } from "./content-decoder";

export const normalizeToolArguments = ToolArgumentNormalizer.normalizeToolArguments.bind(ToolArgumentNormalizer);
export const normalizeM365ToolArguments = normalizeToolArguments;
export const validateToolCall = ToolCallValidator.validateToolCall.bind(ToolCallValidator);
export const validateM365ToolCall = validateToolCall;
export const validateCommandApproval = ToolApprovalPolicy.validateCommandApproval.bind(ToolApprovalPolicy);
export const buildCodexExecCommandArguments = ToolApprovalPolicy.buildCodexExecCommandArguments.bind(ToolApprovalPolicy);
export const normalizeFileContent = ToolContentDecoder.normalizeFileContent.bind(ToolContentDecoder);
