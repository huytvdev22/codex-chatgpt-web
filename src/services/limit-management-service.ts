import { dirname, join } from "node:path";
import { AdapterRegistry } from "../adapters/adapter-registry";
import { activeWebTurnRegistry, ProviderBusyError } from "../adapters/web";
import { resolveLauncherDescriptorPath } from "../adapters/web/launcher-runtime";
import {
  readLauncherBrowserHostDescriptor,
  type LauncherBrowserHostDescriptor,
} from "../launcher-browser-host";
import {
  buildLimitEntryKey,
  DEFAULT_LIMIT_WARNING_THRESHOLD_PERCENT,
  formatResetRemainingText,
  LimitStore,
  ProfileCooldownStore,
  toLauncherProviderId,
  toRuntimeProviderId,
  type LimitRefreshTargetResult,
  type LimitSupportKind,
  type ProfileLimitEntry,
  type ProviderLimitBucket,
  type ProviderLimitsSnapshot,
  type StoredProfileLimitRecord,
} from "../limits";
import { ModelConfigError } from "../models/model-config-store";
import { ModelRegistry } from "../models/model-registry";

const SUPPORTED_LIMIT_PROVIDERS = new Set(["chatgpt", "gemini"]);

export interface KnownProviderProfile {
  providerId: string;
  profileId: string;
  profileName: string;
  isActive: boolean;
  authenticated: boolean;
}

export interface RefreshLimitsOptions {
  providerId?: string;
  profileId?: string;
  abortSignal?: AbortSignal;
}

export interface RefreshLimitsOutcome {
  readonly snapshot: ProviderLimitsSnapshot;
  readonly results: readonly LimitRefreshTargetResult[];
}

function supportKindForProvider(providerId: string): LimitSupportKind {
  return SUPPORTED_LIMIT_PROVIDERS.has(providerId) ? "supported" : "unsupported";
}

function classifyErrorToStatus(
  message: string,
): "signed_out" | "challenge" | "error" {
  const lower = message.toLowerCase();
  if (
    lower.includes("signed out") ||
    lower.includes("sign in") ||
    lower.includes("log in") ||
    lower.includes("chưa đăng nhập") ||
    lower.includes("hết hạn đăng nhập")
  ) {
    return "signed_out";
  }
  if (lower.includes("cloudflare") || lower.includes("verification page")) {
    return "challenge";
  }
  return "error";
}

/**
 * Tầng nghiệp vụ điều phối kiểm tra hạn mức tài khoản theo từng `(providerId, profileId)`,
 * hợp nhất danh sách profile từ Launcher descriptor và cache `provider-limits.json`.
 */
export class LimitManagementService {
  private readonly cooldownStore: ProfileCooldownStore;

  constructor(
    private readonly limitStore: LimitStore = LimitStore.getInstance(),
    private readonly modelRegistry: ModelRegistry = ModelRegistry.getInstance(),
    private readonly adapterRegistry: AdapterRegistry = AdapterRegistry.getInstance(),
    private readonly descriptorResolver: () => LauncherBrowserHostDescriptor | null = () => {
      const descriptorPath = resolveLauncherDescriptorPath();
      if (!descriptorPath) return null;
      try {
        return readLauncherBrowserHostDescriptor(descriptorPath);
      } catch {
        return null;
      }
    },
    cooldownStore?: ProfileCooldownStore,
  ) {
    this.cooldownStore =
      cooldownStore ??
      (limitStore === LimitStore.getInstance()
        ? ProfileCooldownStore.getInstance()
        : new ProfileCooldownStore(
            join(dirname(limitStore.resolveFilePath()), "profile-cooldowns.json"),
          ));
  }

