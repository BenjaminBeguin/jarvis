import type { InboxItem } from '@shared/types';

import type { InboxSource } from '../inbox.js';
import type { McpConfigStore } from '../mcp-config.js';
import type { ProjectStore } from '../projects.js';

/**
 * Direct-JS Linear inbox source. Pulls issues assigned to the viewer
 * and still open (state.type not in completed/canceled), one GraphQL
 * round-trip per refresh, no agent.
 *
 * Replaces the cron-fired `linear-inbox` skill that was costing ~$0.30
 * per fire × 96/day. The skill's broader rules (mentions, blocked-on-me,
 * past-due across the team) are intentionally deferred — the "assigned
 * + open" filter is ~80% of the value at 0% of the cost. We can layer
 * more queries in a v1.5 once this proves out.
 *
 * Token: read from `~/.jarvis/mcp.json` env var on the 'linear' MCP
 * entry. Tries LINEAR_API_TOKEN first, then LINEAR_API_KEY (different
 * community MCP servers use different names). No token → fetch returns
 * [] and logs one INFO note.
 *
 * Caching: a 30s in-memory dedupe so a manual refresh immediately
 * followed by the auto-refresh tick doesn't double-call the API.
 * Same pattern as gh.ts.
 */

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  url: string;
  updatedAt: string;
  dueDate: string | null;
  priority: number; // 0=none, 1=urgent, 2=high, 3=medium, 4=low
  state: { name: string; type: string };
  team: { key: string; name: string };
  project: { name: string } | null;
}

interface LinearViewerData {
  viewer: { id: string };
  issues: { nodes: LinearIssueNode[] };
}

const ENDPOINT = 'https://api.linear.app/graphql';
const CACHE_TTL_MS = 30_000;
const MAX_ITEMS = 40;

const QUERY = `
query JarvisInbox {
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
}
`;

let cached: { at: number; items: InboxItem[] } | null = null;
let loggedMissingToken = false;
let loggedFailure = 0;

function tokenFromMcp(mcp: McpConfigStore): string | null {
  const resolved = mcp.resolve(['linear']);
  const linear = resolved['linear'];
  if (!linear || linear.type !== 'stdio') return null;
  const env = linear.env;
  if (!env) return null;
  // Most community servers use LINEAR_API_TOKEN; some examples use
  // LINEAR_API_KEY. Try both before giving up.
  return env['LINEAR_API_TOKEN'] ?? env['LINEAR_API_KEY'] ?? null;
}

function priorityChip(p: number): string | null {
  switch (p) {
    case 1:
      return 'Urgent';
    case 2:
      return 'High';
    default:
      return null;
  }
}

function nodeToItem(
  node: LinearIssueNode,
  projects: ProjectStore,
): InboxItem {
  const subtitleBits = [node.state.name, node.team.key];
  const prio = priorityChip(node.priority);
  if (prio) subtitleBits.push(prio);
  // Map to a tracked Jarvis project when the Linear project / team
  // name has an unambiguous alias match. Skip otherwise — false matches
  // would lie to the scope filter.
  const projectMatch =
    (node.project?.name && projects.resolve(node.project.name)) ||
    projects.resolve(node.team.name) ||
    projects.resolve(node.team.key);
  return {
    id: `linear-${node.id}`,
    source: 'linear',
    title: `${node.identifier} · ${node.title}`,
    subtitle: subtitleBits.join(' · '),
    url: node.url,
    createdAt: new Date(node.updatedAt).getTime(),
    ...(node.dueDate
      ? { fireAt: new Date(node.dueDate).getTime() }
      : {}),
    ...(projectMatch ? { project: projectMatch.name } : {}),
  };
}

export function linearInboxSource(
  mcp: McpConfigStore,
  projects: ProjectStore,
): InboxSource {
  return {
    name: 'linear',
    label: 'Linear · needs you',
    async fetch(): Promise<InboxItem[]> {
      const token = tokenFromMcp(mcp);
      if (!token) {
        if (!loggedMissingToken) {
          console.info(
            '[inbox/linear] no LINEAR_API_TOKEN in ~/.jarvis/mcp.json — Linear inbox disabled',
          );
          loggedMissingToken = true;
        }
        return [];
      }
      // Reset the "missing token" log if the token came back.
      if (loggedMissingToken) loggedMissingToken = false;

      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        return cached.items;
      }

      try {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: token,
          },
          body: JSON.stringify({ query: QUERY }),
        });
        if (!res.ok) {
          throw new Error(`Linear API ${res.status}`);
        }
        const json = (await res.json()) as
          | { data: LinearViewerData; errors?: unknown }
          | { data?: undefined; errors: unknown };
        if (!json.data) {
          throw new Error(
            `Linear API returned errors: ${JSON.stringify(json.errors)}`,
          );
        }
        const items = json.data.issues.nodes
          .slice(0, MAX_ITEMS)
          .map((n) => nodeToItem(n, projects));
        cached = { at: Date.now(), items };
        return items;
      } catch (err) {
        // Don't flood logs if a token is bad or the API is down — at
        // most one log every 5 min. Returning [] keeps the inbox tab
        // working rather than failing the whole refresh.
        const now = Date.now();
        if (now - loggedFailure > 5 * 60_000) {
          loggedFailure = now;
          console.warn('[inbox/linear] fetch failed:', err);
        }
        return cached?.items ?? [];
      }
    },
  };
}
