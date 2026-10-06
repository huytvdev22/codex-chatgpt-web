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
  SafeCommandGuard,
  type StructuredRefusalPayload,
  type CommandValidationResult,
} from "./safe-command-guard";

export * from "./command-strategies";
