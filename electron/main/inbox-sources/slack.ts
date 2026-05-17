import type { InboxItem } from '@shared/types';

import type { InboxSource } from '../inbox.js';
import type { McpConfigStore } from '../mcp-config.js';

/**
 * Direct-JS Slack inbox source. Replaces the cron-fired `slack-inbox`
 * skill that was ~$0.30 per fire × 96/day.
 *
 * Slack's Web API capabilities differ by token type:
 *
 *   - **`xoxp-*`** (user OAuth token): `search.messages` works → we
 *     can query for unread mentions, DMs after a date, etc. This is
 *     the "full inbox" path.
 *   - **`xoxb-*`** (bot token): no `search.messages`. Degraded path
 *     — we can only walk channels the bot is in + scan recent history
 *     for explicit mentions of the user's id. We log a one-time INFO
 *     so the user knows they'd get a better inbox with a user token.
 *
 * Token comes from `~/.jarvis/mcp.json` → `slack` server's
 * `SLACK_BOT_TOKEN` env. Yes, the variable name says "bot" — the
 * upstream MCP server accepts user tokens there too. We detect the
 * actual type from the `xoxp-` / `xoxb-` prefix.
 *
 * 30s in-memory cache, capped at 40 items, same pattern as Linear.
 */

const CACHE_TTL_MS = 30_000;
const MAX_ITEMS = 40;
/** Look-back window for both search.messages (xoxp) and channel
 *  history scans (xoxb). 48 hours is long enough to catch "weekend"
 *  threads but short enough that history scans stay fast. */
const LOOKBACK_HOURS = 48;

type SlackTokenKind = 'user' | 'bot';

interface SlackAuthTestRes {
  ok: boolean;
  user?: string;
  user_id?: string;
  team_id?: string;
}

interface SlackSearchMessage {
  iid?: string;
  channel: { id: string; name?: string };
  ts: string;
  text?: string;
  user?: string;
  username?: string;
  permalink?: string;
}

interface SlackSearchRes {
  ok: boolean;
  messages?: {
    matches: SlackSearchMessage[];
  };
}

interface SlackHistoryMessage {
  type: string;
  ts: string;
  user?: string;
  text?: string;
  subtype?: string;
}

interface SlackChannelsListRes {
  ok: boolean;
  channels?: Array<{
    id: string;
    name?: string;
    is_member?: boolean;
    is_im?: boolean;
    is_archived?: boolean;
  }>;
}

interface SlackHistoryRes {
  ok: boolean;
  messages?: SlackHistoryMessage[];
}

let cached: { at: number; items: InboxItem[] } | null = null;
let loggedMissingToken = false;
let loggedTokenKind: SlackTokenKind | null = null;
let loggedFailure = 0;

function tokenFromMcp(mcp: McpConfigStore): string | null {
  const resolved = mcp.resolve(['slack']);
  const slack = resolved['slack'];
  if (!slack || slack.type !== 'stdio') return null;
  return slack.env?.['SLACK_BOT_TOKEN'] ?? null;
}

function kindOf(token: string): SlackTokenKind {
  return token.startsWith('xoxp-') ? 'user' : 'bot';
}

async function slackCall<T>(
  token: string,
  method: string,
  params: Record<string, string> = {},
): Promise<T> {
  const body = new URLSearchParams(params);
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Bearer ${token}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`Slack ${method} HTTP ${res.status}`);
  return (await res.json()) as T;
}

function tsToMs(ts: string): number {
  // Slack timestamps are "1700000000.123456" — seconds.fraction.
  const seconds = parseFloat(ts);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : Date.now();
}

function clipTitle(s: string, n = 80): string {
  const trimmed = (s ?? '').trim().replace(/\s+/g, ' ');
  return trimmed.length > n ? `${trimmed.slice(0, n - 1)}…` : trimmed;
}

