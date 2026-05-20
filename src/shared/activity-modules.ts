/**
 * Single source of truth for "which module owns this activity kind".
 *
 * Activity events use a dotted naming convention (`note.created`,
 * `meeting.started`, `dedupe.scanned`) where the prefix already names
 * the feature area. This file maps those prefixes to the moduleId
 * that owns the surface, so we can:
 *
 *   - Filter the Activity feed by module
 *   - Render a per-module history pane in the Module Settings modal
 *   - Give cross-cutting events (`mcp.*`, `inbox.*`, `project.*`) a
 *     `null` mapping so they don't get attributed to one module.
 *
 * Add new mappings here whenever a module starts emitting a new kind.
 * Keep it data-driven — no special cases scattered across renderer
 * code.
 */

const KIND_PREFIX_TO_MODULE: Array<[string, string | null]> = [
  ['note.', 'quick-note'],
  ['dedupe.', 'quick-note'],
  ['meeting.', 'meeting-recorder'],
  ['reminder.', 'reminders'],
  ['pr.', 'pr-workflows'],
  ['skill-suggester.', 'skill-suggester'],
  ['skill-suggestion.', 'skill-suggester'],
  ['send.', 'send'],
  ['shell.', 'shell'],
  ['status.', 'status'],
  // Autopilot scenarios are workflows under the hood — their
  // approval / drafted / rejected events surface in the workflows
  // module's history alongside the explicit workflow.* rows.
  ['workflow.', 'workflows'],
  ['autopilot.', 'workflows'],
  ['telegram.', 'telegram-bot'],
  // Cross-cutting — not owned by a single module:
  ['mcp.', null],
  ['inbox.', null],
  ['project.', null],
  ['integration.', null],
  ['auth.', null],
  ['mode.', null],
  ['paused.', null],
  ['afk.', null],
  ['routine.', null],
  ['preferences.', null],
  ['notification-prefs.', null],
  ['inbox-prefs.', null],
  ['housekeeping.', null],
  ['briefing.', null],
  ['jarvis-file.', null],
  ['task.', null],
];

/**
 * Map an activity event kind to the moduleId that owns it.
 *
 * Two paths:
 *   1. `module.<state>` events carry the moduleId in `detail.moduleId`
 *      (module.enabled / module.disabled / module.settings-changed).
 *   2. Domain events (note.*, meeting.*, …) map via the prefix table
 *      above. This is the typical case.
 */
export function moduleIdFromActivityKind(
  kind: string,
  detail?: unknown,
): string | null {
  if (kind.startsWith('module.')) {
    if (detail && typeof detail === 'object') {
      const d = detail as Record<string, unknown>;
      if (typeof d.moduleId === 'string') return d.moduleId;
    }
    return null;
  }
  for (const [prefix, moduleId] of KIND_PREFIX_TO_MODULE) {
    if (kind.startsWith(prefix)) return moduleId;
  }
  return null;
}

/** All distinct module ids that ever attribute activity. Stable order
 *  so the Activity filter chip strip renders deterministically. */
export function allActivityModuleIds(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [, moduleId] of KIND_PREFIX_TO_MODULE) {
    if (moduleId && !seen.has(moduleId)) {
      seen.add(moduleId);
      out.push(moduleId);
    }
  }
  return out;
}
