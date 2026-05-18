import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

import type { ConnectorAccount } from '@shared/types';

import type { McpServerConfig } from '../../mcp-config.js';
import {
  getConnectorCredentials,
  getConnectorToken,
} from '../../secrets.js';
import { randomState } from '../pkce.js';
import type {
  Connector,
  ConnectorHooks,
  ConnectorTokenPayload,
  CredentialSpec,
  OAuthRequest,
} from '../types.js';
import { buildNotionMcp } from './notion-mcp/index.js';

/**
 * Notion OAuth connector. Public-integration model — confidential
 * client (client_id + client_secret), no PKCE. One token per
 * workspace, long-lived (`expiresAt: null`, no refresh).
 *
 * Account identity = `workspace_id`. The same Notion login can grant
 * to multiple workspaces; each shows up as its own row.
 */

const FALLBACK_CLIENT_ID = 'REPLACE_ME_NOTION_CLIENT_ID';
const FALLBACK_CLIENT_SECRET = 'REPLACE_ME_NOTION_CLIENT_SECRET';
/**
 * Notion's special-case loopback: their console requires the redirect
 * URI to either be HTTPS or one of the literal forms
 * `http://localhost` / `http://localhost:<port>`. Bare `http://127.0.0.1`
 * is rejected at registration. We bind the HTTP server to 127.0.0.1
 * (rest of the connectors send 127.0.0.1 in their redirect) — on
 * macOS `localhost` resolves there via /etc/hosts so the callback
 * still lands on Jarvis's local server.
 */
const REDIRECT_URI = 'http://localhost:4747/oauth/callback/notion';

interface ResolvedCreds {
  clientId: string;
  clientSecret: string;
}

async function resolveCreds(): Promise<ResolvedCreds | null> {
  const stored = await getConnectorCredentials('notion');
  const clientId = stored?.clientId ?? FALLBACK_CLIENT_ID;
  const clientSecret = stored?.clientSecret ?? FALLBACK_CLIENT_SECRET;
  if (!clientId || clientId.startsWith('REPLACE_ME')) return null;
  if (!clientSecret || clientSecret.startsWith('REPLACE_ME')) return null;
  return { clientId, clientSecret };
}
const AUTH_URL = 'https://api.notion.com/v1/oauth/authorize';
const TOKEN_URL = 'https://api.notion.com/v1/oauth/token';

export interface NotionTokenPayload extends ConnectorTokenPayload {
  accessToken: string;
  workspaceId: string;
  workspaceName: string;
  workspaceIcon: string | null;
  botId: string;
  ownerUserId: string | null;
  ownerEmail: string | null;
}

class NotionConnector implements Connector {
  readonly id = 'notion' as const;
  readonly name = 'Notion';
  readonly description =
    'Search, read, and write pages across your Notion workspaces. One row per workspace you grant.';
  readonly builtIn = true;
  readonly credentialSpec: CredentialSpec = {
    needsCredentials: true,
    needsClientSecret: 'required',
  };

  private readonly mcpCache = new Map<string, McpSdkServerConfigWithInstance>();

  async hasUsableCredentials(): Promise<boolean> {
    return (await resolveCreds()) !== null;
  }

  async buildAuthRequest(): Promise<OAuthRequest> {
    const creds = await resolveCreds();
    if (!creds) {
      throw new Error(
        'Notion credentials not configured. Open Settings → Integrations → Connect Notion to paste your integration\'s Client ID + Client Secret (manage at https://www.notion.so/profile/integrations).',
      );
    }
    const state = randomState();
    const url = new URL(AUTH_URL);
    url.searchParams.set('client_id', creds.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('owner', 'user');
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('state', state);
    return {
      authUrl: url.toString(),
      state,
      codeVerifier: '',
      provider: 'notion',
    };
  }

  async completeAuth(
    _req: OAuthRequest,
    code: string,
    _query: URLSearchParams,
    hooks: ConnectorHooks,
  ): Promise<ConnectorAccount> {
    const data = await exchangeCode(code);
    const payload: NotionTokenPayload = {
      accessToken: data.access_token,
      workspaceId: data.workspace_id,
      workspaceName: data.workspace_name,
      workspaceIcon: data.workspace_icon ?? null,
      botId: data.bot_id,
      ownerUserId: data.owner?.user?.id ?? null,
      ownerEmail: data.owner?.user?.person?.email ?? null,
    };
    await hooks.setToken(payload.workspaceId, payload);
    return {
      id: payload.workspaceId,
      connectorId: 'notion',
      label: payload.workspaceName,
      addedAt: Date.now(),
      expiresAt: null,
      scopes: ['workspace'],
      meta: {
        workspaceId: payload.workspaceId,
        workspaceName: payload.workspaceName,
        ownerEmail: payload.ownerEmail,
      },
    };
  }

  async refresh(): Promise<ConnectorAccount | null> {
    // Notion workspace tokens are long-lived; no refresh endpoint.
    return null;
  }

  mcpEntries(account: ConnectorAccount): Record<string, McpServerConfig> {
    let cached = this.mcpCache.get(account.id);
    if (!cached) {
      cached = buildNotionMcp(account.id, () => readToken(account.id));
      this.mcpCache.set(account.id, cached);
    }
    return {
      [`notion-${account.id}`]: { type: 'sdk', instance: cached },
    };
  }

  async disconnect(account: ConnectorAccount): Promise<void> {
    this.mcpCache.delete(account.id);
    // Notion has no documented revoke endpoint for OAuth tokens —
    // dropping the local copy is the user's lever here. They can also
    // revoke from <workspace> → Settings → Connections.
  }
}

interface NotionTokenResponse {
  access_token: string;
  token_type: string;
  bot_id: string;
  workspace_id: string;
  workspace_name: string;
  workspace_icon?: string | null;
  owner?: {
    type: string;
    user?: {
      id: string;
      name?: string;
      person?: { email?: string };
    };
  };
}

async function exchangeCode(code: string): Promise<NotionTokenResponse> {
  const creds = await resolveCreds();
  if (!creds) throw new Error('Notion credentials missing');
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString(
    'base64',
  );
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) {
    throw new Error(`Notion token exchange failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as Partial<NotionTokenResponse>;
  if (!data.access_token || !data.workspace_id) {
    throw new Error('Notion token response missing access_token/workspace_id');
  }
  return data as NotionTokenResponse;
}

async function readToken(accountId: string): Promise<string | null> {
  const raw = await getConnectorToken('notion', accountId);
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as NotionTokenPayload).accessToken;
  } catch {
    return null;
  }
}

export const notionConnector = new NotionConnector();