  private listKnownProfiles(): {
    profiles: KnownProviderProfile[];
    fromDescriptor: boolean;
  } {
    const providerIds = this.modelRegistry.listProviders().map((p) => p.id);
    const descriptor = this.descriptorResolver();
    const descriptorProfiles = descriptor?.providerProfiles;
    const activeLauncherProvider = descriptor?.provider
      ? toRuntimeProviderId(descriptor.provider)
      : null;

    if (descriptorProfiles && typeof descriptorProfiles === "object") {
      const results: KnownProviderProfile[] = [];
      for (const providerId of providerIds) {
        const launcherId = toLauncherProviderId(providerId);
        const group =
          descriptorProfiles[launcherId] ?? descriptorProfiles[providerId];
        if (group && Array.isArray(group.profiles) && group.profiles.length > 0) {
          const activeId = group.activeProfileId || "default";
          for (const item of group.profiles) {
            results.push({
              providerId,
              profileId: item.id,
              profileName: item.name || item.id,
              isActive: item.id === activeId,
              authenticated: item.authenticated === true,
            });
          }
          continue;
        }
        results.push({
          providerId,
          profileId: "default",
          profileName: "Default",
          isActive: true,
          authenticated: activeLauncherProvider === providerId,
        });
      }
      return { profiles: results, fromDescriptor: true };
    }

    const storeFile = this.limitStore.readFile();
    const byProvider = new Map<string, KnownProviderProfile[]>();
    for (const providerId of providerIds) {
      byProvider.set(providerId, []);
    }
    for (const cached of Object.values(storeFile.entries)) {
      const list = byProvider.get(cached.providerId);
      if (!list) continue;
      if (list.some((p) => p.profileId === cached.profileId)) continue;
      list.push({
        providerId: cached.providerId,
        profileId: cached.profileId,
        profileName: cached.profileName || (cached.profileId === "default" ? "Default" : cached.profileId),
        isActive: cached.profileId === "default",
        authenticated: cached.status !== "signed_out",
      });
    }
    for (const [providerId, list] of byProvider.entries()) {
      if (list.length === 0) {
        list.push({
          providerId,
          profileId: "default",
          profileName: "Default",
          isActive: true,
          authenticated: false,
        });
      }
    }
    return {
      profiles: providerIds.flatMap((id) => byProvider.get(id) ?? []),
      fromDescriptor: false,
    };
  }

