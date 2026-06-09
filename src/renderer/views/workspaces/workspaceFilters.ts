import type { ProjectDef } from '../../../shared/types';

/**
 * Shared workspace-visibility rules for "things that carry a project
 * name" — tasks, drafts, activity events, inbox items pre-matched.
 *
 * Three buckets:
 *   - No active workspace id → everything visible (initial render path)
 *   - Entity has no project name → visible (global / cross-workspace)
 *   - Entity has a project name → resolve to ProjectDef, check
 *     workspaceId. Unknown project → visible (don't lose orphan rows).
 *     Project workspaceId null → visible (workspace-less project).
 *     Project workspaceId matches → visible.
 *     Anything else → hidden.
 *
 * The "unknown project" fallback (visible) matters because the
 * project store can lag the inbox / activity stores on rename or
 * project-deleted edge cases. Better to flash a stale row briefly
 * than to silently hide an item the user wrote when they were on a
 * project that doesn't exist anymore.
 */
export function entityInActiveWorkspace(opts: {
  projectName: string | null | undefined;
  projects: ProjectDef[];
  activeWorkspaceId: string | null;
}): boolean {
  const { projectName, projects, activeWorkspaceId } = opts;
  if (!activeWorkspaceId) return true;
  if (!projectName) return true;
  const match = projects.find(
    (p) =>
      p.name.toLowerCase() === projectName.toLowerCase() ||
      p.aliases.some((a) => a.toLowerCase() === projectName.toLowerCase()),
  );
  if (!match) return true;
  if (!match.workspaceId) return true;
  return match.workspaceId === activeWorkspaceId;
}
