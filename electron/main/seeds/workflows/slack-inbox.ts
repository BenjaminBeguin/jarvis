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

// noise-v5: rolls back the hardcoded in:#jarvis default — turns out
// "Jarvis" is the user's sidebar SECTION (grouping pinned channels),
// not a channel name, and Slack's public API doesn't expose section
// memberships. The default query stays narrow (DMs + mentions); users
// who want channel-wide tracking add "OR in:#their-channel" branches
// by editing ~/.jarvis/workflows/slack-inbox-sync.json directly. See
// the query body's inline comment for the syntax.
const SLACK_TRANSFORM = `((() => {
  const MAX_AGE_MS = 14 * 86400000;
  const now = Date.now();
  return ($.messages?.matches ?? []).filter(m => {
    if (!m || !m.ts || !m.channel || !m.channel.id) return false;
    // Drop bot senders: github / github-bot are not actionable.
    if (m.bot_id || m.subtype === 'bot_message') return false;
    if (/^(github|github-bot|githubapp)$/i.test(String(m.username || ''))) return false;
    // Drop messages older than the cap.
    const seconds = parseFloat(m.ts);
    if (!Number.isFinite(seconds)) return false;
    const ts = Math.round(seconds * 1000);
    if (now - ts > MAX_AGE_MS) return false;
    return true;
  }).map(m => {
    const ts = Math.round(parseFloat(m.ts) * 1000);
    const text = (m.text || '').trim().replace(/\\s+/g, ' ');
    const title80 = text.length > 80 ? text.slice(0, 79) + '…' : text;
    const who = m.username || m.user || 'someone';
    const diff = now - ts;
    let age;
    if (diff < 60000) age = 'just now';
    else if (diff < 3600000) age = Math.floor(diff / 60000) + 'm';
    else if (diff < 86400000) age = Math.floor(diff / 3600000) + 'h';
    else age = Math.floor(diff / 86400000) + 'd';
    const chan = m.channel.name ? '#' + m.channel.name : m.channel.id;
    return {
      id: 'slack-' + m.channel.id + '-' + m.ts,
      source: 'slack',
      title: who + ': ' + title80,
      subtitle: chan + ' · ' + age,
      ...(m.permalink ? { url: m.permalink } : {}),
      createdAt: ts,
    };
  }).slice(0, 20);
})())`;

export const SLACK_INBOX_WORKFLOW: WorkflowDef = {
  id: 'slack-inbox-sync',
  name: 'Sync Slack inbox',
  description:
    'Every 15 minutes during your working hours, fetch DMs + @mentions of you from Slack. To also track whole channels, edit the search query in the workflow JSON and append "OR in:#channel-name" per channel. Requires a user token (xoxp-*).',
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
          // Default branches:
          //   - to:me        → DMs to you
          //   - mentions:me  → messages explicitly @'ing you anywhere
          //
          // To also track entire channels (e.g. the ones you've
          // grouped under a sidebar section like "Jarvis"), edit
          // this query and append OR-branches per channel:
          //   '(to:me OR mentions:me OR in:#team-foo OR in:#bar) -from:me'
          // Slack's public API doesn't expose sidebar sections, so
          // listing them by hand is the practical workaround.
          query: '(to:me OR mentions:me) -from:me',
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
