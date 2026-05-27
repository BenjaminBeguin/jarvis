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

// noise-v6: aggressive closure-signal filter + thread dedupe +
// question-detection gate for non-DM channels. The pre-v6 transform
// was naively passing every message through, so threads where the
// user was actively participating (or chats that ended with
// "thanks!") flooded the inbox. v6 drops:
//   - closure/ack messages (thanks, perfect, lgtm, emoji-only, …)
//   - <!channel> / <!here> / <!everyone> broadcasts
//   - bots (github, linear, datadog, pagerduty, *-bot, …)
//   - non-DM messages that don't look like a question/request
//   - all-but-the-latest message per thread (so a 4-message thread
//     surfaces ONE inbox row, not four)
// noise-v5: rolled back the hardcoded in:#jarvis default; the
// default query is DMs + mentions only — users add OR-branches for
// tracked channels manually.
const SLACK_TRANSFORM = `((() => {
  const MAX_AGE_MS = 14 * 86400000;
  const now = Date.now();

  // --- Closure-signal filter ------------------------------------
  // Messages whose body looks like an acknowledgement or sign-off
  // should never make it into the inbox. The user didn't "miss"
  // these — they're conversation-end markers.
  const CLOSURE_PATTERNS = [
    /^(thanks?( you)?|thx|ty|cool|great|perfect|awesome|nice|good)\\W*$/i,
    /^(got it|gotcha|ok(ay)?|k|sounds good|makes sense|noted|ack)\\W*$/i,
    /^(\\+1|yes|yep|yup|sure|right|exactly|agreed|lgtm|ship it)\\W*$/i,
    /^(have a good( one)?|ttyl|speak soon|happy (friday|monday|weekend))/i,
    /^(opened pr|deployed|merged|build (passed|failed)|added to canvas)/i,
    /^(actually,? nevermind|ignore my last|resolved|fixed it myself)/i,
    /^(no worries|np|all good|sorry,?)\\W*$/i,
    /^(anytime|you're welcome|yw|of course)\\W*[!.:]?$/i,
  ];
  const isClosure = (text) => {
    const t = (text || '').trim();
    if (!t) return true; // empty body = nothing to answer
    // Strip leading mentions/emoji codes for the check ("<@U123> thanks!")
    const stripped = t
      .replace(/<@[A-Z0-9]+(\\|[^>]+)?>/g, '')
      .replace(/:[a-z0-9_+-]+:/g, '')
      .replace(/\\s+/g, ' ')
      .trim();
    if (!stripped) return true; // emoji-only / mention-only
    // Very short blurbs after stripping decoration are almost
    // always closures.
    if (stripped.length < 4) return true;
    return CLOSURE_PATTERNS.some(rx => rx.test(stripped));
  };

  // --- Broadcast filter -----------------------------------------
  // <!channel> / <!here> / <!everyone> are mass pings, not personal.
  const isBroadcast = (text) =>
    /<!(channel|here|everyone)>/i.test(text || '');

  // --- Question detector ----------------------------------------
  // Whether the body LOOKS like a question or request directed at
  // the recipient. Used to gate non-DM threads.
  const looksLikeQuestion = (text) => {
    const t = (text || '').trim();
    if (!t) return false;
    if (/\\?\\s*$/.test(t)) return true;
    if (/\\b(can you|could you|would you|do you|will you|any update|any chance|please|pls|wdyt|thoughts|what about|how about|when can|when will)\\b/i.test(t)) return true;
    return false;
  };

  const raw = $.messages?.matches ?? [];
  let droppedClosures = 0;
  let droppedBroadcasts = 0;
  let droppedOld = 0;
  let droppedBots = 0;

  const surviving = raw.filter(m => {
    if (!m || !m.ts || !m.channel || !m.channel.id) return false;
    // Drop bots — github, linear, datadog, pagerduty, generic *-bot.
    if (m.bot_id || m.subtype === 'bot_message') { droppedBots++; return false; }
    const name = String(m.username || m.user || '');
    if (/^(github|github-bot|githubapp|linear|datadog|pagerduty|sentry|jenkins|circleci|googlecalendar)/i.test(name)) {
      droppedBots++; return false;
    }
    if (/-bot$/i.test(name)) { droppedBots++; return false; }
    // Age cap.
    const seconds = parseFloat(m.ts);
    if (!Number.isFinite(seconds)) return false;
    const ts = Math.round(seconds * 1000);
    if (now - ts > MAX_AGE_MS) { droppedOld++; return false; }
    // Closure / broadcast / empty.
    const text = m.text || '';
    if (isClosure(text)) { droppedClosures++; return false; }
    if (isBroadcast(text)) { droppedBroadcasts++; return false; }
    return true;
  });

  // --- Dedupe by thread -----------------------------------------
  // If 4 messages from the same thread match, keep only the latest.
  // search.messages returns thread_ts on replies; root messages
  // use their own ts.
  const byThread = new Map();
  for (const m of surviving) {
    const threadKey = m.channel.id + ':' + (m.thread_ts || m.ts);
    const existing = byThread.get(threadKey);
    if (!existing || parseFloat(m.ts) > parseFloat(existing.ts)) {
      byThread.set(threadKey, m);
    }
  }

  // --- Final pass: in channels (not DMs), require a question-shape
  // body. The user's slack ID isn't easily available in this
  // sandbox; we use the channel kind as a proxy. DMs (channel id
  // starts with 'D') always survive; other channels need a question.
  const items = [];
  let droppedNotQuestion = 0;
  for (const m of byThread.values()) {
    const isDm = String(m.channel.id || '').startsWith('D');
    if (!isDm && !looksLikeQuestion(m.text)) {
      droppedNotQuestion++;
      continue;
    }
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
    items.push({
      id: 'slack-' + m.channel.id + '-' + (m.thread_ts || m.ts),
      source: 'slack',
      title: who + ': ' + title80,
      subtitle: chan + ' · ' + age,
      ...(m.permalink ? { url: m.permalink } : {}),
      createdAt: ts,
    });
  }

  return items.sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
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
