import type { WorkflowDef } from '@shared/types';

/**
 * Example workflow — Sync Linear issues into the Inbox.
 *
 *   trigger:  every 5 min
 *   pipeline: http-fetch → transform → inbox-write
 *
 * Auth: pulls the connected Linear account's token from Keychain via
 * the OAuth integration ({ connector: 'linear', scheme: 'auto' }).
 * 'auto' picks the right Authorization-header format — `Bearer
 * <token>` for OAuth grants, raw token for personal API keys
 * (Linear rejects `Bearer lin_api_…`). Connect Linear from Settings
 * → Integrations; the default account is used unless you pin one
 * with auth.accountId.
 *
 * Filter (V1): issues assigned to me, state.type not in
 * completed/canceled, sorted by updatedAt, capped at 40. Same shape
 * the retired direct-JS source produced; output goes into the same
 * `linear` Inbox bucket so the UI is unchanged.
 *
 * This is the first reference workflow — a working example of the
 * `fetch → transform → write` pattern. Other inbox sources (Slack,
 * Calendar) follow once the engine proves out.
 */

const LINEAR_QUERY = `query JarvisInbox {
  viewer { id }
  issues(
    filter: {
      assignee: { isMe: { eq: true } }
      state: { type: { nin: ["completed", "canceled"] } }
    }
    first: 40
    orderBy: updatedAt
  ) {
    nodes {
      id
      identifier
      title
      url
      updatedAt
      dueDate
      priority
      state { name type }
      team { key name }
      project { name }
    }
  }
}`;

// JS expression evaluated by the `transform` node. `$` is the
// http-fetch response. Returns InboxItem[] ready for inbox-write.
const LINEAR_TRANSFORM = `(($.data?.issues?.nodes ?? []).map(n => {
  const subtitleBits = [n.state?.name, n.team?.key].filter(Boolean);
  if (n.priority === 1) subtitleBits.push('Urgent');
  else if (n.priority === 2) subtitleBits.push('High');
  return {
    id: 'linear-' + n.id,
    source: 'linear',
    title: n.identifier + ' · ' + n.title,
    subtitle: subtitleBits.join(' · '),
    url: n.url,
    createdAt: new Date(n.updatedAt).getTime(),
    ...(n.dueDate ? { fireAt: new Date(n.dueDate).getTime() } : {}),
  };
}))`;

export const LINEAR_INBOX_WORKFLOW: WorkflowDef = {
  id: 'linear-inbox-sync',
  name: 'Sync Linear inbox',
  description:
    'Every 15 minutes during your working hours, fetch issues assigned to you from Linear and surface them in the Inbox.',
  enabled: true,
  // {businessHours} expands from the user's working-hours pref. Edit
  // to '5m' for 24/7, or any 5-field cron expression for finer control.
  trigger: { kind: 'cron', every: '*/15 {businessHours}' },
  pipeline: [
    {
      type: 'http-fetch',
      params: {
        url: 'https://api.linear.app/graphql',
        method: 'POST',
        auth: { connector: 'linear', scheme: 'auto' },
        body: { query: LINEAR_QUERY },
      },
    },
    {
      type: 'transform',
      params: { fn: LINEAR_TRANSFORM },
    },
    {
      type: 'inbox-write',
      params: { source: 'linear', label: 'Linear · needs you' },
    },
  ],
};
