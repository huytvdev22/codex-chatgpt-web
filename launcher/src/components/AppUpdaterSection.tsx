import { useEffect, useState } from "react";
import type { Copy } from "../i18n";
import { Icon } from "../icons";
import type {
  LauncherApi,
  UpdateState,
  UpdaterSettings,
} from "../types";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return `${Math.max(1, Math.round(kb))} KB`;
}

function formatCheckedAt(iso: string | null | undefined, copy: Copy): string | null {
  if (!iso) return null;
  try {
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return null;
    return copy.updaterLastChecked.replace("{time}", parsed.toLocaleString());
  } catch {
    return null;
  }
}

function badgeFor(update: UpdateState, copy: Copy): { label: string; tone: "neutral" | "success" | "warning" | "error" } {
  const version = update.version || update.availableRelease?.version || "";
  switch (update.status) {
    case "checking":
      return { label: copy.updaterStatusChecking, tone: "neutral" };
    case "up-to-date":
      return { label: copy.updaterStatusUpToDate, tone: "success" };
    case "available":
      return { label: copy.updaterStatusAvailable.replace("{version}", version), tone: "warning" };
    case "downloading":
      return {
        label: copy.updaterStatusDownloading.replace("{percent}", String(update.progress?.percent ?? 0)),
        tone: "neutral",
      };
    case "downloaded":
      return { label: copy.updaterStatusDownloaded.replace("{version}", version), tone: "success" };
    case "installing":
      return { label: copy.updating, tone: "neutral" };
    case "error":
      return { label: copy.updaterStatusError, tone: "error" };
    case "idle":
    default:
      return { label: `v${update.currentVersion || ""}`, tone: "neutral" };
  }
}

