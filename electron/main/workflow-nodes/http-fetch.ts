import { fromPromise } from 'xstate';

import { getConnectorToken } from '../secrets.js';
import type { NodeHandlerInput } from './types.js';

/**
 * HTTP fetch node. The most common building block — every external
 * API source is one of these.
 *
 * Params:
 *   {
 *     url: string
 *     method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'  // default GET
 *     headers?: Record<string, string>
 *
 *     auth?:
 *       // Stdio MCP form — reads a token from ~/.jarvis/mcp.json env.
 *       | { mcp: 'github' | ...; var: 'GITHUB_TOKEN' | ...;
 *           scheme?: 'raw' | 'bearer' }
 *       // OAuth connector form — reads a token from Keychain via the
 *       // connected account. Defaults to the connector's default
 *       // account; pass accountId to target a specific one.
 *       | { connector: 'linear' | 'slack' | 'google' | 'notion' | 'github';
 *           accountId?: string;
 *           field?: 'accessToken' | 'userAccessToken' | 'botAccessToken' | ...;
 *           scheme?: 'raw' | 'bearer' | 'auto' }
 *
 *       For the mcp form: 'raw' → `Authorization: <token>` (Linear personal
 *         keys); 'bearer' → `Authorization: Bearer <token>` (Slack stdio).
 *       For the connector form: 'auto' (default) picks 'raw' when the
 *         payload is a personal API key (Linear's authMode='apiKey'),
 *         otherwise 'bearer'. 'field' defaults to 'accessToken'; pick
 *         'userAccessToken' for Slack search.messages (needs xoxp-*) or
 *         'botAccessToken' for chat.postMessage (xoxb-*).
 *
 *     body?: string | object
 *       Encoded according to `bodyEncoding`.
 *     bodyEncoding?: 'json' | 'form'  // default 'json'
 *       'form' → URLSearchParams + Content-Type: application/x-www-form-urlencoded.
 *     responseType?: 'json' | 'text'  // default 'json'
 *     validate?: string
 *       JS expression run against `$` (the parsed response) AFTER the
 *       HTTP request returns 2xx. Catches APIs that return 200 with a
 *       `{ ok: false }` envelope (Slack, Notion, GitHub GraphQL, …).
 *       Convention:
 *         - return a string → throw that string as the error
 *         - return null/undefined/true → pass
 *         - return false → throw a generic message
 *       Example (Slack):
 *         "$.ok === false ? ($.error || 'Slack API failure') : null"
 *   }
 *
 * Output: parsed JSON body (responseType:'json') or raw text.
 */

type StdioAuth = { mcp: string; var: string; scheme?: 'raw' | 'bearer' };
type ConnectorAuth = {
  connector: string;
  accountId?: string;
  field?: string;
  scheme?: 'raw' | 'bearer' | 'auto';
};

interface HttpFetchParams {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  auth?: StdioAuth | ConnectorAuth;
  body?: unknown;
  bodyEncoding?: 'json' | 'form';
  responseType?: 'json' | 'text';
  validate?: string;
}

function isConnectorAuth(
  auth: StdioAuth | ConnectorAuth,
): auth is ConnectorAuth {
  return typeof (auth as ConnectorAuth).connector === 'string';
}

export const httpFetchNode = fromPromise<
  unknown,
  NodeHandlerInput<HttpFetchParams>
