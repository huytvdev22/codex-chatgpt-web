import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { Copy } from "../i18n";
import { Icon } from "../icons";
import type {
  BrowserProviderInfo,
  BrowserState,
  LauncherApi,
  ManagedModelsSnapshot,
  ManagedModelView,
  ManagedProviderGroupView,
  ModelInputModality,
  ModelReasoningEffort,
  ProviderRefreshResult,
} from "../types";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function providerDisplayName(providerId: string): string {
  if (providerId === "m365-copilot") return "M365 Copilot";
  if (providerId === "ai-studio") return "Google AI Studio";
  if (providerId === "gemini") return "Gemini Web";
  if (providerId === "chatgpt") return "ChatGPT Web";
  return providerId;
}

function launcherProviderKey(providerId: string): string {
  if (providerId === "m365-copilot") return "m365";
  return providerId;
}

function formatContextCompact(tokens: number): string {
  if (tokens >= 1_000_000) {
    const val = tokens / 1_000_000;
    return `${Number.isInteger(val) ? val : val.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return String(tokens);
}

function formatReasoningLabel(effort: ModelReasoningEffort): string {
  if (effort === "low") return "Low";
  if (effort === "medium") return "Medium";
  return "High";
}

function formatTimeShort(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function ModelsSurface({
  api,
  browser,
  copy,
  providers,
  setError,
}: {
  api: LauncherApi;
  browser: BrowserState | null;
  copy: Copy;
  providers: BrowserProviderInfo[];
  setError: (error: string | null) => void;
}) {
  const [snapshot, setSnapshot] = useState<ManagedModelsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshingTarget, setRefreshingTarget] = useState<string | null>(null);
  const [refreshResults, setRefreshResults] = useState<Record<string, ProviderRefreshResult>>({});
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  const [editingModel, setEditingModel] = useState<ManagedModelView | null>(null);

  const [draftDisplayName, setDraftDisplayName] = useState("");
  const [draftContextWindow, setDraftContextWindow] = useState("");
  const [draftReasoning, setDraftReasoning] = useState<ModelReasoningEffort>("medium");
  const [draftSupportsImage, setDraftSupportsImage] = useState(true);

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const dialogTitleId = useId();

  const loadModels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.getModels();
      setSnapshot(next);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, [api, setError]);

  useEffect(() => {
    void loadModels();
    const unsubscribe = api.onModelsChanged((next) => {
      setSnapshot(next);
    });
    return () => {
      unsubscribe();
    };
  }, [api, loadModels]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (editingModel) {
      setDraftDisplayName(editingModel.displayName);
      setDraftContextWindow(String(editingModel.contextWindow));
      setDraftReasoning(editingModel.defaultReasoningLevel);
      setDraftSupportsImage(editingModel.inputModalities.includes("image"));
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [editingModel]);

  const totalModels = useMemo(
    () => (snapshot ? snapshot.providers.reduce((sum, group) => sum + group.totalCount, 0) : 0),
    [snapshot],
  );

  const isProviderSignedIn = useCallback(
    (runtimeProviderId: string): boolean => {
      const launcherKey = launcherProviderKey(runtimeProviderId);
      const authMap = browser?.authenticatedByProvider ?? {};
      if (typeof authMap[launcherKey] === "boolean") {
        return authMap[launcherKey];
      }
      const match = providers.find((item) => item.id === launcherKey);
      return Boolean(match?.authenticated);
    },
    [browser, providers],
  );

  const handleToggleModel = async (model: ManagedModelView) => {
    if (!model.available || saving || refreshingTarget !== null) return;
    if (model.effectiveEnabled && snapshot && snapshot.totalEnabledCount <= 1) {
      setError(copy.modelsMinimumRequiredHint);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await api.updateModelOverride(model.slug, {
        enabled: !model.enabled,
      });
      setSnapshot(next);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleProvider = async (group: ManagedProviderGroupView) => {
    if (group.availableCount === 0 || saving || refreshingTarget !== null) return;
    const isCurrentlyOn = group.enabledCount > 0;
    const nextEnabled = !isCurrentlyOn;
    if (!nextEnabled && snapshot && snapshot.totalEnabledCount - group.enabledCount < 1) {
      setError(copy.modelsMinimumRequiredHint);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await api.toggleProviderModels(group.providerId, nextEnabled);
      setSnapshot(next);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  const handleRefresh = async (providerId?: string) => {
    if (saving || refreshingTarget !== null) return;
    setRefreshingTarget(providerId ?? "all");
    setError(null);
    try {
      const outcome = await api.refreshModels(providerId);
      setSnapshot(outcome.snapshot);
      setRefreshResults((prev) => {
        const next = { ...prev };
        for (const item of outcome.results) {
          next[item.providerId] = item;
        }
        return next;
      });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setRefreshingTarget(null);
    }
  };

  const handleResetAll = async () => {
    if (saving || refreshingTarget !== null) return;
    if (!confirmResetAll) {
      setConfirmResetAll(true);
      return;
    }
    setConfirmResetAll(false);
    setSaving(true);
    setError(null);
    try {
      const next = await api.resetModels();
      setSnapshot(next);
      setRefreshResults({});
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  const handleOpenConfig = async () => {
    setError(null);
    try {
      await api.openModelsConfig();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const handleSaveEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingModel || saving) return;

    const cleanName = draftDisplayName.trim();
    const parsedCtx = Number.parseInt(draftContextWindow.replace(/[\s,_]/g, ""), 10);
    if (!cleanName) {
      setError(`${copy.modelsEditDisplayName} is required.`);
      return;
    }
    if (!Number.isFinite(parsedCtx) || parsedCtx < 4096 || parsedCtx > 10_000_000) {
      setError(`${copy.modelsEditContextWindow} must be between 4096 and 10000000.`);
      return;
    }

    const inputModalities: ModelInputModality[] = draftSupportsImage
      ? ["text", "image"]
      : ["text"];

    setSaving(true);
    setError(null);
    try {
      const next = await api.updateModelOverride(editingModel.slug, {
        displayName: cleanName,
        contextWindow: parsedCtx,
        defaultReasoningLevel: draftReasoning,
        inputModalities,
      });
      setSnapshot(next);
      setEditingModel(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  const handleResetOne = async () => {
    if (!editingModel || saving) return;
    setSaving(true);
    setError(null);
    try {
      const next = await api.resetModels(editingModel.slug);
      setSnapshot(next);
      setEditingModel(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  const parsedPreviewCtx = Number.parseInt(draftContextWindow.replace(/[\s,_]/g, ""), 10);
  const autoCompactPreview =
    editingModel && Number.isFinite(parsedPreviewCtx) && parsedPreviewCtx >= 4096
      ? Math.max(
          1024,
          Math.min(
            parsedPreviewCtx,
            Math.round(parsedPreviewCtx * (editingModel.effectiveContextWindowPercent / 100)),
          ),
        )
      : editingModel?.autoCompactTokenLimit ?? 0;

  return (
    <section className="content-surface">
      <div className="content-scroll is-narrow">
        <header className="surface-header">
          <h1>{copy.modelsTitle}</h1>
          <p>{copy.modelsSubtitle}</p>
        </header>

        {loading || !snapshot ? (
          <div className="surface-empty">
            <span className="tab-spinner" />
            <span>{copy.loading}</span>
          </div>
        ) : (
          <>
            <div className="models-toolbar">
              <div className="models-summary-pill">
                <strong>
                  {copy.modelsActiveSummary
                    .replace("{enabled}", String(snapshot.totalEnabledCount))
                    .replace("{total}", String(totalModels))}
                </strong>
              </div>
              <div className="models-toolbar-actions">
                <button
                  className="button-secondary models-inline-btn"
                  disabled={saving || refreshingTarget !== null}
                  onClick={() => void handleRefresh()}
                  type="button"
                >
                  <Icon name="reload" style={{ width: 13, height: 13 }} />
                  <span>{refreshingTarget === "all" ? copy.modelsRefreshing : copy.modelsRefreshAll}</span>
                </button>
                <button
                  className="button-secondary models-inline-btn"
                  disabled={saving}
                  onClick={() => void handleOpenConfig()}
                  type="button"
                >
                  <Icon name="external" style={{ width: 13, height: 13 }} />
                  <span>{copy.modelsOpenJson}</span>
                </button>
                <button
                  className={`button-secondary${confirmResetAll ? " is-danger" : ""}`}
                  disabled={saving || refreshingTarget !== null}
                  onBlur={() => setConfirmResetAll(false)}
                  onClick={() => void handleResetAll()}
                  type="button"
                >
                  {confirmResetAll ? copy.modelsConfirmResetAll : copy.modelsResetAll}
                </button>
              </div>
            </div>

            <p className="personalization-hint">{copy.modelsHotReloadNote}</p>

            {snapshot.providers.map((group) => {
              const signedIn = isProviderSignedIn(group.providerId);
              const providerIsRefreshing =
                refreshingTarget === "all" || refreshingTarget === group.providerId;
              const providerOn = group.enabledCount > 0;
              const cannotTurnOffProvider =
                providerOn && snapshot.totalEnabledCount - group.enabledCount < 1;
              const lastResult = refreshResults[group.providerId];

              return (
                <div className="models-provider-section" key={group.providerId}>
                  <div className="models-provider-header">
                    <div className="models-provider-meta">
                      <div className="models-provider-title">
                        <strong>{providerDisplayName(group.providerId)}</strong>
                        <span className={`models-status-badge${signedIn ? " is-ok" : " is-muted"}`}>
                          {signedIn ? copy.modelsProviderSignedIn : copy.modelsProviderSignedOut}
                        </span>
                      </div>
                      <small className="models-provider-sub">
                        {group.lastRefreshedAt
                          ? copy.modelsLastSynced.replace(
                              "{time}",
                              formatTimeShort(group.lastRefreshedAt),
                            )
                          : copy.modelsUsingBuiltinDefaults}
                      </small>
                    </div>

                    <div className="models-provider-actions">
                      <button
                        className="text-button models-inline-btn"
                        disabled={saving || refreshingTarget !== null}
                        onClick={() => void handleRefresh(group.providerId)}
                        type="button"
                      >
                        <Icon name="reload" style={{ width: 12, height: 12 }} />
                        <span>
                          {providerIsRefreshing
                            ? copy.modelsRefreshing
                            : copy.modelsRefreshProvider}
                        </span>
                      </button>

                      <button
                        aria-checked={providerOn}
                        aria-label={copy.modelsToggleProviderLabel.replace(
                          "{provider}",
                          providerDisplayName(group.providerId),
                        )}
                        className={`switch${providerOn ? " is-on" : ""}`}
                        disabled={
                          saving ||
                          refreshingTarget !== null ||
                          group.availableCount === 0 ||
                          cannotTurnOffProvider
                        }
                        onClick={() => void handleToggleProvider(group)}
                        role="switch"
                        title={
                          cannotTurnOffProvider
                            ? copy.modelsMinimumRequiredHint
                            : copy.modelsToggleProviderLabel.replace(
                                "{provider}",
                                providerDisplayName(group.providerId),
                              )
                        }
                        type="button"
                      >
                        <span />
                      </button>
                    </div>
                  </div>

                  {lastResult ? (
                    <div
                      className={`models-refresh-banner${
                        lastResult.status === "ok"
                          ? " is-ok"
                          : lastResult.status === "busy"
                            ? " is-warn"
                            : " is-error"
                      }`}
                    >
                      {lastResult.status === "ok"
                        ? copy.modelsRefreshSuccess
                            .replace("{count}", String(lastResult.discoveredCount))
                            .replace("{added}", String(lastResult.addedCount))
                            .replace("{unavailable}", String(lastResult.unavailableCount))
                        : lastResult.status === "busy"
                          ? copy.modelsRefreshBusy
                          : lastResult.message}
                    </div>
                  ) : group.lastError ? (
                    <div className="models-refresh-banner is-error">{group.lastError}</div>
                  ) : null}

                  <div className="models-list">
                    {group.models.map((model) => {
                      const isLastEnabled =
                        model.effectiveEnabled && snapshot.totalEnabledCount <= 1;

                      return (
                        <div
                          className={`models-row${
                            model.effectiveEnabled ? "" : " is-disabled"
                          }${!model.available ? " is-unavailable" : ""}`}
                          key={model.slug}
                        >
                          <div className="models-row-info">
                            <div className="models-row-head">
                              <strong>{model.displayName}</strong>
                              <code className="models-slug-code">{model.slug}</code>
                              <span className="skills-source-tag">
                                {model.source === "builtin"
                                  ? copy.modelsBadgeBuiltin
                                  : copy.modelsBadgeDiscovered}
                              </span>
                              {model.customized ? (
                                <span className="skills-source-tag is-accent">
                                  {copy.modelsBadgeCustomized}
                                </span>
                              ) : null}
                              {!model.available ? (
                                <span className="skills-source-tag is-warning">
                                  {copy.modelsBadgeUnavailable}
                                </span>
                              ) : null}
                            </div>
                            <small className="models-row-specs">
                              {formatContextCompact(model.contextWindow)} ctx ·{" "}
                              {formatReasoningLabel(model.defaultReasoningLevel)} ·{" "}
                              {model.inputModalities.includes("image")
                                ? "Text + Image"
                                : "Text only"}
                            </small>
                          </div>

                          <div className="models-row-controls">
                            <button
                              className="text-button"
                              disabled={saving || refreshingTarget !== null}
                              onClick={() => setEditingModel(model)}
                              type="button"
                            >
                              {copy.modelsEdit}
                            </button>
                            <button
                              aria-checked={model.effectiveEnabled}
                              aria-label={model.displayName}
                              className={`switch${model.effectiveEnabled ? " is-on" : ""}`}
                              disabled={
                                saving ||
                                refreshingTarget !== null ||
                                !model.available ||
                                isLastEnabled
                              }
                              onClick={() => void handleToggleModel(model)}
                              role="switch"
                              title={
                                isLastEnabled ? copy.modelsMinimumRequiredHint : model.slug
                              }
                              type="button"
                            >
                              <span />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      <dialog
        aria-labelledby={dialogTitleId}
        className="models-edit-dialog"
        closedby="any"
        onClose={(event) => {
          event.currentTarget.returnValue = "";
          setEditingModel(null);
        }}
        ref={dialogRef}
      >
        {editingModel ? (
          <form className="models-edit-form" onSubmit={(event) => void handleSaveEdit(event)}>
            <header className="models-edit-header">
              <h2 id={dialogTitleId}>{copy.modelsEditTitle}</h2>
              <code className="models-slug-code">{editingModel.slug}</code>
            </header>

            <label className="models-field">
              <span>{copy.modelsEditDisplayName}</span>
              <input
                autoFocus
                className="models-text-input"
                maxLength={120}
                onChange={(event) => setDraftDisplayName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && event.nativeEvent.isComposing) {
                    event.preventDefault();
                  }
                }}
                required
                type="text"
                value={draftDisplayName}
              />
            </label>

            <label className="models-field">
              <span>{copy.modelsEditContextWindow}</span>
              <input
                className="models-text-input"
                max={10_000_000}
                min={4_096}
                onChange={(event) => setDraftContextWindow(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && event.nativeEvent.isComposing) {
                    event.preventDefault();
                  }
                }}
                required
                step={1}
                type="number"
                value={draftContextWindow}
              />
              <small className="models-field-hint">
                {copy.modelsEditAutoCompactHint.replace(
                  "{tokens}",
                  autoCompactPreview.toLocaleString("en-US"),
                )}
              </small>
            </label>

            <label className="models-field">
              <span>{copy.modelsEditReasoning}</span>
              <select
                className="models-select-input"
                onChange={(event) =>
                  setDraftReasoning(event.target.value as ModelReasoningEffort)
                }
                value={draftReasoning}
              >
                {editingModel.supportedReasoningLevels.map((effort) => (
                  <option key={effort} value={effort}>
                    {formatReasoningLabel(effort)}
                  </option>
                ))}
              </select>
            </label>

            <div className="models-field-switch">
              <span>{copy.modelsEditSupportsImage}</span>
              <button
                aria-checked={draftSupportsImage}
                aria-label={copy.modelsEditSupportsImage}
                className={`switch${draftSupportsImage ? " is-on" : ""}`}
                onClick={() => setDraftSupportsImage((prev) => !prev)}
                role="switch"
                type="button"
              >
                <span />
              </button>
            </div>

            <footer className="models-edit-footer">
              <button
                className="text-button"
                disabled={saving}
                onClick={() => void handleResetOne()}
                type="button"
              >
                {copy.modelsEditResetOne}
              </button>
              <div className="models-edit-footer-right">
                <button
                  className="button-secondary"
                  disabled={saving}
                  onClick={() => setEditingModel(null)}
                  type="button"
                >
                  {copy.modelsEditCancel}
                </button>
                <button className="button-primary" disabled={saving} type="submit">
                  {copy.modelsEditSave}
                </button>
              </div>
            </footer>
          </form>
        ) : null}
      </dialog>
    </section>
  );
}
