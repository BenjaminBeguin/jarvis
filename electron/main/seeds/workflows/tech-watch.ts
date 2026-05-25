import type { WorkflowDef } from '@shared/types';

/**
 * Tech-watch sync workflow.
 *
 *   trigger:  once a day, 8 AM on weekdays
 *   pipeline: run-skill (tech-watch)
 *
 * Fires the `tech-watch` skill on a daily cadence. The skill reads
 * `~/.jarvis/tech-watch.md`, pulls items from the listed RSS feeds
 * (with a WebSearch fallback when feeds are thin) and the listed
 * Gmail newsletter senders, then writes
 * `~/.jarvis/inbox/tech-watch.json`. The Inbox tab + the
 * inbox-curate Smart re-rank pick it up on their next refresh — no
 * further plumbing.
 *
 * Cron is literal `0 8 * * 1-5`, not `{businessHours}`. The
 * businessHours token is for recurring intra-day fires; tech-watch
 * is once a day at a fixed time, so the user's start-hour pref
 * isn't relevant. News doesn't change minute-to-minute and the
 * skill burns a non-trivial set of WebFetch + Gmail calls per run.
 *
 * Manual refresh: workflows automatically support `/wf tech-watch-sync`
 * in the palette and `mcp__jarvis__run_workflow({ id: 'tech-watch-sync' })`
 * via the Jarvis MCP. The Workflows tab also has a Run Now button.
 */
export const TECH_WATCH_WORKFLOW: WorkflowDef = {
  id: 'tech-watch-sync',
  name: 'Sync tech watch',
  description:
    'Each weekday at 8 AM, pull RSS + newsletter items from your tech-watch.md config and write a ranked Inbox digest.',
  enabled: true,
  trigger: { kind: 'cron', every: '0 8 * * 1-5' },
  pipeline: [
    {
      type: 'run-skill',
      params: {
        skillId: 'tech-watch',
        prompt:
          'Refresh tech-watch. Read ~/.jarvis/tech-watch.md, pull RSS + newsletters (with WebSearch fallback when RSS is thin), write ~/.jarvis/inbox/tech-watch.json. Be quiet on success.',
      },
    },
  ],
};
