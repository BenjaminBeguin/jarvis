import type { WorkflowDef } from '@shared/types';

/**
 * Morning brief loop.
 *
 *   trigger:  08:15 weekdays (just before typical working hours)
 *   pipeline: run-skill (today-focus) → notify
 *
 * The today-focus skill writes a forward-looking markdown file at
 * \`~/.jarvis/briefings/today-focus/<YYYY-MM-DD>.md\` covering:
 *   - Recommended next move (single opinionated sentence)
 *   - Today's calendar
 *   - PRs/Slack/Linear waiting on the user
 *   - Reminders firing in next 24h
 *   - Open items from yesterday
 *   - Heads-up (failed routines, slow PRs, …)
 *
 * It ALSO writes a tight inbox item to
 * \`~/.jarvis/inbox/today-focus.json\` carrying the recommended next
 * move as the title — so the user sees Jarvis's opinion in the
 * Inbox directly, not just buried in the Briefings tab. The
 * smart-inbox curator picks this up alongside everything else.
 *
 * The notify step at the end fires a macOS notification + fans out
 * to Telegram bot + Web Push so the user knows the brief is ready
 * even with Jarvis backgrounded.
 *
 * Default `enabled: true` — first weekday morning after install,
 * the user wakes up to a brief in their Inbox with no manual setup.
 * If it's too noisy, disable in Settings → Workflows.
 */
export const MORNING_BRIEF_WORKFLOW: WorkflowDef = {
  id: 'morning-brief-loop',
  name: 'Morning brief',
  description:
    'Every weekday at 08:15, the today-focus skill generates a forward-looking brief (calendar + waiting-on-me + reminders + heads-up) with a recommended next move. Lands in the Briefings tab AND as a top-priority inbox item. Notification fires when ready.',
  enabled: true,
  trigger: { kind: 'cron', every: '15 8 * * 1-5' },
  pipeline: [
    {
      type: 'run-skill',
      params: {
        skillId: 'today-focus',
        prompt:
          'Generate today\'s focus per your system prompt. Write the markdown file AND the inbox item. Output the one-line confirmation only.',
      },
    },
    {
      type: 'notify',
      params: {
        title: 'Morning brief ready',
        body: 'Open the Inbox for today\'s recommended next move + waiting items.',
        source: 'inbox-new',
      },
    },
  ],
};