function ageLabel(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

/**
 * User-token path: search.messages handles the heavy lifting. Query
 * "to:me after:<48h ago>" surfaces both DMs to the user and any
 * @mention in channels the user is in.
 */
async function fetchViaSearch(
  token: string,
  viewerId: string,
): Promise<InboxItem[]> {
  const afterDate = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const query = `to:<@${viewerId}> after:${afterDate}`;
  const res = await slackCall<SlackSearchRes>(token, 'search.messages', {
    query,
    count: '40',
    sort: 'timestamp',
    sort_dir: 'desc',
  });
  if (!res.ok || !res.messages) return [];
  const items: InboxItem[] = [];
  for (const m of res.messages.matches) {
    // Skip the user's own messages (just-in-case — the query should
    // already exclude them).
    if (m.user === viewerId) continue;
    const ts = tsToMs(m.ts);
    items.push({
      id: `slack-${m.channel.id}-${m.ts}`,
      source: 'slack',
      title: `${m.username ?? m.user ?? 'someone'}: ${clipTitle(m.text ?? '')}`,
      subtitle: `#${m.channel.name ?? m.channel.id} · ${ageLabel(ts)}`,
      ...(m.permalink ? { url: m.permalink } : {}),
      createdAt: ts,
    });
  }
  return items.slice(0, MAX_ITEMS);
}

/**
 * Bot-token degraded path: list channels the bot is in, scan recent
 * history for explicit `<@USERID>` mentions of the user. No DM
 * coverage (bots don't see user DMs unless they're a participant).
 */
async function fetchViaHistory(
  token: string,
  viewerId: string,
): Promise<InboxItem[]> {
  const channelsRes = await slackCall<SlackChannelsListRes>(
    token,
    'conversations.list',
    {
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: '50',
    },
  );
  if (!channelsRes.ok || !channelsRes.channels) return [];
  const oldest = String(
    Math.floor((Date.now() - LOOKBACK_HOURS * 3600 * 1000) / 1000),
  );
  const mentionTag = `<@${viewerId}>`;
  const items: InboxItem[] = [];
  // Cap channel scans so we don't pound the API on workspaces with
  // hundreds of channels. The bot probably isn't a member of most.
  for (const channel of channelsRes.channels) {
    if (channel.is_archived) continue;
    if (!channel.id) continue;
    if (items.length >= MAX_ITEMS) break;
    try {
      const hist = await slackCall<SlackHistoryRes>(
        token,
        'conversations.history',
        { channel: channel.id, oldest, limit: '50' },
      );
      if (!hist.ok || !hist.messages) continue;
      for (const m of hist.messages) {
        if (m.type !== 'message' || m.subtype) continue;
        if (m.user === viewerId) continue;
        if (!m.text?.includes(mentionTag)) continue;
        const ts = tsToMs(m.ts);
        items.push({
          id: `slack-${channel.id}-${m.ts}`,
          source: 'slack',
          title: `${m.user ?? 'someone'}: ${clipTitle(m.text)}`,
          subtitle: `#${channel.name ?? channel.id} · ${ageLabel(ts)}`,
          createdAt: ts,
        });
        if (items.length >= MAX_ITEMS) break;
      }
    } catch {
      // Channel access denied / rate-limited — skip and continue.
    }
  }
  return items;
}

export function slackInboxSource(mcp: McpConfigStore): InboxSource {
  return {
    name: 'slack',
    label: 'Slack · waiting on you',
    async fetch(): Promise<InboxItem[]> {
      const token = tokenFromMcp(mcp);
      if (!token) {
        if (!loggedMissingToken) {
          console.info(
            '[inbox/slack] no SLACK_BOT_TOKEN in ~/.jarvis/mcp.json — Slack inbox disabled',
          );
          loggedMissingToken = true;
        }
        return [];
      }
      if (loggedMissingToken) loggedMissingToken = false;

      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        return cached.items;
      }

      const kind = kindOf(token);
      if (loggedTokenKind !== kind) {
        if (kind === 'bot') {
          console.info(
            '[inbox/slack] using a bot token — search.messages unavailable. Inbox limited to channel @mentions; DMs not visible. A user token (xoxp-*) gives the full inbox.',
          );
        } else {
          console.info('[inbox/slack] using a user token — full search path');
        }
        loggedTokenKind = kind;
      }

      try {
        const auth = await slackCall<SlackAuthTestRes>(token, 'auth.test');
        if (!auth.ok || !auth.user_id) {
          throw new Error('auth.test returned no user_id');
        }
        const items =
          kind === 'user'
            ? await fetchViaSearch(token, auth.user_id)
            : await fetchViaHistory(token, auth.user_id);
        cached = { at: Date.now(), items };
        return items;
      } catch (err) {
        const now = Date.now();
        if (now - loggedFailure > 5 * 60_000) {
          loggedFailure = now;
          console.warn('[inbox/slack] fetch failed:', err);
        }
        return cached?.items ?? [];
      }
    },
  };
}
