import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../config";
import {
  readLauncherBrowserHostDescriptor,
  type LauncherDescriptorProviderProfiles,
} from "../launcher-browser-host";
import { LimitStore } from "./limit-store";
import {
  formatResetRemainingText,
  ProfileCooldownStore,
} from "./profile-cooldown-store";
import { ProfileQuotaCycleStore } from "./profile-quota-cycle-store";
import { ProfileFailoverSettingsStore } from "./profile-failover-settings-store";
import { ThreadProfileBindingStore } from "./thread-profile-binding-store";
import { toLauncherProviderId, type ProviderLimitBucket } from "./types";

export interface InitialProfileResolution {
  profileId: string | undefined;
  pinnedByCaller: boolean;
  switchedFromStickyOrActive: boolean;
  eligibleProfileIds: string[];
}

export interface QuotaFailureHandlingResult {
  shouldFailover: boolean;
  failedProfileId: string;
  nextProfileId?: string;
}

export function normalizeFailoverModelSlug(
  providerId: string,
  modelId?: string,
): string {
  const cleanProvider = providerId.trim().toLowerCase();
  const cleanModel = (modelId ?? "").trim().toLowerCase();
  if (!cleanModel) return "default";
  if (cleanProvider && cleanModel.startsWith(`${cleanProvider}/`)) {
    return cleanModel.slice(cleanProvider.length + 1).trim() || "default";
  }
  const slashIdx = cleanModel.indexOf("/");
  if (slashIdx >= 0) {
    return cleanModel.slice(slashIdx + 1).trim() || "default";
  }
  return cleanModel;
}

function defaultResolveDescriptorProfiles(
  providerId: string,
  explicitDescriptorPath?: string,
): LauncherDescriptorProviderProfiles | null {
  const candidates = [
    ...(explicitDescriptorPath ? [explicitDescriptorPath] : []),
    join(getConfigDir(), "runtime", "launcher-browser.json"),
    join(homedir(), ".codex-m365-copilot", "runtime", "launcher-browser.json"),
    join(homedir(), ".codex-chatgpt-web", "runtime", "launcher-browser.json"),
  ];
  const descriptorPath = candidates.find((candidate) => existsSync(candidate));
  if (!descriptorPath) return null;
  try {
    const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
    const launcherId = toLauncherProviderId(providerId);
    const group =
      descriptor.providerProfiles?.[launcherId] ??
      descriptor.providerProfiles?.[providerId];
    return group ?? null;
  } catch {
    return null;
  }
}

/**
 * Điều phối lựa chọn profile đầu lượt, ghi nhận cooldown bị động khi gặp
 * lỗi hết hạn mức (`insufficient_quota`) và tự động failover sang profile
 * khác đã đăng nhập chưa bị limit khi cờ cấu hình được bật.
 */
export class ProfileFailoverCoordinator {
  private static readonly defaultInstance = new ProfileFailoverCoordinator();

  constructor(
    private readonly settingsStore: ProfileFailoverSettingsStore = ProfileFailoverSettingsStore.getInstance(),
    private readonly cooldownStore: ProfileCooldownStore = ProfileCooldownStore.getInstance(),
    private readonly threadProfileStore: ThreadProfileBindingStore = new ThreadProfileBindingStore(),
    private readonly limitStore: LimitStore = LimitStore.getInstance(),
    private readonly profilesResolver: (
      providerId: string,
      explicitDescriptorPath?: string,
    ) => LauncherDescriptorProviderProfiles | null = defaultResolveDescriptorProfiles,
    private readonly cycleStore: ProfileQuotaCycleStore = ProfileQuotaCycleStore.getInstance(),
  ) {}

  public static getInstance(): ProfileFailoverCoordinator {
    return ProfileFailoverCoordinator.defaultInstance;
  }

  public isAutoSwitchEnabled(): boolean {
    return this.settingsStore.isAutoSwitchEnabled();
  }

