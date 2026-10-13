import type { NormalizedCodexRequest } from "../dto/canonical-types.dto";
import type { CodexRawPayload } from "../core/codex-raw-payload";

export interface NormalizerOptions {
  defaultModel?: string;
  imageRefPrefix?: string;
  maxInputImages?: number;
}

export interface ICodexPayloadNormalizer {
  normalize(rawPayload: CodexRawPayload, options?: NormalizerOptions): NormalizedCodexRequest;
}
