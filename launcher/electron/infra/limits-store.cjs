const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const DEFAULT_WARNING_THRESHOLD_PERCENT = 80;
const DEFAULT_CYCLE_WINDOW_MS = 24 * 60 * 60 * 1000;
const SUPPORTED_LIMIT_PROVIDERS = new Set(["chatgpt", "gemini"]);

function toRuntimeProviderId(providerId) {
  const clean = typeof providerId === "string" ? providerId.trim().toLowerCase() : "";
  if (clean === "m365") return "m365-copilot";
  return clean;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readOfflineLimitsFile(filePath) {
  const empty = { version: 1, updatedAt: null, entries: {} };
  if (!filePath || !fs.existsSync(filePath)) return empty;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!isPlainObject(raw)) return empty;
    return {
      version: 1,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
      entries: isPlainObject(raw.entries) ? raw.entries : {},
    };
  } catch {
    return empty;
  }
}

function readOfflineCycleUsageMap(limitsFilePath, nowMs) {
  const byProfileKey = new Map();
  if (!limitsFilePath) return byProfileKey;
  const cyclesFilePath = path.join(path.dirname(limitsFilePath), "profile-quota-cycles.json");
  if (!fs.existsSync(cyclesFilePath)) return byProfileKey;
  try {
    const raw = JSON.parse(fs.readFileSync(cyclesFilePath, "utf8"));
    if (!isPlainObject(raw) || !isPlainObject(raw.entries)) return byProfileKey;
    for (const rawEntry of Object.values(raw.entries)) {
      if (!isPlainObject(rawEntry)) continue;
      const providerId = typeof rawEntry.providerId === "string" ? rawEntry.providerId.trim().toLowerCase() : "";
      const profileId = typeof rawEntry.profileId === "string" && rawEntry.profileId.trim()
        ? rawEntry.profileId.trim().toLowerCase()
        : "default";
      const modelSlug = typeof rawEntry.modelSlug === "string" && rawEntry.modelSlug.trim()
        ? rawEntry.modelSlug.trim().toLowerCase()
        : "default";
      const cycleStartedAtMs = typeof rawEntry.cycleStartedAtMs === "number" && Number.isFinite(rawEntry.cycleStartedAtMs)
        ? rawEntry.cycleStartedAtMs
        : typeof rawEntry.cycleStartedAt === "string" && Number.isFinite(Date.parse(rawEntry.cycleStartedAt))
          ? Date.parse(rawEntry.cycleStartedAt)
          : NaN;
      if (!providerId || !Number.isFinite(cycleStartedAtMs)) continue;

      const pendingResetAtMs = typeof rawEntry.pendingResetAtMs === "number" && Number.isFinite(rawEntry.pendingResetAtMs)
        ? rawEntry.pendingResetAtMs
        : null;
      const hasPendingResetPassed =
        pendingResetAtMs !== null && nowMs >= pendingResetAtMs && cycleStartedAtMs < pendingResetAtMs;
      const hasDefaultWindowExpired =
        pendingResetAtMs === null && nowMs - cycleStartedAtMs >= DEFAULT_CYCLE_WINDOW_MS;
      if (hasPendingResetPassed || hasDefaultWindowExpired) continue;

      const tokensUsed = typeof rawEntry.tokensUsed === "number" && Number.isFinite(rawEntry.tokensUsed)
        ? Math.max(0, Math.round(rawEntry.tokensUsed))
        : 0;
      const turnsUsed = typeof rawEntry.turnsUsed === "number" && Number.isFinite(rawEntry.turnsUsed)
        ? Math.max(0, Math.round(rawEntry.turnsUsed))
        : 0;
      if (tokensUsed <= 0 && turnsUsed <= 0) continue;

      const profileKey = `${providerId}::${profileId}`;
      const list = byProfileKey.get(profileKey) ?? [];
      list.push({
        modelSlug,
        tokensUsed,
        turnsUsed,
        cycleStartedAt: typeof rawEntry.cycleStartedAt === "string"
          ? rawEntry.cycleStartedAt
          : new Date(cycleStartedAtMs).toISOString(),
        lastResetAt: typeof rawEntry.lastResetAt === "string" ? rawEntry.lastResetAt : null,
      });
      byProfileKey.set(profileKey, list);
    }
    for (const list of byProfileKey.values()) {
      list.sort((a, b) => b.tokensUsed - a.tokensUsed || b.turnsUsed - a.turnsUsed);
    }
  } catch {
    return byProfileKey;
  }
  return byProfileKey;
}

