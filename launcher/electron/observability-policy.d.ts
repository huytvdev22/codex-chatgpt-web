export const OBS_PREFIX_V1: string;
export const OBS_PROTOCOL_VERSION: number;
export const MAX_EVENT_PAYLOAD_BYTES: number;
export const VALID_LEVELS: readonly string[];
export const VALID_SOURCES: readonly string[];
export const STRUCTURED_DETAIL_EXPORT_ALLOWLIST: Record<string, readonly string[]>;
export const EVENT_SAFE_DETAILS_ALLOWLIST: Record<string, readonly string[]>;
export function filterSafeDetailsForExport(
  event: string,
  safeDetails: Record<string, unknown> | null | undefined
): Record<string, unknown>;

declare const policy: {
  OBS_PREFIX_V1: string;
  OBS_PROTOCOL_VERSION: number;
  MAX_EVENT_PAYLOAD_BYTES: number;
  VALID_LEVELS: readonly string[];
  VALID_SOURCES: readonly string[];
  STRUCTURED_DETAIL_EXPORT_ALLOWLIST: Record<string, readonly string[]>;
  EVENT_SAFE_DETAILS_ALLOWLIST: Record<string, readonly string[]>;
  filterSafeDetailsForExport(
    event: string,
    safeDetails: Record<string, unknown> | null | undefined
  ): Record<string, unknown>;
};

export default policy;
