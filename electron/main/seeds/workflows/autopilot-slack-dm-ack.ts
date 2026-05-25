import type { WorkflowDef } from '@shared/types';

/**
 * Autopilot scenario — triage unread, recent Slack DMs / @-mentions
 * and produce drafts ready to send from the Drafts tab.
 *
 *   trigger:  autopilot · cron 5m (gated by appMode === 'autopilot')
 *   pipeline: mcp-call(search.messages is:unread)
 *             → transform (unwrap text block)
 *             → transform (filter bots + recency, project for skill)
 *             → run-skill (slack-dm-ack returns Draft-shaped JSON)
 *             → transform (parse JSON)
 *             → draft-store-write (writes to ai_drafts table)
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
 * The skill emits each row with an `mcp` sendAction targeting Slack's
 * `send_message` tool (channel + threadTs baked in, body substituted
 * at send time). Send from the Drafts view dispatches via the slack
 * MCP — no manual mcp-call step needed in this pipeline.
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
    const chanLabel = m.channel.name ? '#' + m.channel.name : String(m.channel.id);
    const text = (m.text || '').trim();
    return {
      sourceItemId: 'slack-' + m.channel.id + '-' + m.ts,
      from: who,
      channelLabel: chanLabel,
      channelId: m.channel.id,
      message: text,
      url: m.permalink || null,
      threadTs: m.ts,
    };
  });
})()`;

const AGENT_PROMPT = `You're given an array of unread Slack messages. Draft a brief acknowledgement reply for each one. Output a JSON array shaped for the \`draft-store-write\` workflow node — see the skill's system prompt for the full schema. Rows you'd skip (hostile, automated, needs context you don't have) should be omitted from the output entirely.

Input messages:
\`\`\`json
{prev}
\`\`\`

Past feedback the user has given you on this scenario:
{feedback}

Output ONLY a JSON array of draft objects. No prose, no markdown fences.`;

const PARSE_FN = `(() => {
  try {
    const text = typeof $ === 'string' ? $ : '';
    const m = text.match(/\\\`\\\`\\\`(?:json)?\\s*([\\s\\S]*?)\\s*\\\`\\\`\\\`/);
    const json = m ? m[1] : text.trim();
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
})()`;

export const AUTOPILOT_SLACK_DM_ACK_WORKFLOW: WorkflowDef = {
  id: 'autopilot-slack-dm-ack',
  name: 'Autopilot · Triage Slack DMs',
  description:
    'Every 5 min in autopilot mode, poll Slack for unread DMs + @-mentions and produce drafts in the Drafts tab. Edit inline, refine via prompt, send with one click.',
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
      params: { fn: PARSE_FN },
    },
    {
      type: 'draft-store-write',
      params: { source: 'slack-triage' },
    },
  ],
};
