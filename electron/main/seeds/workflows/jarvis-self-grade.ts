import type { WorkflowDef } from '@shared/types';

/**
 * Weekly Jarvis self-grade.
 *
 *   trigger:  Monday 09:00 — first thing the user sees after the
 *             weekly-retro briefing fires.
 *   pipeline: run-skill (jarvis-self-grade)
 *
 * The skill audits drafts / workflows / escalations / cost / chronic
 * friction signals from the last 7 days and writes a graded report
 * to ~/.jarvis/briefings/jarvis-self-grade/<YYYY-Www>.md.
 *
 * This is Jarvis grading Jarvis — not the user. The point is to spot
 * which skills are sharp, which are bleeding money, and which need
 * re-prompting. Surfaces as a briefing kind so it shows up in the
 * Routines/Briefings UI alongside the daily / weekly briefs.
 *
 * Default `enabled: true` — like daily-learn this delivers value
 * from day one (a "not enough data yet" report still tells the user
 * Jarvis is watching its own outputs).
 */
export const JARVIS_SELF_GRADE_WORKFLOW: WorkflowDef = {
  id: 'jarvis-self-grade-loop',
  name: 'Jarvis self-grade',
  description:
    'Every Monday at 09:00, audits last week\'s drafts / workflows / escalations / cost / chronic friction signals and writes a graded report to ~/.jarvis/briefings/jarvis-self-grade/. Spots which skills earned their place and which need re-prompting.',
  enabled: true,
  trigger: { kind: 'cron', every: '0 9 * * 1' },
  pipeline: [
    {
      type: 'run-skill',
      params: {
        skillId: 'jarvis-self-grade',
        prompt:
          'Run the weekly self-grade per your system prompt. Read last 7 days of drafts, workflow runs, task escalations, cost, daily learnings, and goals. Write the report to ~/.jarvis/briefings/jarvis-self-grade/<YYYY-MM-DD>-week-<NN>.md (Monday of this ISO week) and emit the one-line confirmation.',
      },
    },
  ],
};