function buildOfflineLimitsSnapshot(filePath, providersList = []) {
  const file = readOfflineLimitsFile(filePath);
  const nowMs = Date.now();
  const cycleUsageMap = readOfflineCycleUsageMap(filePath, nowMs);
  const normalizedProviders = [];
  const seenProviderIds = new Set();

  for (const item of Array.isArray(providersList) ? providersList : []) {
    const runtimeId = toRuntimeProviderId(item?.id);
    if (!runtimeId || seenProviderIds.has(runtimeId)) continue;
    seenProviderIds.add(runtimeId);
    const activeId = item?.activeProfileId || "default";
    const profiles = Array.isArray(item?.profiles) && item.profiles.length > 0
      ? item.profiles.map((p) => ({
          id: p.id || "default",
          name: p.name || p.id || "Default",
          isActive: (p.id || "default") === activeId,
          authenticated: p.authenticated === true,
        }))
      : [{
          id: "default",
          name: "Default",
          isActive: true,
          authenticated: item?.authenticated === true,
        }];
    normalizedProviders.push({ runtimeId, profiles });
  }

  if (normalizedProviders.length === 0) {
    for (const runtimeId of ["m365-copilot", "ai-studio", "gemini", "chatgpt"]) {
      normalizedProviders.push({
        runtimeId,
        profiles: [{ id: "default", name: "Default", isActive: true, authenticated: false }],
      });
    }
  }

  const entries = [];
  for (const group of normalizedProviders) {
    const support = SUPPORTED_LIMIT_PROVIDERS.has(group.runtimeId) ? "supported" : "unsupported";
    for (const profile of group.profiles) {
      const entryKey = `${group.runtimeId}::${profile.id}`;
      const cached = file.entries[entryKey];
      const cycleUsage = cycleUsageMap.get(entryKey);
      const cycleUsagePatch = Array.isArray(cycleUsage) && cycleUsage.length > 0 ? { cycleUsage } : {};
      if (support === "unsupported") {
        if (
          profile.authenticated
          && cached
          && isPlainObject(cached)
          && cached.status === "exhausted"
          && cached.sourceKind === "dom-fallback"
        ) {
          const activeBuckets = Array.isArray(cached.buckets)
            ? cached.buckets.filter((b) => !b?.resetAt || Date.parse(b.resetAt) > nowMs)
            : [];
          if (activeBuckets.length > 0) {
            entries.push({
              providerId: group.runtimeId,
              profileId: profile.id,
              profileName: profile.name,
              isActive: profile.isActive,
              authenticated: profile.authenticated,
              support,
              status: "exhausted",
              planName: null,
              sourceUrl: cached.sourceUrl ?? null,
              sourceKind: "dom-fallback",
              scopeNote: cached.scopeNote ?? null,
              providerUpdatedText: cached.providerUpdatedText ?? null,
              buckets: activeBuckets,
              ...cycleUsagePatch,
              rawSummary: cached.rawSummary ?? null,
              checkedAt: cached.checkedAt ?? null,
              lastError: cached.lastError ?? null,
            });
            continue;
          }
        }
        entries.push({
          providerId: group.runtimeId,
          profileId: profile.id,
          profileName: profile.name,
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
          ...cycleUsagePatch,
          rawSummary: null,
          checkedAt: null,
          lastError: null,
        });
        continue;
      }

      if (!cached || !isPlainObject(cached)) {
        entries.push({
          providerId: group.runtimeId,
          profileId: profile.id,
          profileName: profile.name,
          isActive: profile.isActive,
          authenticated: profile.authenticated,
          support,
          status: profile.authenticated ? "unchecked" : "signed_out",
          planName: null,
          sourceUrl: null,
          sourceKind: null,
          scopeNote: null,
          providerUpdatedText: null,
          buckets: [],
          ...cycleUsagePatch,
          rawSummary: null,
          checkedAt: null,
          lastError: null,
        });
        continue;
      }

      entries.push({
        providerId: group.runtimeId,
        profileId: profile.id,
        profileName: profile.name,
        isActive: profile.isActive,
        authenticated: profile.authenticated,
        support,
        status: profile.authenticated ? (cached.status || "unchecked") : "signed_out",
        planName: profile.authenticated ? (cached.planName ?? null) : null,
        sourceUrl: cached.sourceUrl ?? null,
        sourceKind: cached.sourceKind ?? null,
        scopeNote: cached.scopeNote ?? null,
        providerUpdatedText: cached.providerUpdatedText ?? null,
        buckets: profile.authenticated && Array.isArray(cached.buckets) ? cached.buckets : [],
        ...cycleUsagePatch,
        rawSummary: cached.rawSummary ?? null,
        checkedAt: cached.checkedAt ?? null,
        lastError: cached.lastError ?? null,
      });
    }
  }

  return {
    version: 1,
    updatedAt: file.updatedAt,
    configPath: filePath,
    warningThresholdPercent: DEFAULT_WARNING_THRESHOLD_PERCENT,
    entries,
  };
}

