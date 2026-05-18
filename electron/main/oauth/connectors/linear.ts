import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

import type { ConnectorAccount } from '@shared/types';

import type { McpServerConfig } from '../../mcp-config.js';
import {
  getConnectorCredentials,
  getConnectorToken,
  setConnectorToken,
} from '../../secrets.js';
import { challengeFor, generateVerifier, randomState } from '../pkce.js';
import type {
  ApiKeyMode,
  Connector,
  ConnectorHooks,
  ConnectorTokenPayload,
  CredentialSpec,
  OAuthRequest,
} from '../types.js';
import { buildLinearMcp } from './linear-mcp/index.js';

/**
 * Linear OAuth connector. PKCE flow (no client secret) — the
 * client_id can be safely bundled. Tokens last 10 years by default
 * and have a refresh path; we still refresh defensively via the
 * shared TokenRefresher (5-min cadence) when `expires_in` is short.
 */

const FALLBACK_CLIENT_ID = 'REPLACE_ME_LINEAR_CLIENT_ID';
const REDIRECT_URI = 'http://127.0.0.1:4747/oauth/callback/linear';

async function resolveClientId(): Promise<string | null> {
  const stored = await getConnectorCredentials('linear');
  const id = stored?.clientId ?? FALLBACK_CLIENT_ID;
  if (!id || id.startsWith('REPLACE_ME')) return null;
  return id;
}
const AUTH_URL = 'https://linear.app/oauth/authorize';
const TOKEN_URL = 'https://api.linear.app/oauth/token';
const REVOKE_URL = 'https://api.linear.app/oauth/revoke';
const VIEWER_QUERY = `query Viewer { viewer { id name email } }`;

const SCOPES = ['read', 'write'];

export interface LinearTokenPayload extends ConnectorTokenPayload {
  /** OAuth access token OR a personal API key (depending on
   *  `authMode`). Both are sent as Bearer to Linear's GraphQL
   *  endpoint, so the MCP doesn't care which. */
  accessToken: string;
  refreshToken?: string;
  expiresAt: number | null;
  scope: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  /** 'oauth' means OAuth flow produced this; 'apiKey' means the user
   *  pasted a personal API key. Determines whether the refresher
   *  touches this account. */
  authMode: 'oauth' | 'apiKey';
}

class LinearConnector implements Connector {
  readonly id = 'linear' as const;
  readonly name = 'Linear';
  readonly description =
    'Issues, projects, and comments for the Linear workspace where this app is installed.';
  readonly builtIn = true;
  readonly credentialSpec: CredentialSpec = {
    needsCredentials: true,
    // PKCE flow — no client_secret to gather.
    needsClientSecret: 'never',
  };
  readonly apiKeyMode: ApiKeyMode = {
    label: 'Personal API Key',
    helpText:
      'Skip OAuth entirely — paste a personal API key. Generate one in Linear at Settings → Account → API → Personal API keys → Create key. The key is stored in Keychain and sent as a Bearer token directly. No workspace admin needed.',
    helpUrl: 'https://linear.app/settings/account/api',
    placeholder: 'lin_api_...',
    connect: async (apiKey, hooks) => {
      const viewer = await fetchViewer(apiKey);
      const payload: LinearTokenPayload = {
        accessToken: apiKey,
        // Personal keys don't expire and don't have refresh tokens.
        expiresAt: null,
        scope: 'personal-api-key',
        userId: viewer.id,
        userName: viewer.name,
        userEmail: viewer.email,
        authMode: 'apiKey',
      };
      await hooks.setToken(viewer.id, payload);
      return {
        id: viewer.id,
        connectorId: 'linear',
        label: `${viewer.email ?? viewer.name ?? viewer.id} (API key)`,
        addedAt: Date.now(),
        expiresAt: null,
        scopes: ['personal-api-key'],
        meta: {
          userId: viewer.id,
          userName: viewer.name ?? null,
          userEmail: viewer.email ?? null,
          authMode: 'apiKey',
        },
      };
    },
  };

  private readonly mcpCache = new Map<string, McpSdkServerConfigWithInstance>();

  async hasUsableCredentials(): Promise<boolean> {
    return (await resolveClientId()) !== null;
  }

  async buildAuthRequest(): Promise<OAuthRequest> {
    const clientId = await resolveClientId();
    if (!clientId) {
      throw new Error(
        'Linear client_id not configured. Open Settings → Integrations → Connect Linear to paste your OAuth application\'s Client ID (manage at https://linear.app/settings/api/applications).',
      );
    }
    const state = randomState();
    const codeVerifier = generateVerifier();
    const codeChallenge = challengeFor(codeVerifier);
    const url = new URL(AUTH_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', SCOPES.join(','));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return {
      authUrl: url.toString(),
      state,
      codeVerifier,
      provider: 'linear',
    };
  }

