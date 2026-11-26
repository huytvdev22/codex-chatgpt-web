import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Copy } from "../i18n";
import { Icon } from "../icons";
import type {
  LauncherApi,
  LimitStatusKind,
  ProfileLimitEntry,
  ProviderLimitsSnapshot,
  UsageGroupSummary,
  UsageRange,
  UsageSettings,
  UsageSummary,
} from "../types";

const DEFAULT_SETTINGS: UsageSettings = {
  version: 1,
  showChatFooter: false,
  updatedAt: null,
};

const EMPTY_SUMMARY: UsageSummary = {
  range: "today",
  totals: {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    avgDurationMs: 0,
    lastContextTokens: null,
  },
  byProvider: [],
  byModel: [],
  recentTurns: [],
};

const AUTO_REFRESH_TTL_MS = 5 * 60 * 1000;

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatNum(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}

function formatDuration(ms: number): string {
  const sec = Math.max(0, ms) / 1000;
  return sec < 10 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`;
}

function formatProviderName(providerId: string): string {
  if (providerId === "m365-copilot") return "M365 Copilot";
  if (providerId === "ai-studio") return "Google AI Studio";
  if (providerId === "gemini") return "Gemini";
  if (providerId === "chatgpt") return "ChatGPT";
  return providerId;
}

function formatCheckedTime(iso: string | null, copy: Copy): string {
  if (!iso) return copy.limitsNeverChecked;
  try {
    return copy.limitsLastChecked.replace("{time}", new Date(iso).toLocaleString());
  } catch {
    return iso;
  }
}

function statusLabelFor(status: LimitStatusKind, copy: Copy): string {
  if (status === "ok") return copy.limitsStatusOk;
  if (status === "warning") return copy.limitsStatusWarning;
  if (status === "exhausted") return copy.limitsStatusExhausted;
  if (status === "signed_out") return copy.limitsStatusSignedOut;
  if (status === "challenge") return copy.limitsStatusChallenge;
  if (status === "busy") return copy.limitsStatusBusy;
  if (status === "error") return copy.limitsStatusError;
  if (status === "unsupported") return copy.limitsStatusUnsupported;
  return copy.limitsStatusUnchecked;
}

function isStaleForAutoRefresh(entry: ProfileLimitEntry): boolean {
  if (entry.support !== "supported" || !entry.isActive || !entry.authenticated) {
    return false;
  }
  if (!entry.checkedAt) return true;
  const parsed = Date.parse(entry.checkedAt);
  if (!Number.isFinite(parsed)) return true;
  return Date.now() - parsed > AUTO_REFRESH_TTL_MS;
}

export function UsageSurface({
  api,
  copy,
  setError,
}: {
  api: LauncherApi;
  copy: Copy;
  setError: (error: string | null) => void;
}) {
  const [range, setRange] = useState<UsageRange>("today");
  const [settings, setSettings] = useState<UsageSettings>(DEFAULT_SETTINGS);
  const [summary, setSummary] = useState<UsageSummary>(EMPTY_SUMMARY);
  const [limitsSnapshot, setLimitsSnapshot] = useState<ProviderLimitsSnapshot | null>(null);
  const [limitsLoading, setLimitsLoading] = useState(true);
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const autoCheckedRef = useRef(false);

  const loadUsage = useCallback(
    async (targetRange: UsageRange) => {
      setLoading(true);
      setError(null);
      try {
        const payload = await api.getUsage(targetRange);
        setSettings(payload.settings);
        setSummary(payload.summary);
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        setLoading(false);
      }
    },
    [api, setError],
  );

  const loadLimits = useCallback(async () => {
    setLimitsLoading(true);
    try {
      const next = await api.getLimits();
      setLimitsSnapshot(next);
      return next;
    } catch {
      return null;
    } finally {
      setLimitsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadUsage(range);
  }, [loadUsage, range]);

  useEffect(() => {
    let cancelled = false;
    void loadLimits().then(async (initial) => {
      if (cancelled || !initial || autoCheckedRef.current) return;
      autoCheckedRef.current = true;
      const staleTargets = initial.entries.filter(isStaleForAutoRefresh);
      for (const target of staleTargets) {
        if (cancelled) break;
        const key = `${target.providerId}::${target.profileId}`;
        setRefreshingKey(key);
        try {
          const outcome = await api.refreshLimits(target.providerId, target.profileId);
          if (!cancelled && outcome?.snapshot) {
            setLimitsSnapshot(outcome.snapshot);
          }
        } catch {
          // Bỏ qua im lặng khi auto-refresh lúc mở tab (vd runtime offline hoặc provider đang bận)
        } finally {
          if (!cancelled) {
            setRefreshingKey((current) => (current === key ? null : current));
          }
        }
      }
    });

    const unsubscribeLimits = api.onLimitsChanged((next) => {
      setLimitsSnapshot(next);
    });
    return () => {
      cancelled = true;
      unsubscribeLimits();
    };
  }, [api, loadLimits]);

  const handleRefreshLimits = async (providerId?: string, profileId?: string) => {
    const key = providerId && profileId ? `${providerId}::${profileId}` : "__all__";
    if (refreshingKey) return;
    setRefreshingKey(key);
    setError(null);
    try {
      const outcome = await api.refreshLimits(providerId, profileId);
      if (outcome?.snapshot) {
        setLimitsSnapshot(outcome.snapshot);
      }
      const busyItem = outcome?.results?.find((r) => r.status === "busy");
      if (busyItem) {
        setError(copy.limitsBusyHint);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setRefreshingKey(null);
    }
  };

  const handleToggleFooter = async () => {
    const next: UsageSettings = {
      ...settings,
      showChatFooter: !settings.showChatFooter,
    };
    setSettings(next);
    setSaving(true);
    setError(null);
    try {
      const payload = await api.saveUsageSettings(next, range);
      setSettings(payload.settings);
      setSummary(payload.summary);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    setSaving(true);
    setError(null);
    try {
      const payload = await api.clearUsageHistory(range);
      setSettings(payload.settings);
      setSummary(payload.summary);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  const { supportedGroups, unsupportedNames } = useMemo(() => {
    const entries = limitsSnapshot?.entries ?? [];
    const groups = new Map<string, ProfileLimitEntry[]>();
    const unsupported = new Set<string>();
    for (const entry of entries) {
      if (entry.support === "unsupported") {
        unsupported.add(formatProviderName(entry.providerId));
        continue;
      }
      const list = groups.get(entry.providerId) ?? [];
      list.push(entry);
      groups.set(entry.providerId, list);
    }
    return {
      supportedGroups: [...groups.entries()],
      unsupportedNames: [...unsupported],
    };
  }, [limitsSnapshot]);

  const renderGroupList = (groups: UsageGroupSummary[], isProvider: boolean) => {
    if (groups.length === 0) {
      return <div className="personalization-empty">{copy.usageEmpty}</div>;
    }
    const maxTokens = Math.max(1, ...groups.map((g) => g.totalTokens));
    return (
      <div className="usage-group-list">
        {groups.map((group) => {
          const share = summary.totals.totalTokens > 0
            ? Math.round((group.totalTokens * 100) / summary.totals.totalTokens)
            : 0;
          const barWidth = Math.max(4, Math.round((group.totalTokens * 100) / maxTokens));
          return (
            <div className="usage-group-row" key={group.key}>
              <div className="usage-group-top">
                <div className="usage-group-title">
                  <strong>{isProvider ? formatProviderName(group.key) : group.key}</strong>
                  <small>
                    {group.turns} {copy.usageTurnsUnit} · {share}%
                  </small>
                </div>
                <div className="usage-group-metrics">
                  <strong>{formatNum(group.totalTokens)} tok</strong>
                  <small>
                    in {formatNum(group.inputTokens)} / out {formatNum(group.outputTokens)}
                    {group.lastContextTokens !== null
                      ? ` · ctx ${formatNum(group.lastContextTokens)}`
                      : ""}
                  </small>
                </div>
              </div>
              <div className="usage-bar-track">
                <div className="usage-bar-fill" style={{ width: `${barWidth}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <section className="content-surface">
      <div className="content-scroll is-narrow">
        <header className="surface-header">
          <h1>{copy.usageTitle}</h1>
          <p>{copy.usageSubtitle}</p>
        </header>

        <div className="usage-limits-section">
          <div className="usage-limits-header">
            <div>
              <div className="section-heading">
                <span>{copy.limitsSectionTitle}</span>
              </div>
              <p className="usage-limits-subtitle">{copy.limitsSectionSubtitle}</p>
            </div>
            <button
              className="text-button"
              disabled={limitsLoading || refreshingKey !== null}
              onClick={() => void handleRefreshLimits()}
              type="button"
            >
              <Icon
                name="reload"
                style={{ width: 13, height: 13, marginRight: 4, verticalAlign: "-2px" }}
              />
              {refreshingKey === "__all__" ? copy.limitsRefreshing : copy.limitsRefreshAll}
            </button>
          </div>

          {limitsLoading && !limitsSnapshot ? (
            <div className="surface-empty">
              <span className="tab-spinner" />
              <span>{copy.loading}</span>
            </div>
          ) : (
            <div className="usage-limits-groups">
              {supportedGroups.map(([providerId, entries]) => (
                <div className="usage-limits-provider-group" key={providerId}>
                  <div className="usage-limits-provider-title">
                    <strong>{formatProviderName(providerId)}</strong>
                    {entries[0]?.scopeNote ? (
                      <small>{entries[0].scopeNote}</small>
                    ) : null}
                  </div>
                  <div className="usage-limits-card-list">
                    {entries.map((entry) => {
                      const entryKey = `${entry.providerId}::${entry.profileId}`;
                      const isRefreshing =
                        refreshingKey === entryKey || refreshingKey === "__all__";
                      return (
                        <article
                          className={`usage-limit-card is-${entry.status}`}
                          key={entryKey}
                        >
                          <header className="usage-limit-card-head">
                            <div className="usage-limit-card-identity">
                              <strong>{entry.profileName}</strong>
                              {entry.isActive ? (
                                <span className="profile-active-badge">
                                  {copy.limitsActiveProfile}
                                </span>
                              ) : null}
                              {entry.planName ? (
                                <span className="usage-limit-plan-pill">
                                  {entry.planName}
                                </span>
                              ) : null}
                              <span className={`usage-limit-status-pill is-${entry.status}`}>
                                {statusLabelFor(entry.status, copy)}
                              </span>
                            </div>
                            <button
                              className="text-button"
                              disabled={refreshingKey !== null}
                              onClick={() =>
                                void handleRefreshLimits(entry.providerId, entry.profileId)
                              }
                              type="button"
                            >
                              {isRefreshing ? copy.limitsRefreshing : copy.usageRefresh}
                            </button>
                          </header>

                          {entry.buckets.length > 0 ? (
                            <ul className="usage-limit-buckets">
                              {entry.buckets.map((bucket) => (
                                <li className="usage-limit-bucket" key={bucket.id}>
                                  <div className="usage-limit-bucket-row">
                                    <span className="usage-limit-bucket-label">
                                      {bucket.label}
                                    </span>
                                    <span className="usage-limit-bucket-value">
                                      {bucket.percentUsed !== null
                                        ? bucket.remainingText || `${100 - bucket.percentUsed}% left`
                                        : bucket.remainingText || "—"}
                                    </span>
                                  </div>
                                  {bucket.percentUsed !== null ? (
                                    <progress
                                      aria-label={`${entry.profileName} ${bucket.label}`}
                                      className={`usage-limit-progress is-${bucket.severity}`}
                                      max={100}
                                      value={bucket.percentUsed}
                                    />
                                  ) : null}
                                  {bucket.resetText || bucket.usedText ? (
                                    <div className="usage-limit-bucket-meta">
                                      <span>{bucket.usedText || ""}</span>
                                      <span>{bucket.resetText || ""}</span>
                                    </div>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          ) : entry.lastError ? (
                            <p className="usage-limit-note is-error">{entry.lastError}</p>
                          ) : entry.rawSummary ? (
                            <p className="usage-limit-note">{entry.rawSummary}</p>
                          ) : !entry.authenticated ? (
                            <p className="usage-limit-note">{copy.limitsNotSignedInHint}</p>
                          ) : null}

                          <footer className="usage-limit-card-foot">
                            <span>{formatCheckedTime(entry.checkedAt, copy)}</span>
                            {entry.providerUpdatedText ? (
                              <span>{entry.providerUpdatedText}</span>
                            ) : null}
                          </footer>
                        </article>
                      );
                    })}
                  </div>
                </div>
              ))}

              {unsupportedNames.length > 0 ? (
                <div className="usage-limits-unsupported">
                  <span>{copy.limitsUnsupportedProviders}:</span>
                  <strong>{unsupportedNames.join(" · ")}</strong>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="settings-list">
          <div className="setting-row">
            <div>
              <strong>{copy.usageShowFooter}</strong>
              <p>{copy.usageShowFooterBody}</p>
            </div>
            <button
              aria-checked={settings.showChatFooter}
              className={`switch${settings.showChatFooter ? " is-on" : ""}`}
              disabled={saving}
              onClick={() => void handleToggleFooter()}
              role="switch"
              type="button"
            >
              <span />
            </button>
          </div>
        </div>

        <div className="usage-toolbar">
          <div className="usage-range-pills" role="group">
            {(
              [
                ["today", copy.usageRangeToday],
                ["7d", copy.usageRange7d],
                ["30d", copy.usageRange30d],
                ["all", copy.usageRangeAll],
              ] as const
            ).map(([key, label]) => (
              <button
                className={`usage-range-pill${range === key ? " is-active" : ""}`}
                key={key}
                onClick={() => {
                  setConfirmClear(false);
                  setRange(key);
                }}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
          <div className="usage-toolbar-actions">
            <button
              className="text-button"
              disabled={loading || saving}
              onClick={() => void loadUsage(range)}
              type="button"
            >
              <Icon name="reload" style={{ width: 13, height: 13, marginRight: 4, verticalAlign: "-2px" }} />
              {copy.usageRefresh}
            </button>
            {confirmClear ? (
              <button
                className="text-button"
                onClick={() => setConfirmClear(false)}
                type="button"
              >
                {copy.personalizationCancelEdit}
              </button>
            ) : null}
            <button
              className="text-button"
              disabled={loading || saving || summary.totals.turns === 0}
              onClick={() => void handleClear()}
              type="button"
            >
              {confirmClear ? copy.usageConfirmClear : copy.usageClear}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="surface-empty">
            <span className="tab-spinner" />
            <span>{copy.loading}</span>
          </div>
        ) : (
          <>
            <div className="usage-kpi-grid">
              <div className="usage-kpi-card">
                <small>{copy.usageKpiTotal}</small>
                <strong>{formatNum(summary.totals.totalTokens)}</strong>
                <span>
                  in {formatNum(summary.totals.inputTokens)} / out {formatNum(summary.totals.outputTokens)}
                </span>
              </div>
              <div className="usage-kpi-card">
                <small>{copy.usageKpiTurns}</small>
                <strong>{formatNum(summary.totals.turns)}</strong>
                <span>
                  {copy.usageAvgLatency}: {formatDuration(summary.totals.avgDurationMs)}
                </span>
              </div>
              <div className="usage-kpi-card">
                <small>{copy.usageKpiLastContext}</small>
                <strong>{formatNum(summary.totals.lastContextTokens)}</strong>
                <span>{copy.usageContextUnit}</span>
              </div>
            </div>

            <div className="section-heading is-spaced">
              <span>{copy.usageSectionByProvider}</span>
            </div>
            {renderGroupList(summary.byProvider, true)}

            <div className="section-heading is-spaced">
              <span>{copy.usageSectionByModel}</span>
            </div>
            {renderGroupList(summary.byModel, false)}
          </>
        )}
      </div>
    </section>
  );
}
