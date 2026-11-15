export {
  AtomicFileWriter,
  defaultAtomicFileWriter,
  type IAtomicFileWriter,
  type AtomicWriteResult,
  type StagingFileResult,
  computeSha256,
  createStagingFile,
} from "./atomic-file-writer";

export {
  WebToolBridge,
  type WebRawToolCall,
  type WebMappedToolCall,
  normalizeFileContent,
} from "./tool-bridge";

export {
  normalizeWebToolArguments,
  normalizeWebToolName,
  TOOL_NAME_ALIASES,
  type NormalizedToolArguments,
} from "./argument-normalizer";

export {
  decodeWebContent,
  normalizeFileContent as normalizeFileContentExact,
  type DecodeContentOptions,
  type WebContentEncoding,
  type NormalizeFileContentOptions,
} from "./content-decoder";

export {
  validateWebToolCall,
  BRIDGE_TOOLS,
  type ToolValidationResult,
  type ToolValidationSuccess,
  type ToolValidationFailure,
} from "./tool-validator";

export {
  SafeCommandGuard,
  type StructuredRefusalPayload,
  type CommandValidationResult,
} from "./safe-command-guard";

export {
  validateCommandApproval,
  buildCodexExecCommandArguments,
  type SandboxPermission,
  type CodexExecCommandArguments,
  type CommandApprovalDecision,
} from "./approval-policy";
