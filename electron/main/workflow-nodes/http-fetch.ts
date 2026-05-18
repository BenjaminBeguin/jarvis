import { fromPromise } from 'xstate';

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
 *     auth?: {
 *       mcp: 'linear' | 'slack' | ...;
 *       var: 'LINEAR_API_TOKEN' | ...;
 *       scheme?: 'raw' | 'bearer'  // default 'raw' (Linear-style)
 *     }
 *       Reads a token from ~/.jarvis/mcp.json env on the named server.
 *       'raw' → `Authorization: <token>` (Linear style).
 *       'bearer' → `Authorization: Bearer <token>` (Slack, most others).
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

interface HttpFetchParams {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  auth?: { mcp: string; var: string; scheme?: 'raw' | 'bearer' };
  body?: unknown;
  bodyEncoding?: 'json' | 'form';
  responseType?: 'json' | 'text';
  validate?: string;
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
