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

const NOTION_VERSION = '2022-06-28';
const API = 'https://api.notion.com/v1';

/**
 * In-process Notion MCP for one workspace. Tools mirror the most-used
 * REST endpoints. Pagination is single-page (first 100); chained calls
 * can keep paging via the `start_cursor` arg where supported.
 */
export function buildNotionMcp(
  accountId: string,
  getAccessToken: () => Promise<string | null>,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: `notion-${accountId}`,
    version: '0.1.0',
    tools: [
      tool(
        'search',
        'Search pages + databases in the workspace by title. Filter by object type ("page" or "database") if useful.',
        {
          query: z.string().optional(),
          filterType: z.enum(['page', 'database']).optional(),
          pageSize: z.number().int().min(1).max(100).optional(),
          startCursor: z.string().optional(),
        },
        async (args) =>
          callNotion(getAccessToken, async (token) => {
            const body: Record<string, unknown> = {
              page_size: args.pageSize ?? 25,
            };
            if (args.query) body['query'] = args.query;
            if (args.filterType) {
              body['filter'] = { value: args.filterType, property: 'object' };
            }
            if (args.startCursor) body['start_cursor'] = args.startCursor;
            const res = await fetch(`${API}/search`, {
              method: 'POST',
              headers: notionHeaders(token),
              body: JSON.stringify(body),
            });
            return notionResult(res, (data) =>
              json({
                results: ((data['results'] as unknown[]) ?? []).map(slimSearchHit),
                next_cursor: data['next_cursor'],
                has_more: data['has_more'],
              }),
            );
          }),
      ),
      tool(
        'get_page',
        'Read a page: properties + child blocks (rich text). Pass the page id from search.',
        {
          pageId: z.string().min(1),
          includeBlocks: z.boolean().optional(),
        },
        async (args) =>
          callNotion(getAccessToken, async (token) => {
            const meta = await fetch(
              `${API}/pages/${encodeURIComponent(args.pageId)}`,
              { headers: notionHeaders(token) },
            );
            if (!meta.ok) {
              return err(`page fetch failed (${meta.status}): ${await meta.text()}`);
            }
            const page = (await meta.json()) as Record<string, unknown>;
            if (args.includeBlocks === false) return json(page);
            const blocks = await fetchBlocks(token, args.pageId, 100);
            return json({ page, blocks });
          }),
      ),
      tool(
        'query_database',
        'Query a Notion database (filter + sort, Notion JSON spec). Returns the matching pages.',
        {
          databaseId: z.string().min(1),
          filter: z.record(z.string(), z.unknown()).optional(),
          sorts: z.array(z.record(z.string(), z.unknown())).optional(),
          pageSize: z.number().int().min(1).max(100).optional(),
          startCursor: z.string().optional(),
        },
        async (args) =>
          callNotion(getAccessToken, async (token) => {
            const body: Record<string, unknown> = {
              page_size: args.pageSize ?? 25,
            };
            if (args.filter) body['filter'] = args.filter;
            if (args.sorts) body['sorts'] = args.sorts;
            if (args.startCursor) body['start_cursor'] = args.startCursor;
            const res = await fetch(
              `${API}/databases/${encodeURIComponent(args.databaseId)}/query`,
              {
                method: 'POST',
                headers: notionHeaders(token),
                body: JSON.stringify(body),
              },
            );
            return notionResult(res, (data) => json(data));
          }),
      ),
      tool(
        'get_database',
        'Read a database schema (properties + types). Useful before query_database so the filter shape is correct.',
        { databaseId: z.string().min(1) },
        async (args) =>
          callNotion(getAccessToken, async (token) => {
            const res = await fetch(
              `${API}/databases/${encodeURIComponent(args.databaseId)}`,
              { headers: notionHeaders(token) },
            );
            return notionResult(res, (data) => json(data));
          }),
      ),
      tool(
        'create_page',
        'Create a page. `parent` is either { database_id } (row in a database) or { page_id } (sub-page). `properties` follows the parent\'s schema; `children` is an optional list of block objects to add as the page body.',
        {
          parent: z.record(z.string(), z.unknown()),
          properties: z.record(z.string(), z.unknown()),
          children: z.array(z.record(z.string(), z.unknown())).optional(),
          icon: z.record(z.string(), z.unknown()).optional(),
          cover: z.record(z.string(), z.unknown()).optional(),
        },
        async (args) =>
          callNotion(getAccessToken, async (token) => {
            const res = await fetch(`${API}/pages`, {
              method: 'POST',
              headers: notionHeaders(token),
              body: JSON.stringify({
                parent: args.parent,
                properties: args.properties,
                ...(args.children ? { children: args.children } : {}),
                ...(args.icon ? { icon: args.icon } : {}),
                ...(args.cover ? { cover: args.cover } : {}),
              }),
            });
            return notionResult(res, (data) =>
              ok(
                `page created · id ${String(data['id'])} · url ${String(data['url'] ?? '')}`,
              ),
            );
          }),
      ),
      tool(
        'update_page_properties',
        'Patch page properties or archive/unarchive. `properties` only includes the keys you want to change.',
        {
          pageId: z.string().min(1),
          properties: z.record(z.string(), z.unknown()).optional(),
          archived: z.boolean().optional(),
          icon: z.record(z.string(), z.unknown()).optional(),
        },
        async (args) =>
          callNotion(getAccessToken, async (token) => {
            const body: Record<string, unknown> = {};
            if (args.properties) body['properties'] = args.properties;
            if (args.archived !== undefined) body['archived'] = args.archived;
            if (args.icon) body['icon'] = args.icon;
            const res = await fetch(
              `${API}/pages/${encodeURIComponent(args.pageId)}`,
              {
                method: 'PATCH',
                headers: notionHeaders(token),
                body: JSON.stringify(body),
              },
            );
            return notionResult(res, () => ok(`page ${args.pageId} updated`));
          }),
      ),
      tool(
        'append_blocks',
        'Append blocks to a page or block. `children` is a list of block objects (paragraph / heading / bulleted_list_item / …).',
        {
          blockId: z.string().min(1),
          children: z.array(z.record(z.string(), z.unknown())),
        },
        async (args) =>
          callNotion(getAccessToken, async (token) => {
            const res = await fetch(
              `${API}/blocks/${encodeURIComponent(args.blockId)}/children`,
              {
                method: 'PATCH',
                headers: notionHeaders(token),
                body: JSON.stringify({ children: args.children }),
              },
            );
            return notionResult(res, () =>
              ok(`${args.children.length} block(s) appended to ${args.blockId}`),
            );
          }),
      ),
    ],
  });
}

function notionHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function notionResult(
  res: Response,
  ok: (data: Record<string, unknown>) => CallToolResult,
): Promise<CallToolResult> {
  if (!res.ok) {
    return err(`Notion API ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  return ok(data);
}

async function fetchBlocks(
  token: string,
  blockId: string,
  pageSize: number,
): Promise<unknown[]> {
  const res = await fetch(
    `${API}/blocks/${encodeURIComponent(blockId)}/children?page_size=${pageSize}`,
    { headers: notionHeaders(token) },
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { results?: unknown[] };
  return data.results ?? [];
}

function slimSearchHit(hit: unknown): Record<string, unknown> {
  if (!hit || typeof hit !== 'object') return {};
  const h = hit as Record<string, unknown>;
  return {
    id: h['id'],
    object: h['object'],
    url: h['url'],
    parent: h['parent'],
    properties: h['properties'],
    title: extractTitle(h),
    last_edited_time: h['last_edited_time'],
  };
}

function extractTitle(hit: Record<string, unknown>): string | null {
  // `title` lives in different shapes for pages vs databases. Try both.
  const props = hit['properties'] as Record<string, unknown> | undefined;
  if (props) {
    for (const v of Object.values(props)) {
      const prop = v as { type?: string; title?: Array<{ plain_text?: string }> };
      if (prop?.type === 'title' && Array.isArray(prop.title)) {
        return prop.title.map((t) => t.plain_text ?? '').join('') || null;
      }
    }
  }
  const direct = hit['title'];
  if (Array.isArray(direct)) {
    return (direct as Array<{ plain_text?: string }>)
      .map((t) => t.plain_text ?? '')
      .join('') || null;
  }
  return null;
}

async function callNotion(
  getAccessToken: () => Promise<string | null>,
  fn: (token: string) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const token = await getAccessToken();
  if (!token) {
    return err(
      'No Notion token for this workspace. Reconnect from Settings → Integrations.',
    );
  }
  try {
    return await fn(token);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
