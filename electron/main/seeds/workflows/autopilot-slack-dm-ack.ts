import type { WorkflowDef } from '@shared/types';

/**
 * Autopilot scenario — draft an acknowledgement when someone DMs
 * you (or @-mentions you) on Slack.
 *
 *   trigger:  autopilot · on slack inbox  (event-driven; no cron)
 *   pipeline: transform (validate) → run-skill → prompt-output
 *
 * The InboxEventBridge dispatches this workflow whenever a new
 * `source: 'slack'` InboxItem lands. The matched item arrives as
 * `prev`. The agent reads the message + thread context and drafts a
 * brief reply ("on it · EOD", "noted · will look tomorrow", etc).
 *
 * The pipeline ENDS with prompt-output by design — NEVER auto-posts
 * to a human teammate. The user approves (or edits + approves) the
 * draft in the HUD. To make the workflow send on accept, append a
 * `mcp-call slack chat.postMessage` step after the prompt; that
 * remains an explicit per-scenario opt-in.
 *
 * Rejections + freeform feedback append to the per-workflow
 * feedback file; the agent's tone calibrates over time.
 *
 * Default `enabled: false`.
 */

const VALIDATE_FN = `(() => {
  // InboxEventBridge seeds prev as { kind: 'inbox-changed', item }.
  // Unwrap and validate it's a slack DM/mention from the last 5min.
  if (!$ || !$.item) return null;
  const item = $.item;
  if (item.source !== 'slack') return null;
  const age = Date.now() - (item.createdAt || 0);
  if (age > 5 * 60_000) return null; // stale
  return {
    title: item.title || '',
    subtitle: item.subtitle || '',
    url: item.url,
    threadPreview: item.body || item.subtitle || item.title,
  };
})()`;

const AGENT_PROMPT = `Draft a short Slack reply acknowledging this message. Tone: terse, peer-to-peer, no formal greeting. Aim for 1-2 sentences max.

Incoming message context:
{prev}

Past feedback the user has given you for this scenario (match this tone):
{feedback}

Output ONLY the reply text. No quotes, no markdown, no "Reply:" prefix.`;

export const AUTOPILOT_SLACK_DM_ACK_WORKFLOW: WorkflowDef = {
  id: 'autopilot-slack-dm-ack',
  name: 'Autopilot · Ack Slack DMs',
  description:
    'When a Slack DM or mention lands in your inbox and you\'re in autopilot mode, draft a short acknowledgement reply. Always asks before posting — never auto-sends to a teammate.',
  enabled: false,
  trigger: {
    kind: 'autopilot',
    when: 'inbox-changed',
    sources: ['slack'],
    minIntervalMs: 60_000,
  },
  pipeline: [
    {
      type: 'transform',
      params: { fn: VALIDATE_FN },
    },
    {
      type: 'run-skill',
      params: { skillId: 'slack-dm-ack', prompt: AGENT_PROMPT },
    },
    {
      type: 'prompt-output',
      params: {
        title: 'Save this Slack reply draft?',
        summary:
          'Autopilot drafted an acknowledgement. Accept saves it as positive feedback (no message is sent — the workflow ends at the draft).',
        // {seed.item.title} = the channel/sender line ("#migrations · @luca").
        // {seed.item.subtitle} = age + meta. Together they give the user
        // enough to decide whether the draft fits.
        context: '{seed.item.title}\n\n{seed.item.subtitle}',
        onAccept: 'feedback',
      },
    },
  ],
};
