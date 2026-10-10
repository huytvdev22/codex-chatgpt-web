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
  M365ToolBridge,
  normalizeFileContent,
  TOOL_HANDLERS,
} from "./tool-bridge";

export {
  normalizeM365ToolArguments,
  normalizeM365ToolName,
  TOOL_NAME_ALIASES,
  type NormalizedToolArguments,
} from "./argument-normalizer";

export {
  decodeM365Content,
  normalizeFileContent as normalizeFileContentExact,
  type DecodeContentOptions,
  type M365ContentEncoding,
  type NormalizeFileContentOptions,
} from "./content-decoder";

export {
  validateM365ToolCall,
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

export * from "./command-strategies";