  public resolveInitialProfile(params: {
    providerId: string;
    modelId: string;
    threadId?: string;
    explicitProfileId?: string;
    descriptorPath?: string;
    nowMs?: number;
  }): InitialProfileResolution {
    const cleanExplicit = params.explicitProfileId?.trim().toLowerCase();
    if (cleanExplicit) {
      return {
        profileId: cleanExplicit,
        pinnedByCaller: true,
        switchedFromStickyOrActive: false,
        eligibleProfileIds: [cleanExplicit],
      };
    }

    const nowMs = params.nowMs ?? Date.now();
    const modelSlug = normalizeFailoverModelSlug(
      params.providerId,
      params.modelId,
    );
    const group = this.profilesResolver(
      params.providerId,
      params.descriptorPath,
    );
    if (!group || !Array.isArray(group.profiles) || group.profiles.length === 0) {
      const sticky = this.threadProfileStore.get(
        params.threadId,
        params.providerId,
      );
      return {
        profileId: sticky?.profileId,
        pinnedByCaller: false,
        switchedFromStickyOrActive: false,
        eligibleProfileIds: sticky ? [sticky.profileId] : [],
      };
    }

    const authenticatedProfiles = group.profiles.filter(
      (entry) => entry.authenticated === true,
    );
    const eligibleProfileIds = authenticatedProfiles.map((entry) => entry.id);
    if (eligibleProfileIds.length === 0) {
      return {
        profileId: group.activeProfileId || undefined,
        pinnedByCaller: false,
        switchedFromStickyOrActive: false,
        eligibleProfileIds: [],
      };
    }

    const sticky = this.threadProfileStore.get(
      params.threadId,
      params.providerId,
    );
    const stickyValid =
      sticky && eligibleProfileIds.includes(sticky.profileId)
        ? sticky.profileId
        : undefined;
    const activeValid = eligibleProfileIds.includes(group.activeProfileId)
      ? group.activeProfileId
      : eligibleProfileIds[0];
    const candidateProfileId = stickyValid ?? activeValid;

    if (
      this.settingsStore.isAutoSwitchEnabled() &&
      this.cooldownStore.isCoolingDown(
        params.providerId,
        candidateProfileId,
        modelSlug,
        nowMs,
      )
    ) {
      const nextProfileId = this.pickNextAvailableProfile(
        params.providerId,
        modelSlug,
        eligibleProfileIds,
        new Set([candidateProfileId]),
        candidateProfileId,
        nowMs,
      );
      if (nextProfileId) {
        this.threadProfileStore.bind(
          params.threadId,
          params.providerId,
          nextProfileId,
          modelSlug,
        );
        return {
          profileId: nextProfileId,
          pinnedByCaller: false,
          switchedFromStickyOrActive: Boolean(stickyValid),
          eligibleProfileIds,
        };
      }
    }

    return {
      profileId: candidateProfileId,
      pinnedByCaller: false,
      switchedFromStickyOrActive: false,
      eligibleProfileIds,
    };
  }

  public handleQuotaFailure(params: {
    providerId: string;
    modelId: string;
    profileId?: string;
    threadId?: string;
    errorMessage: string;
    pinnedByCaller: boolean;
    attemptedProfileIds: ReadonlySet<string>;
    hasEmittedOutput: boolean;
    descriptorPath?: string;
    nowMs?: number;
  }): QuotaFailureHandlingResult {
    const nowMs = params.nowMs ?? Date.now();
    const modelSlug = normalizeFailoverModelSlug(
      params.providerId,
      params.modelId,
    );
    const group = this.profilesResolver(
      params.providerId,
      params.descriptorPath,
    );
    const failedProfileId =
      params.profileId?.trim().toLowerCase() ||
      group?.activeProfileId?.trim().toLowerCase() ||
      "default";

    const cooldownEntry = this.cooldownStore.markExhausted({
      providerId: params.providerId,
      profileId: failedProfileId,
      modelSlug,
      message: params.errorMessage,
      nowMs,
    });
    this.cycleStore.markExhaustedWindow({
      providerId: params.providerId,
      profileId: failedProfileId,
      modelSlug,
      resetAtMs: cooldownEntry.cooldownUntilMs,
      nowMs,
    });

    const failedProfileMeta = group?.profiles.find(
      (item) => item.id === failedProfileId,
    );
    this.syncPassiveCooldownToLimitStore(
      params.providerId,
      failedProfileId,
      failedProfileMeta?.name,
      params.errorMessage,
      nowMs,
    );

    if (
      params.pinnedByCaller ||
      params.hasEmittedOutput ||
      !this.settingsStore.isAutoSwitchEnabled()
    ) {
      return {
        shouldFailover: false,
        failedProfileId,
      };
    }

    const eligibleProfileIds = (group?.profiles ?? [])
      .filter((item) => item.authenticated === true)
      .map((item) => item.id);
    const attempted = new Set(params.attemptedProfileIds);
    attempted.add(failedProfileId);

    const nextProfileId = this.pickNextAvailableProfile(
      params.providerId,
      modelSlug,
      eligibleProfileIds,
      attempted,
      failedProfileId,
      nowMs,
    );
    if (!nextProfileId) {
      return {
        shouldFailover: false,
        failedProfileId,
      };
    }

    this.threadProfileStore.bind(
      params.threadId,
      params.providerId,
      nextProfileId,
      modelSlug,
    );
    return {
      shouldFailover: true,
      failedProfileId,
      nextProfileId,
    };
  }

