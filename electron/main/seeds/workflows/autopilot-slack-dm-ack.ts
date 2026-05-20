import type { WorkflowDef } from '@shared/types';

/**
 * Autopilot scenario — draft short replies to unread, recent Slack
 * DMs / @-mentions.
 *
 *   trigger:  autopilot · cron 5m (gated by appMode === 'autopilot')
 *   pipeline: mcp-call(search.messages is:unread)
 *             → transform (filter bots + recency)
 *             → run-skill (slack-dm-ack returns JSON array)
 *             → batch-prompt-output (table HUD, per-row Accept/Reject)
 *
 * Filter logic:
 *   - Slack search modifier `is:unread` does the unread gate
 *     server-side. No need for conversations.history scopes.
 *   - `bot_id` or `subtype: 'bot_message'` filters out the GitHub
 *     Slack bot + any other app-emitted notifications (those are PR
 *     signals; the PR-review scenario handles them via gh polling).
 *   - 30-minute recency window (RECENT_MS) keeps the workflow from
 *     pinging the user about stale messages.
 *
 * The pipeline ENDS at batch-prompt-output by design. Accept saves
 * the draft as positive feedback to the per-workflow memory file —
 * the message is NOT posted. The user reads + sends manually (or
 * appends a `mcp-call slack send_message` step that fans the
 * accepted rows out, if they want to flip this scenario to auto-
 * send later).
 *
 * Default `enabled: false`.
 */

const RECENT_MS = 30 * 60 * 1000;

const FILTER_FN = `(() => {
  const matches = (typeof $ === 'object' && $ && Array.isArray($.messages?.matches)) ? $.messages.matches : [];
  const cutoff = Date.now() - ${RECENT_MS};
  return matches.filter(m => {
    if (!m || !m.ts || !m.channel?.id) return false;
    // Bot senders go to the PR flows (which poll GitHub directly);
    // we don't reply to them as if they were teammates.
    if (m.bot_id || m.subtype === 'bot_message') return false;
    const username = String(m.username || '').toLowerCase();
    if (/^(github|github-bot|githubapp)$/.test(username)) return false;
    // Recency gate. Slack's is:unread already filters most stale
    // items, but a long-forgotten unread thread could still match;
    // 30 min keeps things current.
    const seconds = parseFloat(m.ts);
    const ts = Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
    if (ts < cutoff) return false;
    return true;
  }).slice(0, 10).map(m => {
    const who = m.username || m.user || 'someone';
    const chan = m.channel.name ? '#' + m.channel.name : String(m.channel.id);
    const text = (m.text || '').trim();
    return {
      id: 'slack-' + m.channel.id + '-' + m.ts,
      from: who,
      channel: chan,
      message: text,
      url: m.permalink || null,
      ts: m.ts,
    };
  });
})()`;

const AGENT_PROMPT = `You're given an array of unread Slack messages. For each one, draft a brief acknowledgement reply.

For each input row, produce one output row with the same id and these fields:
  - id: same as input
  - from: same as input
  - channel: same as input
  - message: same as input (so the user sees what's being responded to)
  - draft: 1-2 sentences, peer-to-peer tone. No greeting, no signoff. Output the literal string "(skip)" if the message is hostile, automated, or needs context you don't have.

Input messages:
\`\`\`json
{prev}
\`\`\`

Past feedback the user has given you on this scenario:
{feedback}

Output ONLY a JSON array. No prose around it, no markdown code fences. Example:
[{"id":"slack-CXXX-1.2","from":"luca","channel":"#migrations","message":"redis PR look ok?","draft":"on it, EOD"}]`;

const ROWS_FN = `(Array.isArray($) ? $ : []).filter(r => r && r.id && r.draft && r.draft !== '(skip)').map(r => ({
  id: r.id,
  preview: [
    { label: 'From', value: String(r.from || '?') },
    { label: 'In',   value: String(r.channel || '?') },
    { label: 'Said', value: String(r.message || '').slice(0, 200) },
  ],
  draft: String(r.draft),
}))`;

export const AUTOPILOT_SLACK_DM_ACK_WORKFLOW: WorkflowDef = {
  id: 'autopilot-slack-dm-ack',
  name: 'Autopilot · Ack Slack DMs',
  description:
    'Every 5 min in autopilot mode, poll Slack for unread, recent DMs + @-mentions and draft short acknowledgement replies. Reviewed as a table; never auto-sent.',
  enabled: false,
  trigger: { kind: 'autopilot', when: 'cron', every: '5m' },
  pipeline: [
    {
      type: 'mcp-call',
      params: {
        mcp: 'slack',
        tool: 'search_messages',
        args: {
          query: '(to:me OR is:mention) is:unread -from:me',
          count: 30,
        },
        parse: 'json',
      },
    },
    {
      // mcp-call returns an array (one element per text content
      // block) when parse:'json'. Unwrap to the first block then
      // run the recency + bot filter.
      type: 'transform',
      params: {
        fn: `(Array.isArray($) ? $[0] : $)`,
      },
    },
    {
      type: 'transform',
      params: { fn: FILTER_FN },
    },
    {
      type: 'run-skill',
      params: {
        skillId: 'slack-dm-ack',
        prompt: AGENT_PROMPT,
        // The skill returns a JSON string — the next node parses it.
      },
    },
    {
      type: 'transform',
      params: {
        fn: `(() => { try { return JSON.parse(typeof $ === 'string' ? $ : '[]'); } catch { return []; } })()`,
      },
    },
    {
      type: 'batch-prompt-output',
      params: {
        title: 'Ack unread Slack messages',
        summary:
          'Autopilot drafted acknowledgements for your unread messages. Accept = positive feedback (no message is sent). Reject + note teaches the agent for next time.',
        rowsFn: ROWS_FN,
        onEmpty: 'skip',
      },
    },
  ],
};
