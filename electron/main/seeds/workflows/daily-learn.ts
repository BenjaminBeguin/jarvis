import type { WorkflowDef } from '@shared/types';

/**
 * Daily learning loop.
 *
 *   trigger:  18:00 weekdays (end of typical working hours)
 *   pipeline: run-skill (daily-learn)
 *
 * The skill reads the day's activity feed, inbox dismissals, draft
 * outcomes, task patterns, recent meetings, and the user's current
 * explicit config, then writes:
 *
 *   - \`~/.jarvis/learnings/<YYYY-MM-DD>.md\` — human-readable
 *     journal the user can scroll back through to see how Jarvis
 *     thinks they work.
 *   - \`~/.jarvis/learnings/inferred-priorities.md\` — running
 *     consolidated view (rewritten daily from rolling 14d window).
 *     Consumed by inbox-curate + work-awareness as supplemental
 *     input alongside the user's explicit priorities files.
 *
 * Default cadence is once-per-day at end of business hours so the
 * day's signal is complete. Daylight saving / different working
 * hours: edit the cron directly. The skill is heavier than
 * inbox-curate (lots of disk + MCP reads + balanced model), so
 * we don't want it firing multiple times a day.
 *
 * Default `enabled: true` — unlike work-awareness this one has
 * zero config requirement to start delivering value. First-run
 * lands a journal even if every input is empty (just confirms
 * nothing-to-learn-yet).
 */
export const DAILY_LEARN_WORKFLOW: WorkflowDef = {
  id: 'daily-learn-loop',
  name: 'Daily learn',
  description:
    'Every weekday at 18:00, reads what you did today (dismissals, drafts accepted/discarded, task escalations, repeated palette prompts) and writes a daily journal + running inferred-priorities.md. Consumed by inbox-curate + work-awareness so Jarvis gets sharper from use without manual configuration.',
  enabled: true,
  trigger: { kind: 'cron', every: '0 18 * * 1-5' },
  pipeline: [
    {
      type: 'run-skill',
      params: {
        skillId: 'daily-learn',
        prompt:
          'Run the daily meta-learning pass per your system prompt. Output the one-line confirmation only — the journal + inferred-priorities go to disk via Write.',
      },
    },
  ],
};
