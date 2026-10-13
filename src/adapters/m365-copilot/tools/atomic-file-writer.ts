/**
 * Facade tương thích ngược cho AtomicFileWriter
 * Toàn bộ core implementation đã chuyển sang src/adapters/base-web/tools/core/atomic-file-writer.ts
 */
export {
  AtomicFileWriter,
  defaultAtomicFileWriter,
  computeSha256,
  createStagingFile,
  type AtomicWriteResult,
  type StagingFileResult,
  type AtomicWriteOptions,
  type IAtomicFileWriter,
} from "../../base-web/tools/core/atomic-file-writer";
