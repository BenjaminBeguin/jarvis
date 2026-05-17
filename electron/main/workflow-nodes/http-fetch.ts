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
 *     auth?: { mcp: 'linear' | 'slack' | ...; var: 'LINEAR_API_TOKEN' | ... }
 *       Reads a token from ~/.jarvis/mcp.json env on the named server.
 *       Sent as `Authorization: <token>` (Linear style — no `Bearer`
 *       prefix). For `Bearer <token>` use `headers` directly instead.
 *     body?: string | object
 *       Object → JSON.stringify + Content-Type: application/json.
 *     responseType?: 'json' | 'text'  // default 'json'
 *   }
 *
 * Output: parsed JSON body (responseType:'json') or raw text.
 */

interface HttpFetchParams {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  auth?: { mcp: string; var: string };
  body?: unknown;
  responseType?: 'json' | 'text';
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
    headers['Authorization'] = token;
  }

  let body: BodyInit | undefined;
  if (params.body !== undefined && params.body !== null) {
    if (typeof params.body === 'string') {
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
  return responseType === 'text' ? await res.text() : await res.json();
});
