import type { WorkflowDef } from '@shared/types';

/**
 * Goal progress tracking loop.
 *
 *   trigger:  18:30 weekdays — after daily-learn so any
 *             newly-inferred patterns are already on disk.
 *   pipeline: run-skill (goal-progress)
 *
 * The skill reads ~/.jarvis/goals.json (active only), then scans the
 * day's activity for matches against each goal's relatedKeywords:
 *   - PRs merged / reviews requested
 *   - Meeting transcripts mentioning the keywords
 *   - Notes / activity feed
 *
 * For each match, it calls mcp__jarvis__append_goal_progress so the
 * goal's progressLog grows automatically. The user marks the goal
 * done via /goal-done — this skill never auto-completes a goal.
 *
 * No-op when no goals are active or no signal matches today.
 */
export const GOAL_PROGRESS_WORKFLOW: WorkflowDef = {
  id: 'goal-progress-loop',
  name: 'Goal progress',
  description:
    'Every weekday at 18:30, reads active goals + scans the day\'s PRs / meetings / notes / activity for keyword matches, then appends progress entries to the matching goals. Quiet by default — no matches means no entries.',
  enabled: true,
  trigger: { kind: 'cron', every: '30 18 * * 1-5' },
  pipeline: [
    {
      type: 'run-skill',
      params: {
        skillId: 'goal-progress',
        prompt:
          'Run the goal-progress pass per your system prompt. List active goals, scan the last 24h of PRs / meetings / notes / activity, append a progress entry for each match. Emit the one-line confirmation only.',
      },
    },
  ],
};