  async completeAuth(
    req: OAuthRequest,
    code: string,
    _query: URLSearchParams,
    hooks: ConnectorHooks,
  ): Promise<ConnectorAccount> {
    const tokens = await exchangeCode(code, req.codeVerifier);
    const viewer = await fetchViewer(tokens.access_token);
    const expiresAt = tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000
      : null;
    const payload: LinearTokenPayload = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
      scope: tokens.scope ?? SCOPES.join(','),
      userId: viewer.id,
      userName: viewer.name,
      userEmail: viewer.email,
      authMode: 'oauth',
    };
    await hooks.setToken(payload.userId, payload);
    return {
      id: payload.userId,
      connectorId: 'linear',
      label: viewer.email ?? viewer.name ?? viewer.id,
      addedAt: Date.now(),
      expiresAt,
      scopes: payload.scope.split(',').filter(Boolean),
      meta: {
        userId: viewer.id,
        userName: viewer.name ?? null,
        userEmail: viewer.email ?? null,
        authMode: 'oauth',
      },
    };
  }

  async refresh(
    account: ConnectorAccount,
    hooks: ConnectorHooks,
  ): Promise<ConnectorAccount | null> {
    const current = (await hooks.getToken(account.id)) as LinearTokenPayload | null;
    // Personal API keys don't expire and have no refresh leg —
    // nothing to do here.
    if (current?.authMode === 'apiKey') return null;
    if (!current?.refreshToken) {
      // Linear tokens without a refresh leg are essentially permanent
      // until revoked. Nothing to do.
      return null;
    }
    const tokens = await refreshAccessToken(current.refreshToken);
    const expiresAt = tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000
      : null;
    const next: LinearTokenPayload = {
      ...current,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? current.refreshToken,
      expiresAt,
      scope: tokens.scope ?? current.scope,
    };
    await hooks.setToken(account.id, next);
    return {
      ...account,
      expiresAt,
      scopes: next.scope.split(',').filter(Boolean),
      needsReauth: false,
    };
  }

  mcpEntries(account: ConnectorAccount): Record<string, McpServerConfig> {
    let cached = this.mcpCache.get(account.id);
    if (!cached) {
      cached = buildLinearMcp(account.id, () =>
        this.getValidAccessToken(account.id),
      );
      this.mcpCache.set(account.id, cached);
    }
    return {
      [`linear-${account.id}`]: { type: 'sdk', instance: cached },
    };
  }

  /** Proactive refresh inside the 60 s expiry buffer — same pattern
   *  as Google. Linear tokens are usually long-lived so this is
   *  rarely exercised, but cheap insurance. Personal API keys
   *  short-circuit (no expiry, no refresh leg). */
  private async getValidAccessToken(accountId: string): Promise<string | null> {
    const raw = await getConnectorToken('linear', accountId);
    if (!raw) return null;
    let payload: LinearTokenPayload;
    try {
      payload = JSON.parse(raw) as LinearTokenPayload;
    } catch {
      return null;
    }
    if (payload.authMode === 'apiKey') return payload.accessToken;
    const BUFFER_MS = 60 * 1000;
    if (
      payload.expiresAt == null ||
      payload.expiresAt - BUFFER_MS > Date.now()
    ) {
      return payload.accessToken;
    }
    if (!payload.refreshToken) return payload.accessToken;
    try {
      const tokens = await refreshAccessToken(payload.refreshToken);
      const expiresAt = tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000
        : null;
      const next: LinearTokenPayload = {
        ...payload,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? payload.refreshToken,
        expiresAt,
        scope: tokens.scope ?? payload.scope,
      };
      await setConnectorToken('linear', accountId, JSON.stringify(next));
      return next.accessToken;
    } catch {
      return payload.accessToken;
    }
  }

  async disconnect(
    account: ConnectorAccount,
    hooks: ConnectorHooks,
  ): Promise<void> {
    this.mcpCache.delete(account.id);
    const current = (await hooks.getToken(account.id)) as LinearTokenPayload | null;
    // Personal API keys aren't OAuth tokens — Linear's revoke
    // endpoint refuses them. The user manages key lifecycle from
    // their Linear API settings; we just drop the local copy.
    if (current?.accessToken && current.authMode !== 'apiKey') {
      try {
        await fetch(REVOKE_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${current.accessToken}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        });
      } catch {
        // Drop silently; clearToken takes care of the local copy.
      }
    }
  }
}

interface LinearTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type: string;
}

async function exchangeCode(
  code: string,
  codeVerifier: string,
): Promise<LinearTokenResponse> {
  const clientId = await resolveClientId();
  if (!clientId) throw new Error('Linear client_id missing');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`Linear token exchange failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as Partial<LinearTokenResponse>;
  if (!data.access_token) {
    throw new Error('Linear token response missing access_token');
  }
  return data as LinearTokenResponse;
}

async function refreshAccessToken(
  refreshToken: string,
): Promise<LinearTokenResponse> {
  const clientId = await resolveClientId();
  if (!clientId) throw new Error('Linear client_id missing');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    throw new Error(`Linear refresh failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as Partial<LinearTokenResponse>;
  if (!data.access_token) {
    throw new Error('Linear refresh response missing access_token');
  }
  return data as LinearTokenResponse;
}

interface ViewerInfo {
  id: string;
  name?: string;
  email?: string;
}

async function fetchViewer(token: string): Promise<ViewerInfo> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: VIEWER_QUERY }),
  });
  if (!res.ok) {
    throw new Error(`Linear viewer query failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { data?: { viewer?: ViewerInfo } };
  if (!data.data?.viewer?.id) {
    throw new Error('Linear viewer response missing id');
  }
  return data.data.viewer;
}

export const linearConnector = new LinearConnector();
