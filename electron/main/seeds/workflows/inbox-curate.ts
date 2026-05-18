import type { WorkflowDef } from '@shared/types';

/**
 * Smart inbox curation workflow.
 *
 *   trigger:  every 10 min
 *   pipeline: run-skill (inbox-curate)
 *
 * Fires the `inbox-curate` skill on a cadence. The skill reads the
 * raw inbox feeds + `~/.jarvis/inbox-priorities.md` and writes
 * `~/.jarvis/inbox/smart.json` directly via the Write tool. The
 * userInboxSource picks the file up on the next inbox refresh, so
 * the Smart section appears in the Inbox tab without any further
 * plumbing.
 *
 * No transform / inbox-write nodes — the skill does the writing
 * itself, and the run-skill node's output is just the final
 * assistant text (one-line confirmation: "Smart inbox: N items").
 *
 * Cadence: 10 min matches the raw inbox sources (5 min cron + the
 * tab's 5-min auto-refresh). Going faster would burn money without
 * a new signal; slower would let the Smart section feel stale right
 * after a calibration.
 */
export const INBOX_CURATE_WORKFLOW: WorkflowDef = {
  id: 'inbox-curate-sync',
  name: 'Curate Smart inbox',
  description:
    'Every 15 minutes during your working hours, re-rank the raw inbox into a Smart section using your priorities.md.',
  enabled: true,
  // {businessHours} pulls from the user's working-hours pref so a
  // single setting drives every cron-based inbox feed. Cuts haiku
  // cost ~5× vs 24/7. Edit to '10m' for round-the-clock refresh.
  trigger: { kind: 'cron', every: '*/15 {businessHours}' },
  pipeline: [
    {
      type: 'run-skill',
      params: {
        skillId: 'inbox-curate',
        prompt:
          'Refresh the Smart inbox. Read ~/.jarvis/inbox-priorities.md + ~/.jarvis/inbox/*.json, decide what matters now, write ~/.jarvis/inbox/smart.json. Be quiet on success.',
      },
    },
  ],
};
