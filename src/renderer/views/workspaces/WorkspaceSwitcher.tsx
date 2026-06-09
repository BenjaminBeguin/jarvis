import { useEffect, useRef, useState } from 'react';

import type { WorkspaceDef } from '../../../shared/types';

/**
 * WorkspaceSwitcher — top-of-shell control that picks the active
 * workspace. One level above the ProjectScopePicker: choosing a
 * workspace narrows which projects appear in the picker, which
 * projects show up on the Bridge, and which cron-driven entities
 * fire while the user is in that workspace.
 *
 * Visual shape: a compact pill that opens a dropdown listing every
 * workspace + "+ New workspace" at the bottom. The pill itself shows
 * the active workspace's icon (or first letter as fallback) plus its
 * name; the workspace's `color` accent tints the pill's left edge so
 * the user has a strong visual cue of which context they're in.
 *
 * Backed by Phase-1 IPC:
 *   - getActiveWorkspace / setActiveWorkspace / onActiveWorkspaceChanged
 *   - listWorkspaces / onWorkspacesChanged / createWorkspace
 *
 * Creating a workspace from the dropdown is intentionally low-friction
 * (name only, optional color picker post-create from Settings) so the
 * "I just realized I want a Side Project workspace" flow doesn't pull
 * the user into a settings page.
 */

interface Props {
  onSwitch?(id: string): void;
}

export function WorkspaceSwitcher({ onSwitch }: Props) {
  const [workspaces, setWorkspaces] = useState<WorkspaceDef[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.jarvis.listWorkspaces().then(setWorkspaces);
    const offWorkspaces = window.jarvis.onWorkspacesChanged(setWorkspaces);
    void window.jarvis.getActiveWorkspace().then(setActiveId);
    const offActive = window.jarvis.onActiveWorkspaceChanged(setActiveId);
    return () => {
      offWorkspaces();
      offActive();
    };
  }, []);

  // Click outside → close. Native CustomEvent so it integrates with
  // the Shell's other dropdown-close patterns (auth badge etc.).
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (e.target instanceof Node && rootRef.current.contains(e.target)) return;
      setOpen(false);
      setCreating(false);
      setNewName('');
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  const active = workspaces.find((w) => w.id === activeId) ?? null;

  const switchTo = async (id: string): Promise<void> => {
    const next = await window.jarvis.setActiveWorkspace(id);
    setActiveId(next);
    setOpen(false);
    onSwitch?.(next);
  };

  const createAndSwitch = async (): Promise<void> => {
    const name = newName.trim();
    if (!name) return;
    try {
      const def = await window.jarvis.createWorkspace({ name });
      await switchTo(def.id);
      setNewName('');
      setCreating(false);
    } catch (err) {
      console.warn('createWorkspace failed:', err);
    }
  };

  return (
    <div className="workspace-switcher" ref={rootRef}>
      <button
        type="button"
        className="workspace-switcher__pill"
        onClick={() => setOpen((v) => !v)}
        title={
          active?.description ??
          (active ? `Workspace: ${active.name}` : 'No workspace selected')
        }
        style={
          active?.color
            ? ({ '--workspace-color': active.color } as React.CSSProperties)
            : undefined
        }
      >
        <span className="workspace-switcher__icon" aria-hidden>
          {active?.icon ?? active?.name?.charAt(0).toUpperCase() ?? '◎'}
        </span>
        <span className="workspace-switcher__name">
          {active?.name ?? 'Workspace'}
        </span>
        <span className="workspace-switcher__chevron" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="workspace-switcher__menu" role="menu">
          <div className="workspace-switcher__menu-head">WORKSPACES</div>
          {workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              className={`workspace-switcher__item${
                w.id === activeId ? ' workspace-switcher__item--active' : ''
              }`}
              onClick={() => void switchTo(w.id)}
              style={
                w.color
                  ? ({ '--workspace-color': w.color } as React.CSSProperties)
                  : undefined
              }
              role="menuitem"
            >
              <span className="workspace-switcher__item-icon" aria-hidden>
                {w.icon ?? w.name.charAt(0).toUpperCase()}
              </span>
              <span className="workspace-switcher__item-name">{w.name}</span>
              {w.default && (
                <span className="workspace-switcher__badge">default</span>
              )}
            </button>
          ))}
          <div className="workspace-switcher__divider" />
          {workspaces.length <= 1 && !creating && (
            // Onboarding nudge — only shown until the user creates a
            // second workspace. The "what's a workspace?" affordance
            // sits inside the dropdown they'd open to discover the
            // feature; once they've made a second workspace it's
            // obvious and the nudge can retire itself.
            <div className="workspace-switcher__nudge">
              <strong>Try a workspace.</strong>
              <p>
                Group "Work" projects + workflows separately from "Side
                Project" or "Personal." Switching context narrows
                everything: Bridge, Inbox, drafts, cron-driven
                workflows.
              </p>
            </div>
          )}
          {creating ? (
            <div className="workspace-switcher__create">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Workspace name"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void createAndSwitch();
                  }
                  if (e.key === 'Escape') {
                    setCreating(false);
                    setNewName('');
                  }
                }}
              />
              <button
                type="button"
                className="workspace-switcher__create-confirm"
                disabled={!newName.trim()}
                onClick={() => void createAndSwitch()}
              >
                Create
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="workspace-switcher__add"
              onClick={() => setCreating(true)}
              role="menuitem"
            >
              + New workspace
            </button>
          )}
        </div>
      )}
    </div>
  );
}
