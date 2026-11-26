export type LimitSupportKind = "supported" | "unsupported";

export type LimitStatusKind =
  | "ok"
  | "warning"
  | "exhausted"
  | "signed_out"
  | "challenge"
  | "busy"
  | "error"
  | "unsupported"
  | "unchecked";

export type LimitBucketSeverity = "ok" | "warning" | "exhausted" | "info";

export type LimitSourceKind = "network-json" | "dom" | "dom-fallback";

export const DEFAULT_LIMIT_WARNING_THRESHOLD_PERCENT = 80;

export interface ProviderLimitBucket {
  id: string;
  label: string;
  percentUsed: number | null;
  usedText?: string;
  remainingText?: string;
  resetAt?: string | null;
  resetText?: string | null;
  severity: LimitBucketSeverity;
}

export interface ProviderLimitCheckResult {
  status: Exclude<LimitStatusKind, "unsupported" | "unchecked" | "busy">;
  planName?: string | null;
  sourceUrl: string;
  sourceKind: LimitSourceKind;
  scopeNote?: string | null;
  providerUpdatedText?: string | null;
  buckets: ProviderLimitBucket[];
  rawSummary?: string | null;
  lastError?: string | null;
}

export interface StoredProfileLimitRecord {
  providerId: string;
  profileId: string;
  profileName?: string;
  status: Exclude<LimitStatusKind, "unsupported" | "unchecked" | "busy">;
  planName: string | null;
  sourceUrl: string | null;
  sourceKind: LimitSourceKind | null;
  scopeNote: string | null;
  providerUpdatedText: string | null;
  buckets: ProviderLimitBucket[];
  rawSummary: string | null;
  checkedAt: string | null;
  lastError: string | null;
}

export interface LimitStoreFile {
  version: 1;
  updatedAt: string | null;
  entries: Record<string, StoredProfileLimitRecord>;
}

export interface ProfileLimitEntry {
  providerId: string;
  profileId: string;
  profileName: string;
  isActive: boolean;
  authenticated: boolean;
  support: LimitSupportKind;
  status: LimitStatusKind;
  planName: string | null;
  sourceUrl: string | null;
  sourceKind: LimitSourceKind | null;
  scopeNote: string | null;
  providerUpdatedText: string | null;
  buckets: ProviderLimitBucket[];
  rawSummary: string | null;
  checkedAt: string | null;
  lastError: string | null;
}

export interface ProviderLimitsSnapshot {
  version: 1;
  updatedAt: string | null;
  configPath: string;
  warningThresholdPercent: number;
  entries: ProfileLimitEntry[];
}

export interface LimitRefreshTargetResult {
  providerId: string;
  profileId: string;
  profileName: string;
  status: LimitStatusKind;
  message?: string;
}

export function buildLimitEntryKey(providerId: string, profileId: string): string {
  return `${providerId}::${profileId || "default"}`;
}

export function toRuntimeProviderId(providerId: string): string {
  const clean = providerId.trim().toLowerCase();
  if (clean === "m365") return "m365-copilot";
  return clean;
}

export function toLauncherProviderId(providerId: string): string {
  const clean = providerId.trim().toLowerCase();
  if (clean === "m365-copilot") return "m365";
  return clean;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function computeLimitBucketSeverity(
  percentUsed: number | null,
  warningThresholdPercent = DEFAULT_LIMIT_WARNING_THRESHOLD_PERCENT,
): LimitBucketSeverity {
  if (percentUsed === null || !Number.isFinite(percentUsed)) return "info";
  if (percentUsed >= 100) return "exhausted";
  if (percentUsed >= warningThresholdPercent) return "warning";
  return "ok";
}

export function computeOverallLimitStatus(
  buckets: readonly ProviderLimitBucket[],
  limitReached = false,
  warningThresholdPercent = DEFAULT_LIMIT_WARNING_THRESHOLD_PERCENT,
): "ok" | "warning" | "exhausted" {
  if (limitReached) return "exhausted";
  let highestSeverity: "ok" | "warning" | "exhausted" = "ok";
  for (const bucket of buckets) {
    if (bucket.percentUsed === null) continue;
    const sev = computeLimitBucketSeverity(bucket.percentUsed, warningThresholdPercent);
    if (sev === "exhausted") return "exhausted";
    if (sev === "warning") highestSeverity = "warning";
  }
  return highestSeverity;
}
