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

/**
 * Build an in-process MCP server exposing Gmail tools for one Google
 * account. The factory pattern means each connected account gets its
 * own MCP entry (`gmail-ben@hive.app`, `gmail-personal@gmail.com`),
 * keyed by name in the resolved mcpServers map passed to the SDK.
 *
 * `getAccessToken` is invoked on every tool call so token rotations
 * (from the 5-min refresher) take effect immediately — no need to
 * rebuild the MCP instance.
 */
export function buildGmailMcp(
  accountId: string,
  getAccessToken: () => Promise<string | null>,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: `gmail-${accountId}`,
    version: '0.1.0',
    tools: [
      tool(
        'list_messages',
        `List recent messages from ${accountId}'s Gmail. Supports Gmail's standard search syntax: "from:alice", "is:unread", "subject:RFC", "after:2025/01/01". Returns id + thread id + snippet for each match.`,
        {
          query: z.string().optional(),
          maxResults: z.number().int().min(1).max(50).optional(),
          labelIds: z.array(z.string()).optional(),
        },
        async (args) =>
          callGmail(getAccessToken, async (token) => {
            const url = new URL(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages`,
            );
            if (args.query) url.searchParams.set('q', args.query);
            url.searchParams.set(
              'maxResults',
              String(args.maxResults ?? 20),
            );
            for (const id of args.labelIds ?? []) {
              url.searchParams.append('labelIds', id);
            }
            const res = await fetch(url, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) return err(await res.text());
            const data = (await res.json()) as {
              messages?: Array<{ id: string; threadId: string }>;
              nextPageToken?: string;
              resultSizeEstimate?: number;
            };
            // Inflate each id into a metadata-only summary so the
            // agent gets snippet + from/subject without paying for
            // every body up front.
            const messages = data.messages ?? [];
            const summaries = await Promise.all(
              messages.map((m) =>
                fetchSummary(token, m.id).catch(() => ({
                  id: m.id,
                  error: 'fetch_failed',
                })),
              ),
            );
            return json({
              messages: summaries,
              resultSizeEstimate: data.resultSizeEstimate,
            });
          }),
      ),
      tool(
        'get_message',
        'Read one Gmail message in full — headers (from, to, subject, date) plus the plain-text body. Pass the message id from list_messages.',
        { id: z.string().min(1) },
        async (args) =>
          callGmail(getAccessToken, async (token) => {
            const res = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(args.id)}?format=full`,
              { headers: { Authorization: `Bearer ${token}` } },
            );
            if (!res.ok) return err(await res.text());
            const data = (await res.json()) as GmailMessage;
            return json({
              id: data.id,
              threadId: data.threadId,
              labelIds: data.labelIds,
              snippet: data.snippet,
              headers: pickHeaders(data),
              body: extractBody(data),
            });
          }),
      ),
      tool(
        'send_message',
        `Send an email from ${accountId}. RFC 5322 fields. CC and BCC optional. Plain text body only — no HTML yet.`,
        {
          to: z.string().min(3),
          subject: z.string(),
          body: z.string(),
          cc: z.string().optional(),
          bcc: z.string().optional(),
        },
        async (args) =>
          callGmail(getAccessToken, async (token) => {
            const raw = buildRawEmail({
              from: accountId,
              to: args.to,
              cc: args.cc,
              bcc: args.bcc,
              subject: args.subject,
              body: args.body,
            });
            const res = await fetch(
              'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ raw }),
              },
            );
            if (!res.ok) return err(await res.text());
            const data = (await res.json()) as {
              id: string;
              threadId: string;
            };
            return ok(
              `sent · message id ${data.id} · thread ${data.threadId}`,
            );
          }),
      ),
      tool(
        'list_labels',
        'List Gmail labels (system + user-defined). Useful before list_messages with labelIds.',
        {},
        async () =>
          callGmail(getAccessToken, async (token) => {
            const res = await fetch(
              'https://gmail.googleapis.com/gmail/v1/users/me/labels',
              { headers: { Authorization: `Bearer ${token}` } },
            );
            if (!res.ok) return err(await res.text());
            const data = (await res.json()) as {
              labels?: Array<{ id: string; name: string; type: string }>;
            };
            return json(data.labels ?? []);
          }),
      ),
      tool(
        'modify_labels',
        'Add and/or remove labels on a message. Common patterns: archive = remove INBOX; mark read = remove UNREAD; star = add STARRED.',
        {
          id: z.string().min(1),
          addLabelIds: z.array(z.string()).optional(),
          removeLabelIds: z.array(z.string()).optional(),
        },
        async (args) =>
          callGmail(getAccessToken, async (token) => {
            const res = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(args.id)}/modify`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  addLabelIds: args.addLabelIds ?? [],
                  removeLabelIds: args.removeLabelIds ?? [],
                }),
              },
            );
            if (!res.ok) return err(await res.text());
            return ok(`labels updated on ${args.id}`);
          }),
      ),
    ],
  });
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPart;
}

interface GmailPart {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

async function fetchSummary(
  token: string,
  messageId: string,
): Promise<unknown> {
  const url = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
  );
  url.searchParams.set('format', 'metadata');
  for (const h of ['From', 'To', 'Subject', 'Date']) {
    url.searchParams.append('metadataHeaders', h);
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as GmailMessage;
  return {
    id: data.id,
    threadId: data.threadId,
    labelIds: data.labelIds,
    snippet: data.snippet,
    headers: pickHeaders(data),
  };
}

function pickHeaders(msg: GmailMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of msg.payload?.headers ?? []) {
    if (
      h.name === 'From' ||
      h.name === 'To' ||
      h.name === 'Subject' ||
      h.name === 'Date' ||
      h.name === 'Cc'
    ) {
      out[h.name.toLowerCase()] = h.value;
    }
  }
  return out;
}

function extractBody(msg: GmailMessage): string {
  // Prefer text/plain. Walk parts depth-first; fall back to the first
  // base64-decoded blob we find.
  const stack: GmailPart[] = msg.payload ? [msg.payload] : [];
  let fallback = '';
  while (stack.length > 0) {
    const p = stack.pop()!;
    if (p.parts) {
      // DFS into children.
      for (let i = p.parts.length - 1; i >= 0; i--) stack.push(p.parts[i]!);
      continue;
    }
    if (!p.body?.data) continue;
    const decoded = decodeBase64Url(p.body.data);
    if (p.mimeType === 'text/plain') return decoded;
    if (!fallback) fallback = decoded;
  }
  return fallback;
}

function decodeBase64Url(s: string): string {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
    'utf8',
  );
}

function buildRawEmail(args: {
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
}): string {
  const headers: string[] = [
    `From: ${args.from}`,
    `To: ${args.to}`,
  ];
  if (args.cc) headers.push(`Cc: ${args.cc}`);
  if (args.bcc) headers.push(`Bcc: ${args.bcc}`);
  headers.push(`Subject: ${args.subject}`);
  headers.push('Content-Type: text/plain; charset=UTF-8');
  headers.push('MIME-Version: 1.0');
  const message = `${headers.join('\r\n')}\r\n\r\n${args.body}`;
  return Buffer.from(message, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function callGmail(
  getAccessToken: () => Promise<string | null>,
  fn: (token: string) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const token = await getAccessToken();
  if (!token) {
    return err(
      'No valid Google access token. Reconnect this account from Settings → Integrations.',
    );
  }
  try {
    return await fn(token);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
