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
  SkillSourceKind,
  SkillsSettings,
} from "../types";

const DEFAULT_SETTINGS: SkillsSettings = {
  version: 1,
  enabled: true,
  autoDiscoverHostSkills: true,
  includeSystemSkills: false,
  disabledSkills: [],
  updatedAt: null,
};

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const SOURCE_ORDER: Record<SkillSourceKind, number> = {
  workspace: 0,
  user: 1,
  unknown: 2,
  system: 3,
};

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
  const [discovered, setDiscovered] = useState<DiscoveredSkillRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await api.getSkills();
      setSettings(payload.settings);
      setDiscovered(payload.discoveredSkills);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, [api, setError]);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const persistSettings = useCallback(
    async (next: SkillsSettings) => {
      setSaving(true);
      setError(null);
      try {
        const saved = await api.saveSkills(next);
        setSettings(saved.settings);
        setDiscovered(saved.discoveredSkills);
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        setSaving(false);
      }
    },
    [api, setError],
  );

  const disabledSet = useMemo(
    () => new Set(settings.disabledSkills.map((item) => item.trim().toLowerCase()).filter(Boolean)),
    [settings.disabledSkills],
  );

  const visibleSkills = useMemo(() => {
    return [...discovered].sort((a, b) => {
      const diff = SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });
  }, [discovered]);

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
      case "user":
        return copy.skillsSourceUser;
      case "system":
        return copy.skillsSourceSystem;
      default:
        return copy.skillsSourceUnknown;
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
              <span>
                {copy.skillsSectionDiscovered} ({activeCount}/{visibleSkills.length})
              </span>
              <button
                className="text-button"
                disabled={loading || saving}
                onClick={() => void loadSkills()}
                type="button"
              >
                <Icon name="reload" style={{ width: 13, height: 13, marginRight: 4, verticalAlign: "-2px" }} />
                {copy.skillsRefresh}
              </button>
            </div>

            <div className="personalization-memories-list">
              {visibleSkills.length === 0 ? (
                <div className="personalization-empty">{copy.skillsEmptyDiscovered}</div>
              ) : (
                visibleSkills.map((item) => {
                  const hiddenBySystemSetting =
                    item.source === "system" && !settings.includeSystemSkills;
                  const individuallyEnabled = !disabledSet.has(item.name.trim().toLowerCase());
                  const rowActive =
                    settings.enabled &&
                    settings.autoDiscoverHostSkills &&
                    !hiddenBySystemSetting &&
                    individuallyEnabled;

                  return (
                    <div
                      className={`personalization-memory-row${rowActive ? "" : " is-disabled"}`}
                      key={`${item.name}::${item.absolutePath}`}
                    >
                      <button
                        aria-checked={individuallyEnabled}
                        className={`switch${individuallyEnabled ? " is-on" : ""}`}
                        disabled={saving || !settings.enabled || hiddenBySystemSetting}
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
