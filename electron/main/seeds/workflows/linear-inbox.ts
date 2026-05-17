import type { WorkflowDef } from '@shared/types';

/**
 * Example workflow — Sync Linear issues into the Inbox.
 *
 *   trigger:  every 5 min
 *   pipeline: http-fetch → transform → inbox-write
 *
 * Auth: reads `LINEAR_API_TOKEN` from the `linear` MCP entry in
 * `~/.jarvis/mcp.json`. Falls back to `LINEAR_API_KEY` for community
 * server variants — the http-fetch node checks both via its auth.var
 * (only one wins; if you use a different var name, set it here).
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
    'Every 5 minutes, fetch issues assigned to you from Linear and surface them in the Inbox.',
  enabled: true,
  trigger: { kind: 'cron', every: '5m' },
  pipeline: [
    {
      type: 'http-fetch',
      params: {
        url: 'https://api.linear.app/graphql',
        method: 'POST',
        auth: { mcp: 'linear', var: 'LINEAR_API_TOKEN' },
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