  public getSnapshot(): ProviderLimitsSnapshot {
    const { profiles, fromDescriptor } = this.listKnownProfiles();
    if (fromDescriptor) {
      const validKeys = new Set(
        profiles.map((p) => buildLimitEntryKey(p.providerId, p.profileId)),
      );
      const prunableProviders = new Set(profiles.map((p) => p.providerId));
      this.limitStore.pruneRemovedProfiles(validKeys, prunableProviders);
    }

    const file = this.limitStore.readFile();
    const nowMs = Date.now();
    const entries: ProfileLimitEntry[] = profiles.map((profile) => {
      const support = supportKindForProvider(profile.providerId);
      const key = buildLimitEntryKey(profile.providerId, profile.profileId);
      const cached = file.entries[key];
      if (support === "unsupported") {
        const activeCooldowns = this.cooldownStore.listActiveCooldownsForProfile(
          profile.providerId,
          profile.profileId,
          nowMs,
        );
        const activePassiveBuckets =
          activeCooldowns.length > 0
            ? activeCooldowns.map<ProviderLimitBucket>((entry) => ({
                id: `cooldown:${entry.modelSlug}`,
                label: entry.modelSlug,
                percentUsed: 100,
                remainingText: "0 remaining",
                resetAt: entry.resetAt,
                resetText: `Resets in ${formatResetRemainingText(entry.cooldownUntilMs, nowMs)}`,
                severity: "exhausted",
              }))
            : cached?.status === "exhausted" && cached.sourceKind === "dom-fallback"
              ? cached.buckets.filter(
                  (b) => !b.resetAt || Date.parse(b.resetAt) > nowMs,
                )
              : [];

        if (activePassiveBuckets.length > 0) {
          if (fromDescriptor && !profile.authenticated) {
            return {
              providerId: profile.providerId,
              profileId: profile.profileId,
              profileName: profile.profileName,
              isActive: profile.isActive,
              authenticated: profile.authenticated,
              support,
              status: "signed_out",
              planName: null,
              sourceUrl: null,
              sourceKind: "dom-fallback",
              scopeNote: cached?.scopeNote ?? null,
              providerUpdatedText: null,
              buckets: [],
              rawSummary: null,
              checkedAt: cached?.checkedAt ?? null,
              lastError: null,
            };
          }
          const rawSummary =
            activeCooldowns.length > 0
              ? activeCooldowns
                  .map(
                    (entry) =>
                      `${entry.modelSlug}: limit reached (resets in ${formatResetRemainingText(entry.cooldownUntilMs, nowMs)})`,
                  )
                  .join(" | ")
              : cached?.rawSummary ?? null;
          return {
            providerId: profile.providerId,
            profileId: profile.profileId,
            profileName: profile.profileName,
            isActive: profile.isActive,
            authenticated: profile.authenticated,
            support,
            status: "exhausted",
            planName: null,
            sourceUrl: cached?.sourceUrl ?? null,
            sourceKind: "dom-fallback",
            scopeNote:
              cached?.scopeNote ?? "Passive quota limit detected during turn execution.",
            providerUpdatedText: cached?.providerUpdatedText ?? null,
            buckets: activePassiveBuckets,
            rawSummary,
            checkedAt: cached?.checkedAt ?? activeCooldowns[0]?.exhaustedAt ?? null,
            lastError: cached?.lastError ?? activeCooldowns[0]?.reason ?? null,
          };
        }

        if (cached?.status === "exhausted" && cached.sourceKind === "dom-fallback") {
          this.limitStore.clearPassiveExhaustedIfExpired(
            profile.providerId,
            profile.profileId,
          );
        }

        return {
          providerId: profile.providerId,
          profileId: profile.profileId,
          profileName: profile.profileName,
          isActive: profile.isActive,
          authenticated: profile.authenticated,
          support,
          status: "unsupported",
          planName: null,
          sourceUrl: null,
          sourceKind: null,
          scopeNote: null,
          providerUpdatedText: null,
          buckets: [],
          rawSummary: null,
          checkedAt: null,
          lastError: null,
        };
      }

      if (!cached) {
        return {
          providerId: profile.providerId,
          profileId: profile.profileId,
          profileName: profile.profileName,
          isActive: profile.isActive,
          authenticated: profile.authenticated,
          support,
          status:
            fromDescriptor && !profile.authenticated ? "signed_out" : "unchecked",
          planName: null,
          sourceUrl: null,
          sourceKind: null,
          scopeNote: null,
          providerUpdatedText: null,
          buckets: [],
          rawSummary: null,
          checkedAt: null,
          lastError: null,
        };
      }

      return {
        providerId: profile.providerId,
        profileId: profile.profileId,
        profileName: profile.profileName,
        isActive: profile.isActive,
        authenticated: profile.authenticated,
        support,
        status:
          fromDescriptor && !profile.authenticated ? "signed_out" : cached.status,
        planName:
          fromDescriptor && !profile.authenticated ? null : cached.planName,
        sourceUrl: cached.sourceUrl,
        sourceKind: cached.sourceKind,
        scopeNote: cached.scopeNote,
        providerUpdatedText: cached.providerUpdatedText,
        buckets:
          fromDescriptor && !profile.authenticated ? [] : cached.buckets,
        rawSummary: cached.rawSummary,
        checkedAt: cached.checkedAt,
        lastError: cached.lastError,
      };
    });

    return {
      version: 1,
      updatedAt: file.updatedAt,
      configPath: this.limitStore.resolveFilePath(),
      warningThresholdPercent: DEFAULT_LIMIT_WARNING_THRESHOLD_PERCENT,
      entries,
    };
  }

