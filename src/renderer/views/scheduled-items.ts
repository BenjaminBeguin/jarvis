import { nextCronFire } from '../../shared/cron';
import type { InboxItem, Reminder, RoutineDef } from '../../shared/types';

/**
 * One row in any "what's scheduled" view (Dashboard Calendar section,
 * Calendar module page). Discriminated by `kind` so the renderer can
 * pick the right chip + the right action set in the detail panel.
 *
 * Shared between the Dashboard section and the standalone Calendar
 * module so both views read identical data — easier to reason about,
 * single bug surface for the cron parser + horizon logic.
 */
export interface ScheduledItem {
  id: string;
  kind:
    | 'event'
    | 'reminder'
    | 'scheduled-action'
    | 'inbox-task'
    | 'routine-next'
    | 'routine-last';
  title: string;
  subtitle?: string;
  fireAt: number;
  /** Optional end time for events with duration. Used by Day/Week to
   * size the event block; ignored by month grid + agenda views. */
  endAt?: number;
  url?: string;
  source?: string;
  raw: InboxItem | Reminder | RoutineDef;
}

export const KIND_LABEL: Record<ScheduledItem['kind'], string> = {
  event: 'EVENT',
  reminder: 'REMINDER',
  'scheduled-action': 'AUTOPILOT',
  'inbox-task': 'INBOX',
  'routine-next': 'ROUTINE',
  'routine-last': 'JUST RAN',
};

/**
 * Merge inbox + reminders + routines into one time-sorted list.
 *
 *   - Inbox items with fireAt → 'event' (source='calendar') or
 *     'inbox-task'.
 *   - Pending reminders/scheduled actions → 'reminder' / 'scheduled-action'.
 *   - Enabled routines: next-fire within `horizonDays` → 'routine-next'.
 *   - Routines that fired within the past 12h → 'routine-last'.
 *
 * `horizonDays` controls how far into the future routine fires are
 * projected — 7 by default (dashboard section), bumped to 60 by the
 * Calendar module so Month view can show recurring routines a few
 * weeks out.
 */
export function buildScheduledItems(
  inboxItems: InboxItem[],
  reminders: Reminder[],
  routines: RoutineDef[],
  now: number,
  horizonDays = 7,
): ScheduledItem[] {
  const out: ScheduledItem[] = [];
  for (const r of reminders) {
    if (r.status !== 'pending') continue;
    out.push({
      id: `rem-${r.id}`,
      kind: r.mode === 'scheduled' ? 'scheduled-action' : 'reminder',
      title: r.body,
      fireAt: r.fireAt,
      source: r.mode,
      raw: r,
    });
  }
  for (const it of inboxItems) {
    if (it.fireAt == null) continue;
    if (it.source === 'reminders') continue;
    out.push({
      id: `inbox-${it.id}`,
      kind: it.source === 'calendar' ? 'event' : 'inbox-task',
      title: it.title,
      subtitle: it.subtitle,
      fireAt: it.fireAt,
      url: it.url,
      source: it.source,
      raw: it,
    });
  }
  const horizon = now + horizonDays * 24 * 60 * 60 * 1000;
  const lookback = now - 12 * 60 * 60 * 1000;
  for (const r of routines) {
    // Hidden routines: per-user opt-out via the Routines detail toggle.
    // High-frequency pollers (every-10-min) clutter the timeline; this
    // lets the user keep them running without seeing them in Calendar.
    if (r.showInCalendar === false) continue;
    if (r.enabled) {
      // Multiple fires within the horizon for Month view — start from now
      // and walk forward until we cross the horizon.
      let cursor = now;
      let added = 0;
      while (added < 30) {
        const next = nextCronFire(r.cron, cursor);
        if (next == null || next > horizon) break;
        out.push({
          id: `routine-next-${r.id}-${next}`,
          kind: 'routine-next',
          title: r.id.replace(/^briefing-/, ''),
          subtitle: r.input || undefined,
          fireAt: next,
          source: r.skillId,
          raw: r,
        });
        cursor = next + 60_000; // step past this minute to find the NEXT fire
        added++;
      }
    }
    if (r.lastRunAt && r.lastRunAt >= lookback) {
      out.push({
        id: `routine-last-${r.id}`,
        kind: 'routine-last',
        title: r.id.replace(/^briefing-/, ''),
        subtitle: r.input || undefined,
        fireAt: r.lastRunAt,
        source: r.skillId,
        raw: r,
      });
    }
  }
  return out.sort((a, b) => a.fireAt - b.fireAt);
}
