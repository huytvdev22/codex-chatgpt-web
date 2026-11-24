import { useCallback, useEffect, useState } from "react";
import type { Copy } from "../i18n";
import { Icon } from "../icons";
import type {
  LauncherApi,
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
  if (providerId === "chatgpt") return "ChatGPT";
  return providerId;
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

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

  useEffect(() => {
    void loadUsage(range);
  }, [loadUsage, range]);

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