  public async refreshLimits(
    options: RefreshLimitsOptions = {},
  ): Promise<RefreshLimitsOutcome> {
    const requestedProviderId = options.providerId
      ? toRuntimeProviderId(options.providerId)
      : undefined;
    const requestedProfileId = options.profileId?.trim() || undefined;

    const knownProviders = this.modelRegistry.listProviders();
    if (
      requestedProviderId &&
      !knownProviders.some((p) => p.id === requestedProviderId)
    ) {
      throw new ModelConfigError(
        "PROVIDER_NOT_FOUND",
        `Unknown provider '${options.providerId}'.`,
        404,
      );
    }

    if (requestedProfileId && !requestedProviderId) {
      throw new ModelConfigError(
        "INVALID_MODEL_PATCH",
        "'providerId' is required when 'profileId' is specified.",
        400,
      );
    }

    const { profiles, fromDescriptor } = this.listKnownProfiles();
    let targets = profiles.filter((p) =>
      requestedProviderId ? p.providerId === requestedProviderId : true,
    );
    if (requestedProfileId) {
      targets = targets.filter((p) => p.profileId === requestedProfileId);
      if (targets.length === 0) {
        throw new ModelConfigError(
          "PROVIDER_NOT_FOUND",
          `Unknown profile '${requestedProfileId}' for provider '${requestedProviderId}'.`,
          404,
        );
      }
    }

    const isSingleTarget = Boolean(requestedProviderId && requestedProfileId) ||
      (Boolean(requestedProviderId) && targets.length === 1);

    // Nếu không truyền providerId (Refresh All), chỉ quét các provider hỗ trợ.
    if (!requestedProviderId) {
      targets = targets.filter(
        (p) => supportKindForProvider(p.providerId) === "supported",
      );
    }

    const results: LimitRefreshTargetResult[] = [];

    for (const target of targets) {
      const support = supportKindForProvider(target.providerId);
      if (support === "unsupported") {
        results.push({
          providerId: target.providerId,
          profileId: target.profileId,
          profileName: target.profileName,
          status: "unsupported",
          message: `Provider '${target.providerId}' does not expose a live usage limit dashboard.`,
        });
        continue;
      }

      // Khi refresh hàng loạt, bỏ qua profile chưa đăng nhập để không mở tab vô ích.
      if (fromDescriptor && !target.authenticated && !isSingleTarget) {
        this.limitStore.saveFailure({
          providerId: target.providerId,
          profileId: target.profileId,
          profileName: target.profileName,
          status: "signed_out",
          message: "Profile is not signed in.",
        });
        results.push({
          providerId: target.providerId,
          profileId: target.profileId,
          profileName: target.profileName,
          status: "signed_out",
          message: "Profile is not signed in.",
        });
        continue;
      }

      if (activeWebTurnRegistry.hasActiveTurnForProvider(target.providerId)) {
        const busyError = new ProviderBusyError(
          target.providerId,
          `Provider '${target.providerId}' is currently busy. Wait for the active turn to finish before checking limits.`,
        );
        if (isSingleTarget) throw busyError;
        results.push({
          providerId: target.providerId,
          profileId: target.profileId,
          profileName: target.profileName,
          status: "busy",
          message: busyError.message,
        });
        continue;
      }

      try {
        const adapter = this.adapterRegistry.createAdapter(target.providerId);
        if (typeof adapter.checkUsageLimit !== "function") {
          results.push({
            providerId: target.providerId,
            profileId: target.profileId,
            profileName: target.profileName,
            status: "unsupported",
            message: `Adapter '${target.providerId}' does not implement live usage limit checking.`,
          });
          continue;
        }

        const result = await adapter.checkUsageLimit(
          { profileId: target.profileId },
          { headers: new Headers(), abortSignal: options.abortSignal },
        );

        this.limitStore.saveCheckResult({
          providerId: target.providerId,
          profileId: target.profileId,
          profileName: target.profileName,
          result,
        });

        results.push({
          providerId: target.providerId,
          profileId: target.profileId,
          profileName: target.profileName,
          status: result.status,
          ...(result.lastError ? { message: result.lastError } : {}),
        });
      } catch (error) {
        if (error instanceof ProviderBusyError) {
          if (isSingleTarget) throw error;
          results.push({
            providerId: target.providerId,
            profileId: target.profileId,
            profileName: target.profileName,
            status: "busy",
            message: error.message,
          });
          continue;
        }

        const message = error instanceof Error ? error.message : String(error);
        const status = classifyErrorToStatus(message);
        this.limitStore.saveFailure({
          providerId: target.providerId,
          profileId: target.profileId,
          profileName: target.profileName,
          status,
          message,
        });
        results.push({
          providerId: target.providerId,
          profileId: target.profileId,
          profileName: target.profileName,
          status,
          message,
        });
      }
    }

    return {
      snapshot: this.getSnapshot(),
      results,
    };
  }
}