>(async ({ input, signal }) => {
  const { params, ctx } = input;
  if (!params.url || typeof params.url !== 'string') {
    throw new Error('http-fetch: params.url is required');
  }

  const headers: Record<string, string> = { ...(params.headers ?? {}) };

  if (params.auth) {
    if (isConnectorAuth(params.auth)) {
      headers['Authorization'] = await resolveConnectorAuth(
        params.auth,
        ctx.integrations,
      );
    } else {
      const resolved = ctx.mcp.resolve([params.auth.mcp]);
      const entry = resolved[params.auth.mcp];
      if (!entry || entry.type !== 'stdio') {
        throw new Error(
          `http-fetch: MCP server '${params.auth.mcp}' not found or not stdio`,
        );
      }
      const token = entry.env?.[params.auth.var];
      if (!token) {
        throw new Error(
          `http-fetch: token '${params.auth.var}' not set on MCP '${params.auth.mcp}'`,
        );
      }
      headers['Authorization'] =
        params.auth.scheme === 'bearer' ? `Bearer ${token}` : token;
    }
  }

  let body: BodyInit | undefined;
  if (params.body !== undefined && params.body !== null) {
    const encoding = params.bodyEncoding ?? 'json';
    if (encoding === 'form') {
      if (typeof params.body !== 'object') {
        throw new Error('http-fetch: form encoding requires a body object');
      }
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(params.body as Record<string, unknown>)) {
        form.set(k, typeof v === 'string' ? v : JSON.stringify(v));
      }
      body = form;
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    } else if (typeof params.body === 'string') {
      body = params.body;
    } else {
      body = JSON.stringify(params.body);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }
  }

  const res = await fetch(params.url, {
    method: params.method ?? 'GET',
    headers,
    body,
    signal,
  });
  if (!res.ok) {
    throw new Error(`http-fetch: ${params.method ?? 'GET'} ${params.url} → ${res.status}`);
  }
  const responseType = params.responseType ?? 'json';
  const parsed =
    responseType === 'text' ? await res.text() : await res.json();

  if (typeof params.validate === 'string' && params.validate.trim()) {
    let validator: (dollar: unknown) => unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      validator = new Function('$', `return (${params.validate})`) as (
        d: unknown,
      ) => unknown;
    } catch (err) {
      throw new Error(
        `http-fetch: failed to compile validate expression — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let result: unknown;
    try {
      result = validator(parsed);
    } catch (err) {
      throw new Error(
        `http-fetch: validate threw — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // String result → error message. False → generic message. Anything
    // truthy non-string (true / object / number) → pass.
    if (typeof result === 'string' && result.length > 0) {
      throw new Error(`http-fetch: ${result}`);
    }
    if (result === false) {
      throw new Error(
        'http-fetch: validate returned false (response failed the workflow\'s validate check)',
      );
    }
  }
  return parsed;
});

/**
 * Pull a token from the OAuth-managed Keychain payload for a
 * connected account. Picks the connector's default account when
 * accountId isn't pinned. Throws with an actionable message when
 * the account doesn't exist or has no token yet (e.g. user nuked it
 * from Settings → Integrations and forgot to reconnect).
 */
async function resolveConnectorAuth(
  auth: ConnectorAuth,
  integrations: WorkflowNodeContextLite['integrations'],
): Promise<string> {
  if (!integrations) {
    throw new Error(
      `http-fetch: auth.connector='${auth.connector}' but the workflow runner has no IntegrationsStore wired in`,
    );
  }
  const accountId =
    auth.accountId ?? integrations.defaultFor(auth.connector as never);
  if (!accountId) {
    throw new Error(
      `http-fetch: no connected account for '${auth.connector}'. Connect one from Settings → Integrations.`,
    );
  }
  const raw = await getConnectorToken(auth.connector, accountId);
  if (!raw) {
    throw new Error(
      `http-fetch: no Keychain token for ${auth.connector}/${accountId} — reconnect from Settings → Integrations.`,
    );
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(
      `http-fetch: token payload for ${auth.connector}/${accountId} is not JSON.`,
    );
  }
  const field = auth.field ?? 'accessToken';
  const token = payload[field];
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(
      `http-fetch: field '${field}' missing/empty on ${auth.connector}/${accountId} token. Try field: 'userAccessToken' (Slack) or check the payload shape.`,
    );
  }
  let scheme = auth.scheme ?? 'auto';
  if (scheme === 'auto') {
    // Linear personal API keys (authMode==='apiKey') must be sent raw —
    // Linear rejects 'Bearer lin_api_…'. Everything else defaults to
    // Bearer, which is correct for Google, Slack, Notion, and Linear
    // OAuth.
    scheme = payload['authMode'] === 'apiKey' ? 'raw' : 'bearer';
  }
  return scheme === 'bearer' ? `Bearer ${token}` : token;
}

/** Local helper type — imports the integrations field shape without
 *  pulling the full WorkflowNodeContext into the helper's signature
 *  (which would make the helper less reusable). */
type WorkflowNodeContextLite = {
  integrations: import('./types.js').WorkflowNodeContext['integrations'];
};
