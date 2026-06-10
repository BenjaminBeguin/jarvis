import type { InboxItem, ProjectDef } from '../../../shared/types';

/**
 * Workspace filter for inbox items.
 *
 * Returns a predicate `(item) => boolean` that keeps items belonging to
 * the active workspace AND drops items whose matched project lives in
 * a DIFFERENT workspace. Items that don't match any project are kept
 * (treated as global / cross-workspace — same rule the rest of the app
 * uses for null workspaceId fields).
 *
 * Used by bridge widgets that surface inbox-feed data (TodayTimeline's
 * calendar blips, StreamTicker's chips that carry a project hint).
 * FocusCard reimplements this locally because it also threads an
 * "active project" filter underneath — extracting both would be
 * over-fitting until a third caller appears.
 *
 * Matching strategy mirrors FocusCard / ProjectPulse: the inbox item's
 * `project` field is the strongest signal (matched against each
 * ProjectDef's name + aliases case-insensitively). Falls back to scanning
 * title + subtitle + url for repo / name / alias / keyword hits when
 * `project` isn't set. Keep this in lockstep with FocusCard's
 * `itemBelongsToProject` — divergence would surface as "the meeting
 * shows up on the timeline but not in the focus card."
 */
export function inWorkspace(
  workspaceId: string | null,
  projects: ProjectDef[],
): (item: InboxItem) => boolean {
  if (!workspaceId) return () => true;
  return (item: InboxItem): boolean => {
    const match = findMatchingProject(item, projects);
    if (!match) return true; // no project → global, visible everywhere
    if (!match.workspaceId) return true; // explicitly global project
    return match.workspaceId === workspaceId;
  };
}

function findMatchingProject(
  item: InboxItem,
  projects: ProjectDef[],
): ProjectDef | null {
  if (item.project) {
    const needle = item.project.toLowerCase();
    const fromField = projects.find(
      (p) =>
        p.name.toLowerCase() === needle ||
        p.aliases.some((a) => a.toLowerCase() === needle),
    );
    if (fromField) return fromField;
  }
  const haystack =
    `${item.title} ${item.subtitle ?? ''} ${item.url ?? ''}`.toLowerCase();
  if (!haystack.trim()) return null;
  for (const p of projects) {
    for (const repo of p.repos ?? []) {
      const needle = repo.toLowerCase();
      if (needle && haystack.includes(needle)) return p;
      const shortName = needle.split('/').pop();
      if (shortName && shortName.length > 3 && haystack.includes(shortName)) {
        return p;
      }
    }
    if (haystack.includes(p.name.toLowerCase())) return p;
    for (const a of p.aliases) {
      if (a.length > 2 && haystack.includes(a.toLowerCase())) return p;
    }
    for (const k of p.keywords ?? []) {
      if (k.length > 2 && haystack.includes(k.toLowerCase())) return p;
    }
  }
  return null;
}
