import { loadActiveWorkspaceId } from './auth.js';
import type { WorkspaceStore } from './workspaces.js';

/**
 * Build the workspace-scope gate every cron-driven subsystem consults
 * at fire time. Returns true when the given `workspaceId` should be
 * allowed to fire RIGHT NOW.
 *
 * Rules:
 *   - `workspaceId == null` → always fires (workspace-agnostic /
 *      global / legacy entries pre-dating workspaces). Workflows
 *      like daily-learn, morning-brief, calendar-sync are tagged
 *      null on purpose — they're cross-workspace concerns.
 *   - `workspaceId === active` → fires.
 *   - `workspaceId` points at a workspace that no longer exists →
 *      fires (don't silently drop fires for orphans; rather have
 *      a stray Slack-inbox tick than a silent failure).
 *   - Otherwise (mismatch) → skip.
 *
 * The gate is a function, not a value, so it always reads the LATEST
 * active id at the moment of fire. Switching workspaces mid-session
 * takes effect on the next cron tick without restarting schedulers.
 */
export function buildWorkspaceGate(workspaces: WorkspaceStore): (
  workspaceId: string | null | undefined,
) => boolean {
  return (workspaceId) => {
    if (!workspaceId) return true;
    const activeId = loadActiveWorkspaceId() ?? workspaces.getDefault().id;
    if (workspaceId === activeId) return true;
    // Workspace doesn't exist anymore → fall through to "fire".
    if (!workspaces.get(workspaceId)) return true;
    return false;
  };
}
