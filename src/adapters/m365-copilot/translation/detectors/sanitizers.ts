/**
 * Facade tương thích ngược cho Sanitizers
 * Toàn bộ core implementations đã chuyển sang src/adapters/base-web/translation/
 */
export {
  generateToolCallId,
  normalizeToolName,
  balanceJsonBraces,
  cleanJsonPayload,
  sanitizeJsonControlChars,
  normalizePatchEnvelope,
  sanitizeCodexPatchContent,
  stripOuterCodeFence,
} from "../../../base-web/translation";
