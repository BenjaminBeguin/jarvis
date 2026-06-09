import { useCallback, useEffect, useMemo, useState } from 'react';

import type { WorkspaceDef, WorkspaceInput } from '../../../shared/types';

import { toast } from '../Toaster';

/**
 * Workspaces settings page — the "manage your contexts" surface.
 *
 * Layout: left rail lists every workspace; right pane shows the
 * selected workspace's editable fields (name, color, icon,
 * description, default toggle) plus the per-workspace preferences.md
 * overlay editor. Delete sits at the bottom; the default workspace
 * can't be deleted (the system needs at least one fallback).
 *
 * Creating a workspace from this page mirrors the WorkspaceSwitcher
 * dropdown's inline-create flow — name field at the top of the rail,
 * Enter to commit.
 */

const DEFAULT_COLOR = '#6ee7ff';

export function Workspaces() {
  const [workspaces, setWorkspaces] = useState<WorkspaceDef[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    void window.jarvis.listWorkspaces().then(setWorkspaces);
    const off = window.jarvis.onWorkspacesChanged(setWorkspaces);
    void window.jarvis.getActiveWorkspace().then(setActiveId);
    const offActive = window.jarvis.onActiveWorkspaceChanged(setActiveId);
    return () => {
      off();
      offActive();
    };
  }, []);

  // Default selection — the active workspace, falling through to the
  // first entry once the list loads.
  useEffect(() => {
    if (selectedId) return;
    if (activeId && workspaces.some((w) => w.id === activeId)) {
      setSelectedId(activeId);
    } else if (workspaces.length > 0) {
      setSelectedId(workspaces[0]!.id);
    }
  }, [activeId, workspaces, selectedId]);

  const selected = useMemo(
    () => workspaces.find((w) => w.id === selectedId) ?? null,
    [workspaces, selectedId],
  );

  const createWorkspace = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const def = await window.jarvis.createWorkspace({ name });
      setNewName('');
      setSelectedId(def.id);
    } catch (err) {
      toast({
        message: err instanceof Error ? err.message : String(err),
        kind: 'error',
      });
    }
  }, [newName]);

  const saveSelected = useCallback(
    async (patch: WorkspaceInput) => {
      if (!selected) return;
      try {
        await window.jarvis.updateWorkspace(selected.id, patch);
      } catch (err) {
        toast({
          message: err instanceof Error ? err.message : String(err),
          kind: 'error',
        });
      }
    },
    [selected],
  );

  const deleteSelected = useCallback(async () => {
    if (!selected) return;
    if (selected.default) {
      toast({
        message: 'Cannot delete the default workspace.',
        kind: 'error',
      });
      return;
    }
    if (
      !confirm(
        `Delete workspace "${selected.name}"?\n\nProjects, workflows, and drafts tagged to it stay on disk but become "unassigned" — visible from every workspace until you re-tag them.`,
      )
    ) {
      return;
    }
    try {
      await window.jarvis.deleteWorkspace(selected.id);
      setSelectedId(null);
      toast({ message: `Workspace "${selected.name}" deleted` });
    } catch (err) {
      toast({
        message: err instanceof Error ? err.message : String(err),
        kind: 'error',
      });
    }
  }, [selected]);

  return (
    <section className="workspaces-page">
      <aside className="workspaces-page__rail">
        <header className="workspaces-page__rail-head">
          <h2>Workspaces</h2>
          <p>Top-level contexts. Switch from the header pill.</p>
        </header>
        <ul className="workspaces-page__list">
          {workspaces.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                className={`workspaces-page__item${
                  w.id === selectedId ? ' workspaces-page__item--selected' : ''
                }`}
                onClick={() => setSelectedId(w.id)}
              >
                <span
                  className="workspaces-page__item-icon"
                  style={{
                    background: w.color ?? DEFAULT_COLOR,
                  }}
                  aria-hidden
                >
                  {w.icon ?? w.name.charAt(0).toUpperCase()}
                </span>
                <span className="workspaces-page__item-name">{w.name}</span>
                {w.default && (
                  <span className="workspaces-page__item-badge">default</span>
                )}
                {w.id === activeId && (
                  <span className="workspaces-page__item-badge workspaces-page__item-badge--active">
                    active
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
        <div className="workspaces-page__create">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New workspace name"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void createWorkspace();
              }
            }}
          />
          <button
            type="button"
            disabled={!newName.trim()}
            onClick={() => void createWorkspace()}
          >
            + Create
          </button>
        </div>
      </aside>
      <main className="workspaces-page__main">
        {selected ? (
          <WorkspaceEditor
            workspace={selected}
            onSave={saveSelected}
            onDelete={deleteSelected}
          />
        ) : (
          <div className="workspaces-page__empty">
            Select a workspace from the rail, or create a new one.
          </div>
        )}
      </main>
    </section>
  );
}

interface EditorProps {
  workspace: WorkspaceDef;
  onSave(patch: WorkspaceInput): Promise<void>;
  onDelete(): Promise<void>;
}