  public recordTurnSuccess(params: {
    providerId: string;
    modelId: string;
    profileId?: string;
    threadId?: string;
    tokensUsed?: number;
    nowMs?: number;
  }): void {
    const cleanProfile = params.profileId?.trim().toLowerCase();
    if (!cleanProfile) return;
    const modelSlug = normalizeFailoverModelSlug(
      params.providerId,
      params.modelId,
    );
    if (params.threadId) {
      this.threadProfileStore.bind(
        params.threadId,
        params.providerId,
        cleanProfile,
        modelSlug,
      );
    }
    const nowMs = params.nowMs ?? Date.now();
    if (typeof params.tokensUsed === "number" && Number.isFinite(params.tokensUsed)) {
      this.cycleStore.recordTurnUsage({
        providerId: params.providerId,
        profileId: cleanProfile,
        modelSlug,
        tokensUsed: params.tokensUsed,
        nowMs,
      });
    }
    const activeCooldowns = this.cooldownStore.listActiveCooldownsForProfile(
      params.providerId,
      cleanProfile,
      nowMs,
    );
    if (activeCooldowns.length === 0) {
      this.limitStore.clearPassiveExhaustedIfExpired(
        params.providerId,
        cleanProfile,
      );
    }
  }

  private pickNextAvailableProfile(
    providerId: string,
    modelSlug: string,
    eligibleProfileIds: readonly string[],
    excluded: ReadonlySet<string>,
    anchorProfileId: string,
    nowMs: number,
  ): string | undefined {
    if (eligibleProfileIds.length === 0) return undefined;
    const startIdx = Math.max(0, eligibleProfileIds.indexOf(anchorProfileId));
    let bestCandidate: string | undefined;
    let bestTokens = Number.POSITIVE_INFINITY;
    for (let offset = 1; offset <= eligibleProfileIds.length; offset += 1) {
      const candidate =
        eligibleProfileIds[(startIdx + offset) % eligibleProfileIds.length];
      if (!candidate || excluded.has(candidate)) continue;
      if (
        this.cooldownStore.isCoolingDown(
          providerId,
          candidate,
          modelSlug,
          nowMs,
        )
      ) {
        continue;
      }
      const tokensUsed = this.cycleStore.getTokensUsedInCurrentCycle(
        providerId,
        candidate,
        modelSlug,
        nowMs,
      );
      if (tokensUsed < bestTokens) {
        bestTokens = tokensUsed;
        bestCandidate = candidate;
      }
    }
    return bestCandidate;
  }

  private syncPassiveCooldownToLimitStore(
    providerId: string,
    profileId: string,
    profileName: string | undefined,
    errorMessage: string,
    nowMs: number,
  ): void {
    const activeCooldowns = this.cooldownStore.listActiveCooldownsForProfile(
      providerId,
      profileId,
      nowMs,
    );
    if (activeCooldowns.length === 0) return;
    const buckets: ProviderLimitBucket[] = activeCooldowns.map((entry) => ({
      id: `cooldown:${entry.modelSlug}`,
      label: entry.modelSlug,
      percentUsed: 100,
      remainingText: "0 remaining",
      resetAt: entry.resetAt,
      resetText: `Resets in ${formatResetRemainingText(entry.cooldownUntilMs, nowMs)}`,
      severity: "exhausted",
    }));
    const rawSummary = activeCooldowns
      .map(
        (entry) =>
          `${entry.modelSlug}: limit reached (resets in ${formatResetRemainingText(entry.cooldownUntilMs, nowMs)})`,
      )
      .join(" | ");
    this.limitStore.savePassiveCooldownResult({
      providerId,
      profileId,
      profileName,
      buckets,
      rawSummary,
      lastError: errorMessage.trim().slice(0, 500),
      checkedAt: new Date(nowMs).toISOString(),
    });
  }
}

export const profileFailoverCoordinator =
  ProfileFailoverCoordinator.getInstance();
