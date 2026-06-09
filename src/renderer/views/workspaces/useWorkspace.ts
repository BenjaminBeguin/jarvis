import { useEffect, useMemo, useState } from 'react';

import type { ProjectDef, WorkspaceDef } from '../../../shared/types';

/**
 * Shared workspace state for the renderer.
 *
 * Single hook every view should use to know "what workspace are we
 * in?" + "what workspaces exist?". Subscribes once on mount + tears
 * down on unmount; the upstream IPC subscription is multiplexed so
 * many consumers don't multiply listeners on the main side.
 *
 * Output:
 *   - id      : the active workspace id (always defined; falls back
 *               to the default workspace id when no explicit choice).
 *   - active  : the WorkspaceDef of the active id, or null while
 *               the initial fetch hasn't landed.
 *   - all     : every WorkspaceDef in display order (default first).
 *   - belongs : a memoized predicate `(project) → boolean` that tells
 *               whether a project lives in the active workspace.
 *               Projects without a workspaceId are considered "global"
 *               and visible in every workspace — matches the
 *               main-side semantics for null-workspaceId entries.
 *
 * Used by ScopePicker, Bridge ProjectPulse, Bridge FocusCard, Inbox,
 * Drafts, Activity, Settings → Projects.
 */
export interface WorkspaceState {
  id: string | null;
  active: WorkspaceDef | null;
  all: WorkspaceDef[];
  belongs(project: ProjectDef): boolean;
}

export function useWorkspace(): WorkspaceState {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceDef[]>([]);

  useEffect(() => {
    void window.jarvis.listWorkspaces().then(setWorkspaces);
    const offWorkspaces = window.jarvis.onWorkspacesChanged(setWorkspaces);
    void window.jarvis.getActiveWorkspace().then((id) => setActiveId(id));
    const offActive = window.jarvis.onActiveWorkspaceChanged((id) =>
      setActiveId(id),
    );
    return () => {
      offWorkspaces();
      offActive();
    };
  }, []);

  const active = useMemo(
    () => workspaces.find((w) => w.id === activeId) ?? null,
    [workspaces, activeId],
  );

  // Default first, then everything else in stored order.
  const all = useMemo(() => {
    const def = workspaces.find((w) => w.default);
    const rest = workspaces.filter((w) => !w.default);
    return def ? [def, ...rest] : workspaces;
  }, [workspaces]);

  const belongs = useMemo(() => {
    return (project: ProjectDef): boolean => {
      // No active id yet (initial fetch in flight) → show everything
      // so the UI isn't blank on first render.
      if (!activeId) return true;
      // Project without workspaceId = global / shared, visible
      // everywhere. Matches the main-side rule for null fields.
      if (!project.workspaceId) return true;
      return project.workspaceId === activeId;
    };
  }, [activeId]);

  return { id: activeId, active, all, belongs };
}