function WorkspaceEditor({ workspace, onSave, onDelete }: EditorProps) {
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description ?? '');
  const [color, setColor] = useState(workspace.color ?? DEFAULT_COLOR);
  const [icon, setIcon] = useState(workspace.icon ?? '');
  const [overlay, setOverlay] = useState('');
  const [overlayPath, setOverlayPath] = useState('');
  const [overlayDirty, setOverlayDirty] = useState(false);

  // Re-hydrate when the selected workspace changes.
  useEffect(() => {
    setName(workspace.name);
    setDescription(workspace.description ?? '');
    setColor(workspace.color ?? DEFAULT_COLOR);
    setIcon(workspace.icon ?? '');
    setOverlayDirty(false);
    void window.jarvis
      .readWorkspacePreferences(workspace.id)
      .then(({ path, contents }) => {
        setOverlayPath(path);
        setOverlay(contents);
      });
  }, [workspace.id, workspace.name, workspace.description, workspace.color, workspace.icon]);

  const dirty =
    name.trim() !== workspace.name ||
    (description || '') !== (workspace.description ?? '') ||
    (color || '') !== (workspace.color ?? DEFAULT_COLOR) ||
    (icon || '') !== (workspace.icon ?? '');

  const commitFields = useCallback(() => {
    if (!dirty) return;
    void onSave({
      name: name.trim() || workspace.name,
      description: description.trim() || undefined,
      color: color.trim() || undefined,
      icon: icon.trim() || undefined,
    });
  }, [dirty, name, description, color, icon, workspace.name, onSave]);

  const commitOverlay = useCallback(async () => {
    try {
      await window.jarvis.writeWorkspacePreferences(workspace.id, overlay);
      setOverlayDirty(false);
      toast({ message: 'Workspace preferences saved' });
    } catch (err) {
      toast({
        message: err instanceof Error ? err.message : String(err),
        kind: 'error',
      });
    }
  }, [workspace.id, overlay]);

  return (
    <div className="workspace-editor">
      <header className="workspace-editor__head">
        <h2>{workspace.name}</h2>
        <code>{workspace.id}</code>
      </header>

      <div className="workspace-editor__grid">
        <label className="workspace-editor__field">
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitFields}
          />
        </label>

        <label className="workspace-editor__field">
          <span>Icon</span>
          <input
            value={icon}
            placeholder="e.g. ◎ ⚙ ♥ A"
            maxLength={2}
            onChange={(e) => setIcon(e.target.value)}
            onBlur={commitFields}
          />
          <small>Single glyph shown in the header pill + tray title.</small>
        </label>

        <label className="workspace-editor__field">
          <span>Color</span>
          <div className="workspace-editor__color">
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              onBlur={commitFields}
            />
            <input
              type="text"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              onBlur={commitFields}
              placeholder={DEFAULT_COLOR}
            />
          </div>
          <small>
            Tints the workspace pill, Bridge HUD border, and notch chrome.
          </small>
        </label>

        <label className="workspace-editor__field workspace-editor__field--wide">
          <span>Description</span>
          <input
            value={description}
            placeholder="One-line note for yourself"
            onChange={(e) => setDescription(e.target.value)}
            onBlur={commitFields}
          />
        </label>

        <div className="workspace-editor__field workspace-editor__field--wide">
          <span>Default workspace</span>
          <label className="workspace-editor__toggle">
            <input
              type="checkbox"
              checked={workspace.default === true}
              disabled={workspace.default === true}
              onChange={(e) => {
                void onSave({
                  name: workspace.name,
                  default: e.target.checked,
                });
              }}
            />
            <span>
              Used as the fall-through when no workspace is set + can't be
              deleted while flagged. Toggle another workspace to demote
              this one.
            </span>
          </label>
        </div>
      </div>

      <section className="workspace-editor__overlay">
        <header className="workspace-editor__overlay-head">
          <h3>Workspace preferences</h3>
          <small>
            Appends to base <code>~/.jarvis/preferences.md</code> in every
            task's system prompt when this workspace is active. Markdown —
            tone, style, "how I work" for THIS context only.
          </small>
        </header>
        <textarea
          className="workspace-editor__overlay-text"
          value={overlay}
          onChange={(e) => {
            setOverlay(e.target.value);
            setOverlayDirty(true);
          }}
          placeholder="# Workspace preferences&#10;&#10;Tone: …&#10;Defaults: …&#10;Avoid: …"
          rows={12}
          spellCheck={false}
        />
        <footer className="workspace-editor__overlay-foot">
          <code title={overlayPath}>{overlayPath}</code>
          <button
            type="button"
            className="workspace-editor__overlay-save"
            disabled={!overlayDirty}
            onClick={() => void commitOverlay()}
          >
            Save overlay
          </button>
        </footer>
      </section>

      <section className="workspace-editor__danger">
        <button
          type="button"
          className="workspace-editor__delete"
          disabled={workspace.default === true}
          onClick={() => void onDelete()}
          title={
            workspace.default
              ? 'Cannot delete the default workspace'
              : 'Permanently delete this workspace'
          }
        >
          Delete workspace
        </button>
      </section>
    </div>
  );
}