class LimitsStore {
  constructor({ limitsFilePath, getRuntimeConnection, getProvidersList }) {
    this.limitsFilePath = limitsFilePath;
    this.getRuntimeConnection = getRuntimeConnection;
    this.getProvidersList = getProvidersList;
  }

  async requestRuntime(method, endpoint, body, timeoutMs = 8_000) {
    const conn = this.getRuntimeConnection?.();
    if (!conn || !conn.host || !conn.port || !conn.controlToken) {
      return { connected: false };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://${conn.host}:${conn.port}${endpoint}`, {
        method,
        headers: {
          authorization: `Bearer ${conn.controlToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload?.error || `Runtime returned HTTP ${response.status}`;
        const err = new Error(message);
        err.statusCode = response.status;
        err.code = payload?.code;
        err.fromRuntimeHttp = true;
        throw err;
      }
      return { connected: true, payload };
    } catch (error) {
      if (error?.fromRuntimeHttp) throw error;
      return { connected: false, cause: error };
    } finally {
      clearTimeout(timer);
    }
  }

  async getSnapshot() {
    const remote = await this.requestRuntime("GET", "/admin/limits");
    if (remote.connected && remote.payload?.snapshot) {
      return remote.payload.snapshot;
    }
    return buildOfflineLimitsSnapshot(
      this.limitsFilePath,
      this.getProvidersList?.() ?? [],
    );
  }

  async refreshLimits({ providerId, profileId } = {}) {
    const body = {};
    if (typeof providerId === "string" && providerId.trim()) {
      body.providerId = providerId.trim();
    }
    if (typeof profileId === "string" && profileId.trim()) {
      body.profileId = profileId.trim();
    }
    const remote = await this.requestRuntime(
      "POST",
      "/admin/limits/refresh",
      body,
      90_000,
    );
    if (!remote.connected || !remote.payload?.snapshot) {
      throw new Error(
        "Local runtime is offline. Complete Setup or start the runtime before refreshing account limits.",
      );
    }
    return {
      snapshot: remote.payload.snapshot,
      results: remote.payload.results || [],
    };
  }

  ensureConfigFileExists() {
    if (!fs.existsSync(this.limitsFilePath)) {
      writePrivateFileAtomic(
        this.limitsFilePath,
        `${JSON.stringify({ version: 1, updatedAt: null, entries: {} }, null, 2)}\n`,
      );
    }
    return this.limitsFilePath;
  }
}

function createLimitsStore(limitsFilePath, getRuntimeConnection, getProvidersList) {
  return new LimitsStore({ limitsFilePath, getRuntimeConnection, getProvidersList });
}

module.exports = {
  LimitsStore,
  buildOfflineLimitsSnapshot,
  createLimitsStore,
};
