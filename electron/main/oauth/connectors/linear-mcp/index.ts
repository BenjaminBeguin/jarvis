import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

interface CallToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const ok = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
});
const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});
const err = (msg: string): CallToolResult => ({
  content: [{ type: 'text', text: `error: ${msg}` }],
  isError: true,
});

const GRAPHQL = 'https://api.linear.app/graphql';

/**
 * In-process Linear MCP for one user. Linear is GraphQL-only, so
 * each tool wraps a specific query / mutation. The set is
 * deliberately small — list, get, create, update, comment — and
 * agents chain them. `team` and `assignee` accept either ids or
 * keys/emails so prompts like "assign to alice" can succeed without
 * an explicit lookup first.
 */
export function buildLinearMcp(
  accountId: string,
  getAccessToken: () => Promise<string | null>,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: `linear-${accountId}`,
    version: '0.1.0',
    tools: [
      tool(
        'list_teams',
        'List teams in the workspace. Returns id, key, name.',
        {},
        async () =>
          callLinear(getAccessToken, async (token) => {
            const data = await gql(
              token,
              `query { teams { nodes { id key name } } }`,
            );
            return json(extract(data, 'teams', 'nodes', []));
          }),
      ),
      tool(
        'list_users',
        'List workspace members. Returns id, name, email.',
        { active: z.boolean().optional() },
        async (args) =>
          callLinear(getAccessToken, async (token) => {
            const filter = args.active === false ? '' : '(filter: { active: { eq: true } })';
            const data = await gql(
              token,
              `query { users${filter} { nodes { id name email } } }`,
            );
            return json(extract(data, 'users', 'nodes', []));
          }),
      ),
      tool(
        'list_issues',
        'Search issues with structured filters. Returns id, identifier (TEAM-123), title, state, priority, assignee, team, createdAt, updatedAt. Empty filter returns all issues (newest first).',
        {
          teamId: z.string().optional(),
          assigneeId: z.string().optional(),
          stateName: z.string().optional(),
          searchText: z.string().optional(),
          first: z.number().int().min(1).max(100).optional(),
        },
        async (args) =>
          callLinear(getAccessToken, async (token) => {
            const filterParts: string[] = [];
            if (args.teamId) filterParts.push(`team: { id: { eq: "${args.teamId}" } }`);
            if (args.assigneeId) filterParts.push(`assignee: { id: { eq: "${args.assigneeId}" } }`);
            if (args.stateName) {
              filterParts.push(
                `state: { name: { eqIgnoreCase: "${args.stateName.replace(/"/g, '\\"')}" } }`,
              );
            }
            if (args.searchText) {
              filterParts.push(`title: { containsIgnoreCase: "${args.searchText.replace(/"/g, '\\"')}" }`);
            }
            const filterStr =
              filterParts.length > 0 ? `, filter: { ${filterParts.join(', ')} }` : '';
            const first = args.first ?? 25;
            const query = `query {
              issues(first: ${first}${filterStr}, orderBy: updatedAt) {
                nodes {
                  id identifier title priority createdAt updatedAt url
                  state { name type }
                  assignee { id name email }
                  team { id key name }
                }
              }
            }`;
            const data = await gql(token, query);
            return json(extract(data, 'issues', 'nodes', []));
          }),
      ),
      tool(
        'get_issue',
        'Read a single issue by id or identifier (e.g. "ENG-123"). Returns full body + last 20 comments.',
        { idOrIdentifier: z.string().min(1) },
        async (args) =>
          callLinear(getAccessToken, async (token) => {
            const q = `query Q($id: String!) {
              issue(id: $id) {
                id identifier title description priority createdAt updatedAt url
                state { name type } assignee { id name email } team { id key name }
                comments(last: 20) { nodes { id body createdAt user { id name } } }
              }
            }`;
            const data = await gql(token, q, { id: args.idOrIdentifier });
            const issue =
              (data['data'] as Record<string, unknown> | undefined)?.['issue'] ?? null;
            return json(issue);
          }),
      ),
      tool(
        'create_issue',
        'Create a new issue. `teamId` required; `title` required. Optional: description, assigneeId, priority (0-4 = no/urgent/high/normal/low), stateId.',
        {
          teamId: z.string().min(1),
          title: z.string().min(1),
          description: z.string().optional(),
          assigneeId: z.string().optional(),
          priority: z.number().int().min(0).max(4).optional(),
          stateId: z.string().optional(),
          labelIds: z.array(z.string()).optional(),
        },
        async (args) =>
          callLinear(getAccessToken, async (token) => {
            const q = `mutation M($input: IssueCreateInput!) {
              issueCreate(input: $input) {
                success
                issue { id identifier title url }
              }
            }`;
            const data = await gql(token, q, {
              input: {
                teamId: args.teamId,
                title: args.title,
                ...(args.description ? { description: args.description } : {}),
                ...(args.assigneeId ? { assigneeId: args.assigneeId } : {}),
                ...(args.priority !== undefined ? { priority: args.priority } : {}),
                ...(args.stateId ? { stateId: args.stateId } : {}),
                ...(args.labelIds?.length ? { labelIds: args.labelIds } : {}),
              },
            });
            const result = (data['data'] as Record<string, unknown> | undefined)?.[
              'issueCreate'
            ] as
              | { success?: boolean; issue?: { identifier: string; url: string } }
              | undefined;
            if (!result?.success || !result.issue) return err('issueCreate returned no issue');
            return ok(`created ${result.issue.identifier} · ${result.issue.url}`);
          }),
      ),
      tool(
        'update_issue',
        'Patch an existing issue. Only the keys you pass are updated.',
        {
          id: z.string().min(1),
          title: z.string().optional(),
          description: z.string().optional(),
          assigneeId: z.string().optional(),
          priority: z.number().int().min(0).max(4).optional(),
          stateId: z.string().optional(),
          labelIds: z.array(z.string()).optional(),
        },
        async (args) =>
          callLinear(getAccessToken, async (token) => {
            const input: Record<string, unknown> = {};
            if (args.title !== undefined) input['title'] = args.title;
            if (args.description !== undefined) input['description'] = args.description;
            if (args.assigneeId !== undefined) input['assigneeId'] = args.assigneeId;
            if (args.priority !== undefined) input['priority'] = args.priority;
            if (args.stateId !== undefined) input['stateId'] = args.stateId;
            if (args.labelIds !== undefined) input['labelIds'] = args.labelIds;
            const q = `mutation M($id: String!, $input: IssueUpdateInput!) {
              issueUpdate(id: $id, input: $input) { success issue { id identifier url } }
            }`;
            const data = await gql(token, q, { id: args.id, input });
            const result = (data['data'] as Record<string, unknown> | undefined)?.[
              'issueUpdate'
            ] as
              | { success?: boolean; issue?: { identifier: string } }
              | undefined;
            if (!result?.success) return err('issueUpdate returned no success');
            return ok(`updated ${result.issue?.identifier ?? args.id}`);
          }),
      ),
      tool(
        'add_comment',
        'Post a comment to an issue.',
        {
          issueId: z.string().min(1),
          body: z.string().min(1),
        },
        async (args) =>
          callLinear(getAccessToken, async (token) => {
            const q = `mutation M($input: CommentCreateInput!) {
              commentCreate(input: $input) {
                success
                comment { id url issue { identifier } }
              }
            }`;
            const data = await gql(token, q, {
              input: { issueId: args.issueId, body: args.body },
            });
            const result = (data['data'] as Record<string, unknown> | undefined)?.[
              'commentCreate'
            ] as
              | {
                  success?: boolean;
                  comment?: { id: string; url: string; issue?: { identifier?: string } };
                }
              | undefined;
            if (!result?.success || !result.comment) return err('commentCreate returned no comment');
            return ok(
              `comment posted on ${result.comment.issue?.identifier ?? args.issueId} · ${result.comment.url}`,
            );
          }),
      ),
    ],
  });
}

async function gql(
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Linear GraphQL ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  if (data['errors']) {
    throw new Error(`Linear GraphQL error: ${JSON.stringify(data['errors'])}`);
  }
  return data;
}

function extract<T>(
  data: Record<string, unknown>,
  topKey: string,
  innerKey: string,
  fallback: T,
): T {
  const top = (data['data'] as Record<string, unknown> | undefined)?.[topKey] as
    | Record<string, unknown>
    | undefined;
  return (top?.[innerKey] as T) ?? fallback;
}

async function callLinear(
  getAccessToken: () => Promise<string | null>,
  fn: (token: string) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const token = await getAccessToken();
  if (!token) {
    return err(
      'No Linear token. Reconnect from Settings → Integrations.',
    );
  }
  try {
    return await fn(token);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
