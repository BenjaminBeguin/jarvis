import type { InboxItem } from '@shared/types';

import type { Module, ModuleContext } from './types.js';

/**
 * Calendar module.
 *
 * Renderer page (src/renderer/modules/CalendarPage.tsx) aggregates
 * calendar events, reminders, scheduled actions, and routine fires
 * into Month / Week / Day / Agenda views. No main-side state is needed
 * for the page because all the data sources (inbox, reminders,
 * routines) are already managed by their own stores.
 *
 * Main-side, this module **owns the calendar ambient-context provider**.
 * It reads the inbox (source='calendar', written by the
 * calendar-today-sync workflow every 10 min) and shapes a compact
 * markdown block that's injected into every Claude turn. So when the
 * user asks "what's my plan today?" the agent answers from cached
 * context — no tool round-trip.
 *
 * Disabling the module from Settings drops the provider too (onUnload).
 */

// Captured in onLoad so onUnload — which doesn't receive ctx — can
// still call unregister. Module is a singleton; safe to hold one ref.
let savedCtx: ModuleContext | null = null;

export const calendarModule: Module = {
  id: 'calendar',
  name: 'Calendar',
  description:
    'Month / Week / Day / Agenda views over Google Calendar + reminders + routine fires. Also injects upcoming calendar context into every Claude turn.',
  version: '1.0.0',
  memory: [
    {
      label: 'Calendar events (rolling 14-day window)',
      location: '~/.jarvis/inbox/calendar.json',
      kind: 'file',
      access: 'read',
      notes:
        'Written by the calendar-today-sync workflow every 10 min. Module reads it for the agenda views + the ambient context provider.',
    },
  ],
  onLoad(ctx) {
    savedCtx = ctx;
    ctx.registerContextProvider({
      name: 'calendar',
      // `build()` runs on EVERY task launch — read-only, no I/O.
      // listInboxItems is RAM-cheap (single Map traversal).
      build: () => buildCalendarContext(ctx.listInboxItems()),
    });
  },
  onUnload() {
    savedCtx?.unregisterContextProvider('calendar');
    savedCtx = null;
  },
};

/**
 * Compact "what's on your calendar" block. Returns null when no events
 * have been synced (no Google account connected, paused, etc.) so the
 * provider stays silent rather than emitting "Calendar: nothing".
 *
 * Format is deliberately tight — the agent only needs enough to answer
 * "what's my plan today / when's my next meeting / how busy am I" from
 * the cached prefix. For deep dives ("who's on the standup?"), the
 * agent can still call the calendar MCP directly.
 */
function buildCalendarContext(items: InboxItem[]): string | null {
  const events = items
    .filter((i) => i.source === 'calendar' && typeof i.fireAt === 'number')
    .sort((a, b) => (a.fireAt ?? 0) - (b.fireAt ?? 0));
  if (events.length === 0) return null;

  const now = Date.now();
  const startOfTomorrow = startOfDay(now) + 24 * 60 * 60 * 1000;
  const startOfDayAfter = startOfTomorrow + 24 * 60 * 60 * 1000;
  const endOfWeek = startOfDay(now) + 7 * 24 * 60 * 60 * 1000;

  const upcoming = events.filter((i) => (i.fireAt ?? 0) >= now - 60_000);
  const todays = upcoming.filter((i) => (i.fireAt ?? 0) < startOfTomorrow);
  const tomorrows = upcoming.filter(
    (i) =>
      (i.fireAt ?? 0) >= startOfTomorrow && (i.fireAt ?? 0) < startOfDayAfter,
  );
  const weekRest = upcoming.filter((i) => (i.fireAt ?? 0) < endOfWeek);

  const lines: string[] = ['- Calendar (auto-synced):'];

  const next = upcoming[0];
  if (next) {
    const startMs = next.fireAt ?? 0;
    const mins = Math.round((startMs - now) / 60_000);
    const when =
      mins <= 0
        ? 'now'
        : mins < 60
          ? `in ${mins}m`
          : `at ${hhmm(startMs)}${mins < 24 * 60 ? '' : ' tomorrow'}`;
    lines.push(`  - Next: ${trimTitle(next.title)} ${when}`);
  } else {
    lines.push('  - Next: (nothing on the horizon)');
  }

  if (todays.length > 0) {
    const compact = todays
      .slice(0, 5)
      .map((i) => `${hhmm(i.fireAt ?? 0)} ${trimTitle(i.title, 40)}`)
      .join('; ');
    lines.push(`  - Today (${todays.length}): ${compact}`);
  } else {
    lines.push('  - Today: nothing left');
  }

  if (tomorrows.length > 0) {
    const compact = tomorrows
      .slice(0, 5)
      .map((i) => `${hhmm(i.fireAt ?? 0)} ${trimTitle(i.title, 40)}`)
      .join('; ');
    lines.push(`  - Tomorrow (${tomorrows.length}): ${compact}`);
  }

  // Week-shape: per-day counts so the agent can say "heavy Wed/Thu,
  // light Friday" without us doing the heuristic for it.
  if (weekRest.length > 0) {
    const byDay = new Map<string, number>();
    for (const i of weekRest) {
      const d = new Date(i.fireAt ?? 0);
      const key = d.toLocaleDateString(undefined, { weekday: 'short' });
      byDay.set(key, (byDay.get(key) ?? 0) + 1);
    }
    const summary = Array.from(byDay.entries())
      .map(([day, n]) => `${day}:${n}`)
      .join(' ');
    lines.push(`  - Week-shape (next 7d, meetings/day): ${summary}`);
  }

  return lines.join('\n');
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function hhmm(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function trimTitle(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
