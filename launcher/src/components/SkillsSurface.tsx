import { useCallback, useEffect, useMemo, useState } from "react";
import type { Copy } from "../i18n";
import { Icon } from "../icons";
import {
  filterSkillsForPrompt,
  renderAvailableSkillsPreview,
} from "../skills-preview";
import type {
  DiscoveredSkillRecord,
  LauncherApi,
  ScannedSkillDirectory,
  SkillDirectoryEntry,
  SkillSourceKind,
  SkillsSettings,
  SuggestedSkillDirectory,
} from "../types";

const DEFAULT_SETTINGS: SkillsSettings = {
  version: 1,
  enabled: true,
  autoDiscoverHostSkills: true,
  includeSystemSkills: false,
  disabledSkills: [],
  skillDirectories: [{ path: "~/.codex/skills", enabled: true }],
  updatedAt: null,
};

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const SOURCE_ORDER: Record<SkillSourceKind, number> = {
  workspace: 0,
  custom: 1,
  user: 2,
  unknown: 3,
  system: 4,
};

type SourceFilter = "all" | "workspace" | "custom" | "system";

export function SkillsSurface({
  api,
  copy,
  setError,
}: {
  api: LauncherApi;
  copy: Copy;
  setError: (error: string | null) => void;
}) {
  const [settings, setSettings] = useState<SkillsSettings>(DEFAULT_SETTINGS);
  const [directories, setDirectories] = useState<ScannedSkillDirectory[]>([]);
  const [suggestedDirectories, setSuggestedDirectories] = useState<SuggestedSkillDirectory[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredSkillRecord[]>([]);
  const [manualPath, setManualPath] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const applyPayload = useCallback(
    (payload: {
      settings: SkillsSettings;
      directories?: ScannedSkillDirectory[];
      suggestedDirectories?: SuggestedSkillDirectory[];
      discoveredSkills: DiscoveredSkillRecord[];
    }) => {
      setSettings(payload.settings);
      setDirectories(Array.isArray(payload.directories) ? payload.directories : []);
      setSuggestedDirectories(
        Array.isArray(payload.suggestedDirectories) ? payload.suggestedDirectories : [],
      );
      setDiscovered(Array.isArray(payload.discoveredSkills) ? payload.discoveredSkills : []);
    },
    [],
  );

  const loadSkills = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await api.getSkills();
      applyPayload(payload);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, [api, applyPayload, setError]);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const persistSettings = useCallback(
    async (next: SkillsSettings) => {
      setSaving(true);
      setError(null);
      try {
        const saved = await api.saveSkills(next);
        applyPayload(saved);
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        setSaving(false);
      }
    },
    [api, applyPayload, setError],
  );

  const disabledSet = useMemo(
    () => new Set(settings.disabledSkills.map((item) => item.trim().toLowerCase()).filter(Boolean)),
    [settings.disabledSkills],
  );

  const sortedSkills = useMemo(() => {
    return [...discovered].sort((a, b) => {
      const diff = SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });
  }, [discovered]);

  const visibleSkills = useMemo(() => {
    if (sourceFilter === "all") return sortedSkills;
    if (sourceFilter === "custom") {
      return sortedSkills.filter((item) => item.source === "custom" || item.source === "user");
    }
    return sortedSkills.filter((item) => item.source === sourceFilter);
  }, [sortedSkills, sourceFilter]);

  const activeCount = useMemo(
    () => filterSkillsForPrompt(discovered, settings).length,
    [discovered, settings],
  );

  const previewText = useMemo(
    () => renderAvailableSkillsPreview(discovered, settings),
    [discovered, settings],
  );

  const sourceLabel = (source: SkillSourceKind): string => {
    switch (source) {
      case "workspace":
        return copy.skillsSourceWorkspace;
      case "custom":
        return copy.skillsSourceCustom;
      case "user":
        return copy.skillsSourceUser;
      case "system":
        return copy.skillsSourceSystem;
      default:
        return copy.skillsSourceUnknown;
    }
  };

  const addDirectoryPath = useCallback(
    async (rawPath: string) => {
      const cleaned = rawPath.trim();
      if (!cleaned) return;
      const nextDirs: SkillDirectoryEntry[] = [
        ...settings.skillDirectories,
        { path: cleaned, enabled: true },
      ];
      const next: SkillsSettings = {
        ...settings,
        skillDirectories: nextDirs,
      };
      setSettings(next);
      await persistSettings(next);
    },
    [persistSettings, settings],
  );

  const handlePickDirectory = async () => {
    setError(null);
    try {
      const picked = await api.pickSkillDirectory();
      if (!picked.cancelled && picked.path) {
        await addDirectoryPath(picked.path);
      }
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const handleAddManualDirectory = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleaned = manualPath.trim();
    if (!cleaned) return;
    setManualPath("");
    await addDirectoryPath(cleaned);
  };

  const handleToggleDirectory = (targetPath: string) => {
    const nextDirs = settings.skillDirectories.map((entry) =>
      entry.path === targetPath ? { ...entry, enabled: !entry.enabled } : entry,
    );
    const next: SkillsSettings = { ...settings, skillDirectories: nextDirs };
    setSettings(next);
    void persistSettings(next);
  };

  const handleRemoveDirectory = (targetPath: string) => {
    const nextDirs = settings.skillDirectories.filter((entry) => entry.path !== targetPath);
    const next: SkillsSettings = { ...settings, skillDirectories: nextDirs };
    setSettings(next);
    void persistSettings(next);
  };

  const handleOpenDirectory = async (targetPath: string) => {
    setError(null);
    try {
      await api.openSkillDirectory(targetPath);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const handleToggleSkill = (skillName: string) => {
    const lower = skillName.trim().toLowerCase();
    const isCurrentlyDisabled = disabledSet.has(lower);
    const nextDisabled = isCurrentlyDisabled
      ? settings.disabledSkills.filter((item) => item.trim().toLowerCase() !== lower)
      : [...settings.disabledSkills, skillName];
    const next: SkillsSettings = {
      ...settings,
      disabledSkills: nextDisabled,
    };
    setSettings(next);
    void persistSettings(next);
  };

  const sourceCounts = useMemo(() => {
    let workspace = 0;
    let custom = 0;
    let system = 0;
    for (const item of sortedSkills) {
      if (item.source === "workspace") workspace++;
      else if (item.source === "custom" || item.source === "user") custom++;
      else if (item.source === "system") system++;
    }
    return { all: sortedSkills.length, workspace, custom, system };
  }, [sortedSkills]);

  return (
    <section className="content-surface">
      <div className="content-scroll is-narrow">
        <header className="surface-header">
          <h1>{copy.skillsTitle}</h1>
          <p>{copy.skillsSubtitle}</p>
        </header>

        {loading ? (
          <div className="surface-empty">
            <span className="tab-spinner" />
            <span>{copy.loading}</span>
          </div>
        ) : (
          <>
            <div className="section-heading">
              <span>{copy.skillsSectionActivation}</span>
            </div>
            <div className="settings-list">
              <div className="setting-row">
                <div>
                  <strong>{copy.skillsEnable}</strong>
                  <p>{copy.skillsEnableBody}</p>
                </div>
                <button
                  aria-checked={settings.enabled}
                  className={`switch${settings.enabled ? " is-on" : ""}`}
                  disabled={saving}
                  onClick={() => {
                    const next = { ...settings, enabled: !settings.enabled };
                    setSettings(next);
                    void persistSettings(next);
                  }}
                  role="switch"
                  type="button"
                >
                  <span />
                </button>
              </div>

              <div className="setting-row">
                <div>
                  <strong>{copy.skillsAutoDiscover}</strong>
                  <p>{copy.skillsAutoDiscoverBody}</p>
                </div>
                <button
                  aria-checked={settings.autoDiscoverHostSkills}
                  className={`switch${settings.autoDiscoverHostSkills ? " is-on" : ""}`}
                  disabled={saving || !settings.enabled}
                  onClick={() => {
                    const next = {
                      ...settings,
                      autoDiscoverHostSkills: !settings.autoDiscoverHostSkills,
                    };
                    setSettings(next);
                    void persistSettings(next);
                  }}
                  role="switch"
                  type="button"
                >
                  <span />
                </button>
              </div>

              <div className="setting-row">
                <div>
                  <strong>{copy.skillsIncludeSystem}</strong>
                  <p>{copy.skillsIncludeSystemBody}</p>
                </div>
                <button
                  aria-checked={settings.includeSystemSkills}
                  className={`switch${settings.includeSystemSkills ? " is-on" : ""}`}
                  disabled={saving || !settings.enabled || !settings.autoDiscoverHostSkills}
                  onClick={() => {
                    const next = {
                      ...settings,
                      includeSystemSkills: !settings.includeSystemSkills,
                    };
                    setSettings(next);
                    void persistSettings(next);
                  }}
                  role="switch"
                  type="button"
                >
                  <span />
                </button>
              </div>
            </div>

            <div className="section-heading is-spaced">
              <span>{copy.skillsSectionDirectories}</span>
              <button
                className="text-button"
                disabled={loading || saving || !settings.enabled}
                onClick={() => void handlePickDirectory()}
                type="button"
              >
                <Icon
                  name="folder"
                  style={{ width: 13, height: 13, marginRight: 5, verticalAlign: "-2px" }}
                />
                {copy.skillsAddFolder}
              </button>
            </div>
            <p className="personalization-hint">{copy.skillsDirectoriesHint}</p>

            <form className="skills-dir-composer" onSubmit={(e) => void handleAddManualDirectory(e)}>
              <input
                aria-label={copy.skillsAddPathPlaceholder}
                className="skills-dir-input"
                disabled={saving || !settings.enabled}
                onChange={(event) => setManualPath(event.target.value)}
                placeholder={copy.skillsAddPathPlaceholder}
                type="text"
                value={manualPath}
              />
              <button
                className="secondary-button"
                disabled={saving || !settings.enabled || !manualPath.trim()}
                type="submit"
              >
                {copy.skillsAddPathAction}
              </button>
            </form>

            {suggestedDirectories.length > 0 ? (
              <div className="skills-suggestions">
                <span className="skills-suggestions-label">{copy.skillsSuggestedLabel}:</span>
                {suggestedDirectories.map((item) => (
                  <button
                    className="skills-suggestion-chip"
                    disabled={saving || !settings.enabled}
                    key={item.resolvedPath}
                    onClick={() => void addDirectoryPath(item.path)}
                    title={item.resolvedPath}
                    type="button"
                  >
                    <Icon name="plus" style={{ width: 11, height: 11 }} />
                    <span>{item.path}</span>
                    <span>({item.skillCount})</span>
                  </button>
                ))}
              </div>
            ) : null}

            <div className="skills-dir-list">
              {directories.length === 0 ? (
                <div className="personalization-empty">{copy.skillsEmptyDirectories}</div>
              ) : (
                directories.map((dir) => (
                  <div
                    className={`skills-dir-row${dir.enabled && settings.enabled ? "" : " is-disabled"}`}
                    key={dir.path}
                  >
                    <button
                      aria-checked={dir.enabled}
                      className={`switch${dir.enabled ? " is-on" : ""}`}
                      disabled={saving || !settings.enabled}
                      onClick={() => handleToggleDirectory(dir.path)}
                      role="switch"
                      type="button"
                    >
                      <span />
                    </button>

                    <div className="skills-dir-meta">
                      <div className="skills-dir-head">
                        <span className="skills-dir-path">{dir.path}</span>
                        {dir.exists ? (
                          <small className="skills-source-tag">
                            {copy.skillsDirSkillCount.replace("{count}", String(dir.skillCount))}
                          </small>
                        ) : (
                          <small className="skills-source-tag is-warning">
                            {copy.skillsDirNotFound}
                          </small>
                        )}
                      </div>
                      {dir.resolvedPath && dir.resolvedPath !== dir.path ? (
                        <small className="skills-dir-resolved">{dir.resolvedPath}</small>
                      ) : null}
                    </div>

                    <div className="skills-dir-actions">
                      <button
                        aria-label={copy.skillsDirOpen}
                        className="skills-icon-btn"
                        disabled={!dir.exists || saving}
                        onClick={() => void handleOpenDirectory(dir.path)}
                        title={copy.skillsDirOpen}
                        type="button"
                      >
                        <Icon name="external" style={{ width: 14, height: 14 }} />
                      </button>
                      <button
                        aria-label={copy.skillsDirRemove}
                        className="skills-icon-btn"
                        disabled={saving}
                        onClick={() => handleRemoveDirectory(dir.path)}
                        title={copy.skillsDirRemove}
                        type="button"
                      >
                        <Icon name="trash" style={{ width: 14, height: 14 }} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="section-heading is-spaced">
              <span>
                {copy.skillsSectionDiscovered} ({activeCount}/{sortedSkills.length})
              </span>
              <button
                className="text-button"
                disabled={loading || saving}
                onClick={() => void loadSkills()}
                type="button"
              >
                <Icon
                  name="reload"
                  style={{ width: 13, height: 13, marginRight: 4, verticalAlign: "-2px" }}
                />
                {copy.skillsRefresh}
              </button>
            </div>

            {sortedSkills.length > 0 ? (
              <div className="skills-filter-bar">
                {(
                  [
                    ["all", `${copy.skillsFilterAll} (${sourceCounts.all})`],
                    ["workspace", `${copy.skillsSourceWorkspace} (${sourceCounts.workspace})`],
                    ["custom", `${copy.skillsSourceCustom} (${sourceCounts.custom})`],
                    ["system", `${copy.skillsSourceSystem} (${sourceCounts.system})`],
                  ] as Array<[SourceFilter, string]>
                ).map(([key, label]) => (
                  <button
                    className={`skills-filter-pill${sourceFilter === key ? " is-active" : ""}`}
                    key={key}
                    onClick={() => setSourceFilter(key)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="personalization-memories-list">
              {visibleSkills.length === 0 ? (
                <div className="personalization-empty">{copy.skillsEmptyDiscovered}</div>
              ) : (
                visibleSkills.map((item) => {
                  const hiddenBySystemSetting =
                    item.source === "system" && !settings.includeSystemSkills;
                  const directOnly = item.allowImplicitInvocation === false;
                  const overridden = Boolean(item.overriddenBy);
                  const individuallyEnabled = !disabledSet.has(item.name.trim().toLowerCase());
                  const rowActive =
                    settings.enabled &&
                    settings.autoDiscoverHostSkills &&
                    !hiddenBySystemSetting &&
                    !directOnly &&
                    !overridden &&
                    individuallyEnabled;

                  return (
                    <div
                      className={`personalization-memory-row${rowActive ? "" : " is-disabled"}`}
                      key={`${item.name}::${item.absolutePath}`}
                    >
                      <button
                        aria-checked={individuallyEnabled}
                        className={`switch${individuallyEnabled ? " is-on" : ""}`}
                        disabled={saving || !settings.enabled || overridden}
                        onClick={() => handleToggleSkill(item.name)}
                        role="switch"
                        type="button"
                      >
                        <span />
                      </button>

                      <div className="skills-item-meta">
                        <div className="skills-item-head">
                          <strong>{item.name}</strong>
                          <small className="skills-source-tag">{sourceLabel(item.source)}</small>
                          {item.overriddenBy ? (
                            <small className="skills-source-tag is-warning">
                              {copy.skillsTagOverridden.replace(
                                "{source}",
                                sourceLabel(item.overriddenBy),
                              )}
                            </small>
                          ) : null}
                          {directOnly ? (
                            <small className="skills-source-tag">{copy.skillsTagDirectOnly}</small>
                          ) : null}
                        </div>
                        {item.description ? (
                          <small className="skills-item-desc">{item.description}</small>
                        ) : null}
                        <small className="skills-item-path">{item.absolutePath}</small>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="section-heading is-spaced">
              <span>{copy.skillsSectionPreview}</span>
              <small>
                {copy.personalizationPreviewChars.replace("{count}", String(previewText.length))}
              </small>
            </div>
            <pre className="personalization-preview">
              {previewText || copy.skillsPreviewEmpty}
            </pre>
          </>
        )}
      </div>
    </section>
  );
}
