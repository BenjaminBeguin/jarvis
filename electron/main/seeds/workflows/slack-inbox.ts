import type { WorkflowDef } from '@shared/types';

/**
 * Slack inbox workflow.
 *
 *   trigger:  every 5 min
 *   pipeline: http-fetch (search.messages) → transform → inbox-write
 *
 * Auth: pulls the connected Slack workspace's user token (xoxp-*)
 * from Keychain via the OAuth integration. search.messages requires
 * the user token (Tier 2 + search:read scope) — bot tokens
 * (xoxb-*) get `ok:false: not_allowed_token_type`, which the
 * validate expression below surfaces as a workflow error.
 *
 * Query uses Slack's `to:me` and `is:mention` modifiers, evaluated
 * server-side against the calling user's id — no separate auth.test
 * round-trip needed.
 */

const SLACK_TRANSFORM = `(($.messages?.matches ?? []).filter(m => m && m.ts && m.channel && m.channel.id).map(m => {
  const seconds = parseFloat(m.ts);
  const ts = Number.isFinite(seconds) ? Math.round(seconds * 1000) : Date.now();
  const text = (m.text || '').trim().replace(/\\s+/g, ' ');
  const title80 = text.length > 80 ? text.slice(0, 79) + '…' : text;
  const who = m.username || m.user || 'someone';
  const diff = Date.now() - ts;
  let age;
  if (diff < 60000) age = 'just now';
  else if (diff < 3600000) age = Math.floor(diff / 60000) + 'm';
  else if (diff < 86400000) age = Math.floor(diff / 3600000) + 'h';
  else age = Math.floor(diff / 86400000) + 'd';
  const chan = m.channel.name ? '#' + m.channel.name : m.channel.id;
  // Bot detection: Slack sets bot_id / subtype:bot_message on app-
  // emitted messages. Also catch known bot usernames (github,
  // github-bot, etc.) as a belt-and-suspenders for installs where
  // bot_id isn't returned by search.messages.
  const isBot = !!m.bot_id || m.subtype === 'bot_message' ||
    /^(github|github-bot|githubapp)$/i.test(String(m.username || ''));
  return {
    id: 'slack-' + m.channel.id + '-' + m.ts,
    source: 'slack',
    title: who + ': ' + title80,
    subtitle: chan + ' · ' + age,
    ...(m.permalink ? { url: m.permalink } : {}),
    createdAt: ts,
    isBotSender: isBot,
  };
}).slice(0, 40))`;

export const SLACK_INBOX_WORKFLOW: WorkflowDef = {
  id: 'slack-inbox-sync',
  name: 'Sync Slack inbox',
  description:
    'Every 15 minutes during your working hours, fetch DMs + @mentions waiting on you from Slack. Requires a user token (xoxp-*).',
  enabled: true,
  // {businessHours} expands to "<start>-<end> * * <days>" from the
  // user's working-hours pref (Settings → general). Edit to a literal
  // 5-field cron or shorthand like '5m' to override per-workflow.
  trigger: { kind: 'cron', every: '*/15 {businessHours}' },
  pipeline: [
    {
      type: 'http-fetch',
      params: {
        url: 'https://slack.com/api/search.messages',
        method: 'POST',
        auth: { connector: 'slack', field: 'userAccessToken', scheme: 'bearer' },
        bodyEncoding: 'form',
        body: {
          query: '(to:me OR is:mention) -from:me',
          count: '40',
          sort: 'timestamp',
          sort_dir: 'desc',
        },
        // Slack returns 200 with `ok: false` on auth failures (e.g.
        // not_allowed_token_type when the configured token is xoxb- but
        // search.messages requires xoxp-). Surface that as a workflow
        // error instead of letting the transform run on a bad body and
        // silently writing 0 items to the inbox.
        validate:
          "$.ok === false ? ('Slack API: ' + ($.error || 'unknown failure')) : null",
      },
    },
    {
      type: 'transform',
      params: { fn: SLACK_TRANSFORM },
    },
    {
      type: 'inbox-write',
      params: { source: 'slack', label: 'Slack · waiting on you' },
    },
  ],
};
