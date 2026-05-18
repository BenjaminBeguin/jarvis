import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { SendAs, SlackTokenPayload } from '../slack.js';

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

export interface SlackMcpHooks {
  /** Fresh token payload (or null if disconnected). */
  getPayload(): Promise<SlackTokenPayload | null>;
  /** Latest sendAs preference — read on every call so flipping the
   *  toggle in Settings → Integrations takes effect on the next tool
   *  invocation. */
  getSendAs(): SendAs;
}

/**
 * In-process MCP server for one Slack workspace. Posts use the bot
 * token by default; flipping `sendAs` to `'user'` from Settings →
 * Integrations switches `send_message` to post as the installer.
 * Read-side tools (search, list, threads) always use the user token
 * because the user has broader visibility (DMs, private channels)
 * than the bot.
 */
export function buildSlackMcp(
  accountId: string,
  hooks: SlackMcpHooks,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: `slack-${accountId}`,
    version: '0.1.0',
    tools: [
      tool(
        'list_channels',
        'List Slack channels visible to the bot. Defaults to public channels (Slack scope channels:read). To include private channels, add groups:read to the Slack app + the connector\'s BOT_SCOPES.',
        {
          types: z
            .enum(['public_channel', 'private_channel', 'mpim', 'im'])
            .optional(),
          limit: z.number().int().min(1).max(200).optional(),
          excludeArchived: z.boolean().optional(),
        },
        async (args) =>
          callSlack(hooks, 'bot', async (token) => {
            const url = new URL(
              'https://slack.com/api/conversations.list',
            );
            // Default to public-only — opting into private/mpim/im
            // requires extra Slack scopes the connector doesn't ask
            // for by default. Agent can override if the user added
            // the right scopes manually.
            url.searchParams.set(
              'types',
              args.types ?? 'public_channel',
            );
            url.searchParams.set('limit', String(args.limit ?? 100));
            url.searchParams.set(
              'exclude_archived',
              String(args.excludeArchived ?? true),
            );
            const data = await get(url, token);
            if (!data.ok) return err(slackError(data));
            const channels =
              (data['channels'] as Array<Record<string, unknown>>) ?? [];
            return json(
              channels.map((c) => ({
                id: c['id'],
                name: c['name'],
                is_private: c['is_private'],
                is_member: c['is_member'],
                is_im: c['is_im'],
                user: c['user'],
              })),
            );
          }),
      ),
      tool(
        'list_users',
        'List workspace members. Returns id, name, real_name, email (where granted), is_bot.',
        { limit: z.number().int().min(1).max(200).optional() },
        async (args) =>
          callSlack(hooks, 'bot', async (token) => {
            const url = new URL('https://slack.com/api/users.list');
            url.searchParams.set('limit', String(args.limit ?? 200));
            const data = await get(url, token);
            if (!data.ok) return err(slackError(data));
            const members =
              (data['members'] as Array<Record<string, unknown>>) ?? [];
            return json(
              members
                .filter((m) => !m['deleted'])
                .map((m) => ({
                  id: m['id'],
                  name: m['name'],
                  real_name: m['real_name'],
                  email: (m['profile'] as Record<string, unknown> | undefined)
                    ?.['email'],
                  is_bot: m['is_bot'],
                })),
            );
          }),
      ),
      tool(
        'find_user_by_email',
        'Look up a Slack user by email. Returns the full user record if found, error otherwise.',
        { email: z.string().email() },
        async (args) =>
          callSlack(hooks, 'bot', async (token) => {
            const url = new URL(
              'https://slack.com/api/users.lookupByEmail',
            );
            url.searchParams.set('email', args.email);
            const data = await get(url, token);
            if (!data.ok) return err(slackError(data));
            return json(data['user']);
          }),
      ),
      tool(
        'send_message',
        'Post a message to a channel, DM, or thread. `channel` is a channel id (Cxxxx for channels, Dxxxx for DMs) — call list_channels / find_user_by_email first if you only have a name. `threadTs` to reply in a thread. Picks bot or user token based on the per-account sendAs preference.',
        {
          channel: z.string().min(1),
          text: z.string().min(1),
          threadTs: z.string().optional(),
          unfurlLinks: z.boolean().optional(),
        },
        async (args) => {
          const sendAs = hooks.getSendAs();
          return callSlack(hooks, sendAs, async (token) => {
            const body: Record<string, unknown> = {
              channel: args.channel,
              text: args.text,
            };
            if (args.threadTs) body['thread_ts'] = args.threadTs;
            if (args.unfurlLinks !== undefined) {
              body['unfurl_links'] = args.unfurlLinks;
            }
            const res = await fetch(
              'https://slack.com/api/chat.postMessage',
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json; charset=utf-8',
                },
                body: JSON.stringify(body),
              },
            );
            const data = (await res.json()) as Record<string, unknown>;
            if (!data['ok']) return err(slackError(data));
            return ok(
              `posted as ${sendAs} · channel ${args.channel} · ts ${data['ts']}`,
            );
          });
        },
      ),
      tool(
        'search_messages',
        'Search Slack messages with Slack search syntax (e.g. `from:@alice in:#general after:2026-04-01`). Always uses the user token (search is user-scoped only).',
        {
          query: z.string().min(1),
          count: z.number().int().min(1).max(100).optional(),
        },
        async (args) =>
          callSlack(hooks, 'user', async (token) => {
            const url = new URL('https://slack.com/api/search.messages');
            url.searchParams.set('query', args.query);
            url.searchParams.set('count', String(args.count ?? 20));
            const data = await get(url, token);
            if (!data.ok) return err(slackError(data));
            return json(data['messages']);
          }),
      ),
      // get_thread (conversations.replies) needs channels:history /
      // groups:history / im:history scopes the default scope set
      // doesn't ask for. If you need it, add the right history scope
      // to your Slack app + the connector and re-add the tool here.
    ],
  });
}

async function get(url: URL, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (await res.json()) as Record<string, unknown>;
}

function slackError(data: Record<string, unknown>): string {
  const err = String(data['error'] ?? 'unknown');
  const meta = data['response_metadata'];
  if (meta && typeof meta === 'object') {
    return `${err} ${JSON.stringify(meta)}`;
  }
  return err;
}

async function callSlack(
  hooks: SlackMcpHooks,
  which: SendAs,
  fn: (token: string) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const payload = await hooks.getPayload();
  if (!payload) {
    return err(
      'No Slack tokens for this workspace. Reconnect from Settings → Integrations.',
    );
  }
  const token =
    which === 'bot' ? payload.botAccessToken : payload.userAccessToken;
  if (!token) {
    return err(
      `Missing ${which} token for this workspace. The OAuth flow may have skipped that scope set — reconnect to refresh.`,
    );
  }
  try {
    return await fn(token);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
