import { useCallback, useEffect, useMemo, useState } from "react";
import type { Copy } from "../i18n";
import { Icon } from "../icons";
import {
  PERSONALIZATION_LIMITS,
  renderFullPersonalizationPreview,
} from "../personalization-preview";
import type {
  LauncherApi,
  PersonalizationSettings,
  PersonalizationTone,
  SavedMemoryItem,
} from "../types";

const DEFAULT_SETTINGS: PersonalizationSettings = {
  version: 1,
  enabled: false,
  workspaceMemoryEnabled: true,
  baseTone: "default",
  nickname: "",
  roleOrStack: "",
  aboutYou: "",
  customInstructions: "",
  memories: [],
  updatedAt: null,
};

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function createClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function hasTextFieldDiff(a: PersonalizationSettings, b: PersonalizationSettings): boolean {
  return (
    a.nickname !== b.nickname ||
    a.roleOrStack !== b.roleOrStack ||
    a.aboutYou !== b.aboutYou ||
    a.customInstructions !== b.customInstructions
  );
}

export function PersonalizationSurface({
  api,
  copy,
  setError,
}: {
  api: LauncherApi;
  copy: Copy;
  setError: (error: string | null) => void;
}) {
  const [saved, setSaved] = useState<PersonalizationSettings>(DEFAULT_SETTINGS);
  const [draft, setDraft] = useState<PersonalizationSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const [newMemoryText, setNewMemoryText] = useState("");
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [editingMemoryText, setEditingMemoryText] = useState("");
  const [confirmClearAll, setConfirmClearAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .getPersonalization()
      .then((initial) => {
        if (cancelled) return;
        setSaved(initial);
        setDraft(initial);
      })
      .catch((cause) => {
        if (!cancelled) setError(messageOf(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, setError]);

  const persistSettings = useCallback(
    async (next: PersonalizationSettings, keepTextDraft = true) => {
      setSaving(true);
      setError(null);
      try {
        const persisted = await api.savePersonalization(next);
        setSaved(persisted);
        if (keepTextDraft) {
          setDraft((current) => ({
            ...persisted,
            nickname: current.nickname,
            roleOrStack: current.roleOrStack,
            aboutYou: current.aboutYou,
            customInstructions: current.customInstructions,
          }));
        } else {
          setDraft(persisted);
        }
        setJustSaved(true);
        return persisted;
      } catch (cause) {
        setError(messageOf(cause));
        return null;
      } finally {
        setSaving(false);
      }
    },
    [api, setError],
  );

  useEffect(() => {
    if (!justSaved) return;
    const timer = window.setTimeout(() => setJustSaved(false), 2200);
    return () => window.clearTimeout(timer);
  }, [justSaved]);

  const textDirty = hasTextFieldDiff(draft, saved);

  const previewText = useMemo(() => renderFullPersonalizationPreview(draft), [draft]);

  const toneOptions: Array<{ value: PersonalizationTone; label: string }> = [
    { value: "default", label: copy.personalizationToneDefault },
    { value: "concise_technical", label: copy.personalizationToneConcise },
    { value: "friendly", label: copy.personalizationToneFriendly },
    { value: "formal", label: copy.personalizationToneFormal },
    { value: "mentor", label: copy.personalizationToneMentor },
  ];

  const handleToggleEnabled = (checked: boolean) => {
    const next = { ...draft, enabled: checked };
    setDraft(next);
    void persistSettings(next, true);
  };

  const handleToggleWorkspaceMemory = (checked: boolean) => {
    const next = { ...draft, workspaceMemoryEnabled: checked };
    setDraft(next);
    void persistSettings(next, true);
  };

  const handleChangeTone = (baseTone: PersonalizationTone) => {
    const next = { ...draft, baseTone };
    setDraft(next);
    void persistSettings(next, true);
  };

  const handleSaveTextFields = () => {
    void persistSettings(draft, false);
  };

  const handleAddMemory = () => {
    const trimmed = newMemoryText.replace(/\r\n/g, "\n").trim().slice(0, PERSONALIZATION_LIMITS.memoryContent);
    if (!trimmed) return;
    if (draft.memories.length >= PERSONALIZATION_LIMITS.maxMemories) return;

    const now = new Date().toISOString();
    const item: SavedMemoryItem = {
      id: createClientId(),
      content: trimmed,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    const next = { ...draft, memories: [item, ...draft.memories] };
    setNewMemoryText("");
    setDraft(next);
    void persistSettings(next, true);
  };

  const handleToggleMemory = (id: string) => {
    const now = new Date().toISOString();
    const next = {
      ...draft,
      memories: draft.memories.map((item) =>
        item.id === id ? { ...item, enabled: !item.enabled, updatedAt: now } : item,
      ),
    };
    setDraft(next);
    void persistSettings(next, true);
  };

  const handleStartEditMemory = (item: SavedMemoryItem) => {
    setEditingMemoryId(item.id);
    setEditingMemoryText(item.content);
  };

  const handleSaveEditMemory = (id: string) => {
    const trimmed = editingMemoryText
      .replace(/\r\n/g, "\n")
      .trim()
      .slice(0, PERSONALIZATION_LIMITS.memoryContent);
    if (!trimmed) return;
    const now = new Date().toISOString();
    const next = {
      ...draft,
      memories: draft.memories.map((item) =>
        item.id === id ? { ...item, content: trimmed, updatedAt: now } : item,
      ),
    };
    setEditingMemoryId(null);
    setEditingMemoryText("");
    setDraft(next);
    void persistSettings(next, true);
  };

  const handleDeleteMemory = (id: string) => {
    if (editingMemoryId === id) {
      setEditingMemoryId(null);
      setEditingMemoryText("");
    }
    const next = {
      ...draft,
      memories: draft.memories.filter((item) => item.id !== id),
    };
    setDraft(next);
    void persistSettings(next, true);
  };

  const handleClearAllMemories = () => {
    if (!confirmClearAll) {
      setConfirmClearAll(true);
      return;
    }
    setConfirmClearAll(false);
    setEditingMemoryId(null);
    const next = { ...draft, memories: [] };
    setDraft(next);
    void persistSettings(next, true);
  };

  const memoryLimitReached = draft.memories.length >= PERSONALIZATION_LIMITS.maxMemories;

  return (
    <section className="content-surface">
      <div className="content-scroll is-narrow">
        <header className="surface-header">
          <h1>{copy.personalizationTitle}</h1>
          <p>{copy.personalizationSubtitle}</p>
        </header>

        {loading ? (
          <div className="surface-empty">
            <span className="tab-spinner" />
            <span>{copy.loading}</span>
          </div>
        ) : (
          <>
            <div className="section-heading">
              <span>{copy.personalizationSectionActivation}</span>
            </div>
            <div className="settings-list">
              <div className="setting-row">
                <div>
                  <strong>{copy.personalizationEnable}</strong>
                  <p>{copy.personalizationEnableBody}</p>
                </div>
                <button
                  aria-checked={draft.enabled}
                  className={`switch${draft.enabled ? " is-on" : ""}`}
                  disabled={saving}
                  onClick={() => handleToggleEnabled(!draft.enabled)}
                  role="switch"
                  type="button"
                >
                  <span />
                </button>
              </div>
              <div className="setting-row">
                <div>
                  <strong>{copy.personalizationWorkspaceMemory}</strong>
                  <p>{copy.personalizationWorkspaceMemoryBody}</p>
                </div>
                <button
                  aria-checked={draft.workspaceMemoryEnabled}
                  className={`switch${draft.workspaceMemoryEnabled ? " is-on" : ""}`}
                  disabled={saving || !draft.enabled}
                  onClick={() => handleToggleWorkspaceMemory(!draft.workspaceMemoryEnabled)}
                  role="switch"
                  type="button"
                >
                  <span />
                </button>
              </div>
            </div>

            <div className="section-heading is-spaced">
              <span>{copy.personalizationSectionStyle}</span>
              <small>{copy.personalizationPrecedenceNote}</small>
            </div>
            <div className="personalization-card">
              <div className="setting-row">
                <div>
                  <strong>{copy.personalizationTone}</strong>
                  <p>{copy.personalizationToneBody}</p>
                </div>
                <select
                  aria-label={copy.personalizationTone}
                  className="personalization-select"
                  disabled={saving}
                  onChange={(event) => handleChangeTone(event.target.value as PersonalizationTone)}
                  value={draft.baseTone}
                >
                  {toneOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="personalization-field">
                <div className="personalization-field-header">
                  <label htmlFor="personalization-custom-instructions">
                    {copy.personalizationCustomInstructions}
                  </label>
                  <span>
                    {draft.customInstructions.length} / {PERSONALIZATION_LIMITS.customInstructions}
                  </span>
                </div>
                <textarea
                  className="personalization-textarea"
                  id="personalization-custom-instructions"
                  maxLength={PERSONALIZATION_LIMITS.customInstructions}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, customInstructions: event.target.value }))
                  }
                  placeholder={copy.personalizationCustomInstructionsPlaceholder}
                  rows={4}
                  value={draft.customInstructions}
                />
              </div>
            </div>

            <div className="section-heading is-spaced">
              <span>{copy.personalizationSectionProfile}</span>
            </div>
            <div className="personalization-card">
              <div className="personalization-grid">
                <div className="personalization-field">
                  <div className="personalization-field-header">
                    <label htmlFor="personalization-nickname">{copy.personalizationNickname}</label>
                    <span>
                      {draft.nickname.length} / {PERSONALIZATION_LIMITS.nickname}
                    </span>
                  </div>
                  <input
                    className="personalization-input"
                    id="personalization-nickname"
                    maxLength={PERSONALIZATION_LIMITS.nickname}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, nickname: event.target.value }))
                    }
                    placeholder={copy.personalizationNicknamePlaceholder}
                    type="text"
                    value={draft.nickname}
                  />
                </div>

                <div className="personalization-field">
                  <div className="personalization-field-header">
                    <label htmlFor="personalization-role">{copy.personalizationRoleOrStack}</label>
                    <span>
                      {draft.roleOrStack.length} / {PERSONALIZATION_LIMITS.roleOrStack}
                    </span>
                  </div>
                  <input
                    className="personalization-input"
                    id="personalization-role"
                    maxLength={PERSONALIZATION_LIMITS.roleOrStack}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, roleOrStack: event.target.value }))
                    }
                    placeholder={copy.personalizationRoleOrStackPlaceholder}
                    type="text"
                    value={draft.roleOrStack}
                  />
                </div>
              </div>

              <div className="personalization-field">
                <div className="personalization-field-header">
                  <label htmlFor="personalization-about-you">{copy.personalizationAboutYou}</label>
                  <span>
                    {draft.aboutYou.length} / {PERSONALIZATION_LIMITS.aboutYou}
                  </span>
                </div>
                <textarea
                  className="personalization-textarea"
                  id="personalization-about-you"
                  maxLength={PERSONALIZATION_LIMITS.aboutYou}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, aboutYou: event.target.value }))
                  }
                  placeholder={copy.personalizationAboutYouPlaceholder}
                  rows={3}
                  value={draft.aboutYou}
                />
              </div>

              <div className="personalization-save-bar">
                <span className={`personalization-status${textDirty ? " is-dirty" : ""}`}>
                  {textDirty
                    ? copy.personalizationUnsaved
                    : justSaved
                      ? copy.personalizationSaved
                      : ""}
                </span>
                <button
                  className="button-primary"
                  disabled={saving || !textDirty}
                  onClick={handleSaveTextFields}
                  type="button"
                >
                  {copy.personalizationSaveChanges}
                </button>
              </div>
            </div>

            <div className="section-heading is-spaced">
              <span>{copy.personalizationSectionMemories}</span>
              <small>
                {draft.memories.length} / {PERSONALIZATION_LIMITS.maxMemories}
              </small>
            </div>
            <p className="personalization-hint">{copy.personalizationMemoriesHint}</p>

            <div className="personalization-memory-composer">
              <input
                className="personalization-input"
                disabled={saving || memoryLimitReached}
                maxLength={PERSONALIZATION_LIMITS.memoryContent}
                onChange={(event) => setNewMemoryText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleAddMemory();
                  }
                }}
                placeholder={copy.personalizationMemoryPlaceholder}
                type="text"
                value={newMemoryText}
              />
              <button
                className="button-secondary"
                disabled={saving || memoryLimitReached || newMemoryText.trim().length === 0}
                onClick={handleAddMemory}
                type="button"
              >
                <Icon name="plus" />
                <span>{copy.personalizationAddMemory}</span>
              </button>
            </div>
            {memoryLimitReached ? (
              <p className="personalization-limit-note">
                {copy.personalizationMemoryLimitReached.replace(
                  "{max}",
                  String(PERSONALIZATION_LIMITS.maxMemories),
                )}
              </p>
            ) : null}

            <div className="personalization-memory-list">
              {draft.memories.length === 0 ? (
                <div className="personalization-empty">{copy.personalizationEmptyMemories}</div>
              ) : (
                draft.memories.map((item) => (
                  <div
                    className={`personalization-memory-row${item.enabled ? "" : " is-disabled"}`}
                    key={item.id}
                  >
                    <button
                      aria-checked={item.enabled}
                      className={`switch${item.enabled ? " is-on" : ""}`}
                      disabled={saving}
                      onClick={() => handleToggleMemory(item.id)}
                      role="switch"
                      type="button"
                    >
                      <span />
                    </button>

                    {editingMemoryId === item.id ? (
                      <div className="personalization-memory-edit">
                        <input
                          autoFocus
                          className="personalization-input"
                          maxLength={PERSONALIZATION_LIMITS.memoryContent}
                          onChange={(event) => setEditingMemoryText(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              handleSaveEditMemory(item.id);
                            } else if (event.key === "Escape") {
                              setEditingMemoryId(null);
                            }
                          }}
                          type="text"
                          value={editingMemoryText}
                        />
                        <button
                          className="button-secondary"
                          disabled={saving || editingMemoryText.trim().length === 0}
                          onClick={() => handleSaveEditMemory(item.id)}
                          type="button"
                        >
                          {copy.personalizationSaveMemory}
                        </button>
                        <button
                          className="text-button"
                          onClick={() => setEditingMemoryId(null)}
                          type="button"
                        >
                          {copy.personalizationCancelEdit}
                        </button>
                      </div>
                    ) : (
                      <>
                        <span
                          className="personalization-memory-text"
                          onDoubleClick={() => handleStartEditMemory(item)}
                        >
                          {item.content}
                        </span>
                        <div className="personalization-memory-actions">
                          <button
                            className="text-button"
                            disabled={saving}
                            onClick={() => handleStartEditMemory(item)}
                            type="button"
                          >
                            {copy.personalizationEditMemory}
                          </button>
                          <button
                            aria-label={copy.personalizationDeleteMemory}
                            className="icon-button"
                            disabled={saving}
                            onClick={() => handleDeleteMemory(item.id)}
                            title={copy.personalizationDeleteMemory}
                            type="button"
                          >
                            <Icon name="trash" />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>

            {draft.memories.length > 0 ? (
              <div className="personalization-clear-row">
                {confirmClearAll ? (
                  <button
                    className="text-button"
                    onClick={() => setConfirmClearAll(false)}
                    type="button"
                  >
                    {copy.personalizationCancelEdit}
                  </button>
                ) : null}
                <button
                  className="text-button"
                  disabled={saving}
                  onClick={handleClearAllMemories}
                  type="button"
                >
                  {confirmClearAll
                    ? copy.personalizationConfirmClear
                    : copy.personalizationClearMemories}
                </button>
              </div>
            ) : null}

            <div className="section-heading is-spaced">
              <span>{copy.personalizationSectionPreview}</span>
              <small>
                {copy.personalizationPreviewChars.replace("{count}", String(previewText.length))}
              </small>
            </div>
            <pre className="personalization-preview">
              {previewText || copy.personalizationPreviewEmpty}
            </pre>
          </>
        )}
      </div>
    </section>
  );
}
