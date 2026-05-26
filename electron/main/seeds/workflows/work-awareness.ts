import type { WorkflowDef } from '@shared/types';

/**
 * Work-awareness loop.
 *
 *   trigger:  every 30 min during {businessHours}
 *   pipeline: run-skill (work-awareness)
 *
 * Drives Jarvis's ambient watcher. The skill reads recent meeting
 * transcripts, notes, the live inbox, the activity feed, AND
 * whichever Slack/GitHub/Linear/Notion MCPs are connected, then
 * synthesises a short "your attention" list into
 * \`~/.jarvis/inbox/work-awareness.json\`. The Inbox tab picks the
 * file up on the next refresh, so the section appears without any
 * further plumbing.
 *
 * Cadence: 30 min is conservative — the skill is heavier than
 * inbox-curate (it reads disk + multiple MCPs), so we don't want
 * to burn tokens every 10 min. Edit to '*​/15 {businessHours}'
 * if you want tighter latency at higher cost.
 *
 * No transform / inbox-write nodes — the skill does the writing
 * itself, same pattern as inbox-curate.
 *
 * Default `enabled: false` — needs the priorities file to be
 * meaningfully calibrated first. The "first-run nudge" surfaces
 * `/work-awareness-calibrate` (a future palette intent) once we
 * detect placeholder content in the priorities file.
 */
export const WORK_AWARENESS_WORKFLOW: WorkflowDef = {
  id: 'work-awareness-loop',
  name: 'Work awareness loop',
  description:
    'Every 30 min during your working hours, scan recent work signal (Slack mentions, PR activity, meeting action items, notes, calendar) and synthesise a "your attention" inbox section. Also proposes dismissals for items you already handled.',
  enabled: false,
  trigger: { kind: 'cron', every: '*/30 {businessHours}' },
  pipeline: [
    {
      type: 'run-skill',
      params: {
        skillId: 'work-awareness',
        prompt:
          'Run the ambient work-awareness pass per your system prompt. Output the one-line confirmation only — the JSON goes to disk via Write.',
      },
    },
  ],
};
