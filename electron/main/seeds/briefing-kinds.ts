import type { DigestKind } from '../briefings.js';

/**
 * Built-in briefing kinds. The Routines tab uses these to identify
 * which routines are briefings (id pattern: `briefing-<kindId>`) and
 * to render their markdown output inline in the per-routine history
 * pane. The Dashboard uses the same lookup for pinned routine items.
 * Add more by appending to this list and authoring the matching skill
 * — the same shape supports any future generated-doc collection
 * (status reports, ADRs, cost reports, …).
 */
export const BUILTIN_BRIEFING_KINDS: DigestKind[] = [
  {
    id: 'daily-recap',
    label: 'Daily recap',
    description:
      "What you worked on yesterday — meetings, PRs, Linear, completed tasks. Citations linked.",
    skillId: 'daily-recap',
    schedule: '0 8 * * *',
  },
  {
    id: 'weekly-retro',
    label: 'Weekly retro',
    description:
      "Last 7 days: shipped / blocked / open threads. Monday morning is the natural cadence.",
    skillId: 'weekly-retro',
    schedule: '0 9 * * 1',
  },
  {
    id: 'today-focus',
    label: "Today's focus",
    description:
      "Right now: calendar, inbox, scheduled actions, proposed priority. Generated each morning.",
    skillId: 'today-focus',
    schedule: '15 8 * * *',
  },
];