export function AppUpdaterSection({
  api,
  copy,
  update,
  updaterSettings,
  currentVersion,
  platformLabelText,
  arch,
  installBlocked,
  highlighted = false,
  onUpdaterSettingsChanged,
  setError,
}: {
  api: LauncherApi;
  copy: Copy;
  update: UpdateState;
  updaterSettings: UpdaterSettings | null;
  currentVersion: string;
  platformLabelText: string;
  arch?: string;
  installBlocked: boolean;
  highlighted?: boolean;
  onUpdaterSettingsChanged: (next: UpdaterSettings) => void;
  setError: (error: string | null) => void;
}) {
  const [installing, setInstalling] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [localSettings, setLocalSettings] = useState<UpdaterSettings | null>(updaterSettings);

  useEffect(() => {
    setLocalSettings(updaterSettings);
  }, [updaterSettings]);

  if (update.status === "disabled") return null;

  const badge = badgeFor(update, copy);
  const isBusy = update.status === "checking" || update.status === "downloading" || update.status === "installing";
  const checkedLabel = formatCheckedAt(update.lastCheckedAt ?? localSettings?.lastCheckedAt, copy);
  const release = update.availableRelease;

  const handleCheck = async () => {
    setError(null);
    setStatusNotice(null);
    try {
      const next = await api.checkForUpdates({ manual: true });
      if (next.status === "up-to-date") {
        setStatusNotice(copy.updaterUpToDateNotice.replace("{version}", currentVersion));
      } else if (next.status === "error" && next.message) {
        setError(next.message);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleDownload = async () => {
    setError(null);
    setStatusNotice(null);
    try {
      const next = await api.downloadUpdate();
      if (next.status === "error" && next.message) {
        setError(next.message);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleCancelDownload = async () => {
    setError(null);
    try {
      await api.cancelUpdateDownload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleInstall = async () => {
    setInstalling(true);
    setError(null);
    setStatusNotice(null);
    try {
      const result = await api.installUpdate();
      if (result && typeof result === "object" && result.installed === false && result.message) {
        setStatusNotice(result.message);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInstalling(false);
    }
  };

  const handleOpenFolder = async () => {
    setError(null);
    try {
      await api.openUpdateFolder();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleIgnore = async () => {
    setError(null);
    setStatusNotice(null);
    try {
      await api.ignoreUpdateVersion();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleToggleAutoCheck = async (checked: boolean) => {
    setError(null);
    try {
      const updated = await api.saveUpdaterSettings({ autoCheckOnStartup: checked });
      setLocalSettings(updated);
      onUpdaterSettingsChanged(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className={`updater-card${highlighted ? " is-highlighted" : ""}`} data-testid="app-updater-card">
      <div className="updater-card-header">
        <div className="updater-card-title">
          <Icon name="spark" />
          <strong>{copy.updaterTitle}</strong>
        </div>
        <span className={`updater-status-badge is-${badge.tone}`}>
          {badge.label}
        </span>
      </div>

      <div className="updater-summary-row">
        <div className="updater-version-meta">
          <div>
            <span>{copy.updaterCurrentVersion}: </span>
            <code>v{currentVersion}</code>
            <span className="updater-platform-chip">
              {platformLabelText}{arch ? ` · ${arch}` : ""}
            </span>
          </div>
          {checkedLabel ? <small>{checkedLabel}</small> : null}
        </div>
        <button
          className="button-primary"
          disabled={isBusy}
          onClick={() => void handleCheck()}
          type="button"
        >
          <Icon name="reload" />
          <span>{update.status === "checking" ? copy.updaterStatusChecking : copy.updaterCheckAction}</span>
        </button>
      </div>

      {localSettings ? (
        <div className="updater-auto-check-row">
          <div>
            <strong>{copy.updaterAutoCheck}</strong>
            <small>{copy.updaterAutoCheckBody}</small>
          </div>
          <button
            aria-checked={localSettings.autoCheckOnStartup}
            className={`switch${localSettings.autoCheckOnStartup ? " is-on" : ""}`}
            onClick={() => void handleToggleAutoCheck(!localSettings.autoCheckOnStartup)}
            role="switch"
            type="button"
          >
            <span />
          </button>
        </div>
      ) : null}

      {update.status === "error" && update.message ? (
        <div className="updater-banner is-error" role="alert">
          <Icon name="alert" />
          <span>{update.message}</span>
        </div>
      ) : null}

      {statusNotice ? (
        <div className="updater-banner is-info" role="status">
          <Icon name="info" />
          <span>{statusNotice}</span>
        </div>
      ) : null}

      {release && (update.status === "available" || update.status === "downloading" || update.status === "downloaded" || update.status === "installing") ? (
        <div className="updater-release-box">
          <div className="updater-release-head">
            <div>
              <strong>{copy.updaterNewRelease.replace("{tag}", release.tagName)}</strong>
              <div className="updater-release-meta">
                <code>{release.assetName}</code>
                {release.assetSize > 0 ? <span> · {formatBytes(release.assetSize)}</span> : null}
              </div>
            </div>
            {update.status === "available" ? (
              <button
                className="updater-ignore-btn"
                onClick={() => void handleIgnore()}
                type="button"
              >
                {copy.updaterSkipVersion}
              </button>
            ) : null}
          </div>

          {release.notes ? (
            <pre className="updater-release-notes">{release.notes}</pre>
          ) : null}

          {update.status === "downloading" && update.progress ? (
            <div className="updater-progress-section">
              <div className="updater-progress-track">
                <div
                  className="updater-progress-fill"
                  style={{ width: `${Math.max(2, update.progress.percent)}%` }}
                />
              </div>
              <div className="updater-progress-meta">
                <span>
                  {update.progress.percent}% · {formatBytes(update.progress.bytesDownloaded)} / {formatBytes(update.progress.totalBytes)}
                </span>
                {update.progress.speedBytesPerSec > 0 ? (
                  <span>{formatBytes(update.progress.speedBytesPerSec)}/s</span>
                ) : null}
              </div>
            </div>
          ) : null}

          {update.status === "downloaded" && update.verifiedSha256 ? (
            <div className="updater-verified-row">
              <Icon name="check" />
              <span>
                {copy.updaterVerifiedSha}: <code>{update.verifiedSha256.slice(0, 16)}…</code>
              </span>
            </div>
          ) : null}

          {update.status === "downloaded" && installBlocked ? (
            <p className="updater-blocked-hint">{copy.updaterInstallBlockedHint}</p>
          ) : null}

          <div className="updater-release-actions">
            {update.status === "available" ? (
              <button
                className="button-primary"
                onClick={() => void handleDownload()}
                type="button"
              >
                <Icon name="update" />
                <span>
                  {release.assetSize > 0
                    ? `${copy.updaterDownload} (${formatBytes(release.assetSize)})`
                    : copy.updaterDownload}
                </span>
              </button>
            ) : null}

            {update.status === "downloading" ? (
              <button
                className="button-secondary"
                onClick={() => void handleCancelDownload()}
                type="button"
              >
                <Icon name="close" />
                <span>{copy.updaterCancelDownload}</span>
              </button>
            ) : null}

            {update.status === "downloaded" || update.status === "installing" ? (
              <>
                <button
                  className="button-primary"
                  disabled={installing || installBlocked || update.status === "installing"}
                  onClick={() => void handleInstall()}
                  type="button"
                >
                  <Icon name="reload" />
                  <span>{update.status === "installing" || installing ? copy.updating : copy.updaterInstallAndRestart}</span>
                </button>
                <button
                  className="button-secondary"
                  disabled={installing || update.status === "installing"}
                  onClick={() => void handleOpenFolder()}
                  type="button"
                >
                  <Icon name="folder" />
                  <span>{copy.updaterOpenFolder}</span>
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
