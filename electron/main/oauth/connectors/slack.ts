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
import { buildSlackMcp } from './slack-mcp/index.js';

/**
 * Slack OAuth connector — one OAuth flow grants both a **bot** token
 * (xoxb, for posting in channels the app is a member of and on behalf
 * of the workspace) and a **user** token (xoxp, for posting "as me").
 *
 * Slack's OAuth v2 is a confidential-client flow — it requires both
 * `client_id` AND `client_secret`. PKCE isn't supported. For solo /
 * single-workspace use that's fine; for distribution see
 * docs/integrations.md (path: keep this user-supplied via a Settings
 * panel, or apply for Slack App Directory).
 *
 * Account identity = `team.id` (workspace id). Tokens don't expire by
 * default, so `expiresAt: null` and `refresh()` is a no-op.
 */

const FALLBACK_CLIENT_ID = 'REPLACE_ME_SLACK_CLIENT_ID';
const FALLBACK_CLIENT_SECRET = 'REPLACE_ME_SLACK_CLIENT_SECRET';
const REDIRECT_URI = 'http://127.0.0.1:4747/oauth/callback/slack';

interface ResolvedCreds {
  clientId: string;
  clientSecret: string;
}

async function resolveCreds(): Promise<ResolvedCreds | null> {
  const stored = await getConnectorCredentials('slack');
  const clientId = stored?.clientId ?? FALLBACK_CLIENT_ID;
  const clientSecret = stored?.clientSecret ?? FALLBACK_CLIENT_SECRET;
  if (!clientId || clientId.startsWith('REPLACE_ME')) return null;
  if (!clientSecret || clientSecret.startsWith('REPLACE_ME')) return null;
  return { clientId, clientSecret };
}
const AUTH_URL = 'https://slack.com/oauth/v2/authorize';
const TOKEN_URL = 'https://slack.com/api/oauth.v2.access';
const REVOKE_URL = 'https://slack.com/api/auth.revoke';

/** Bot-side scopes: what the app can do as a workspace participant. */
const BOT_SCOPES = [
  'chat:write',
  'chat:write.public',
  'channels:read',
  'groups:read',
  'users:read',
  'users:read.email',
  'search:read',
];
/** User-side scopes: what the app can do impersonating the installer
 *  (the "send as me" path). Keep minimal — we only need writes + read
 *  scopes for read-as-user paths. */
const USER_SCOPES = ['chat:write', 'search:read'];

/** Per-account preference. Determines which token `chat.postMessage`
 *  uses. Other read-side tools always use the user token (sees more). */
export type SendAs = 'bot' | 'user';

export interface SlackTokenPayload extends ConnectorTokenPayload {
  /** xoxb-… — posts as the app/bot user. */
  botAccessToken: string;
  /** xoxp-… — posts as the installer ("send as me"). */
  userAccessToken: string;
  /** Granted bot scopes. */
  botScope: string;
  /** Granted user scopes. */
  userScope: string;
  teamId: string;
  teamName: string;
  botUserId?: string;
  authedUserId?: string;
}

class SlackConnector implements Connector {
  readonly id = 'slack' as const;
  readonly name = 'Slack';
  readonly description =
    'Send messages, search, and read channels in your Slack workspace. Per-workspace; you choose bot or "send as me" per account.';
  readonly builtIn = true;
  readonly credentialSpec: CredentialSpec = {
    needsCredentials: true,
    needsClientSecret: 'required',
  };

  async hasUsableCredentials(): Promise<boolean> {
    return (await resolveCreds()) !== null;
  }

  /** One MCP server per workspace, cached so we don't re-register
   *  tools on every resolve() pass. Tool callbacks read tokens + the
   *  sendAs preference lazily on each call. */
  private readonly mcpCache = new Map<string, McpSdkServerConfigWithInstance>();

  /** Optional callback to fetch the latest account state at tool-call
   *  time. Without it, the sendAs preference captured when the MCP
   *  instance was built goes stale when the user flips the toggle.
   *  Wired by index.ts to read from the IntegrationsStore. */
  private readAccount: ((accountId: string) => ConnectorAccount | null) | null =
    null;

  setAccountReader(
    reader: (accountId: string) => ConnectorAccount | null,
  ): void {
    this.readAccount = reader;
  }

  async buildAuthRequest(): Promise<OAuthRequest> {
    const creds = await resolveCreds();
    if (!creds) {
      throw new Error(
        'Slack credentials not configured. Open Settings → Integrations → Connect Slack to paste your Client ID + Client Secret (Slack app dashboard at https://api.slack.com/apps).',
      );
    }
    const state = randomState();
    const url = new URL(AUTH_URL);
    url.searchParams.set('client_id', creds.clientId);
    url.searchParams.set('scope', BOT_SCOPES.join(','));
    url.searchParams.set('user_scope', USER_SCOPES.join(','));
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('state', state);
    return {
      authUrl: url.toString(),
      state,
      // Slack OAuth v2 doesn't use PKCE — `code_verifier` stays unused.
      codeVerifier: '',
      provider: 'slack',
    };
  }

  async completeAuth(
    _req: OAuthRequest,
    code: string,
    _query: URLSearchParams,
    hooks: ConnectorHooks,
  ): Promise<ConnectorAccount> {
    const data = await exchangeCode(code);
    const payload: SlackTokenPayload = {
      botAccessToken: data.access_token,
      userAccessToken: data.authed_user.access_token,
      botScope: data.scope,
      userScope: data.authed_user.scope,
      teamId: data.team.id,
      teamName: data.team.name,
      botUserId: data.bot_user_id,
      authedUserId: data.authed_user.id,
    };
    await hooks.setToken(payload.teamId, payload);
    return {
      id: payload.teamId,
      connectorId: 'slack',
      label: payload.teamName,
      addedAt: Date.now(),
      expiresAt: null,
      // Surface both scope strings to the renderer so the user can
      // see what they granted at a glance.
      scopes: [
        ...payload.botScope.split(',').filter(Boolean).map((s) => `bot:${s}`),
        ...payload.userScope.split(',').filter(Boolean).map((s) => `user:${s}`),
      ],
      meta: {
        teamId: payload.teamId,
        teamName: payload.teamName,
        sendAs: 'bot' as SendAs,
      },
    };
  }

  async refresh(): Promise<ConnectorAccount | null> {
    // Slack tokens are long-lived; no refresh endpoint to call.
    return null;
  }

  mcpEntries(account: ConnectorAccount): Record<string, McpServerConfig> {
    let cached = this.mcpCache.get(account.id);
    if (!cached) {
      cached = buildSlackMcp(account.id, {
        getPayload: () => readPayload(account.id),
        // Always look up the freshest account state — sendAs flips at
        // runtime via Settings → Integrations and the closure captured
        // at MCP-build time would otherwise hold a stale value.
        getSendAs: () =>
          readSendAs(this.readAccount?.(account.id) ?? account),
      });
      this.mcpCache.set(account.id, cached);
    }
    return {
      [`slack-${account.id}`]: { type: 'sdk', instance: cached },
    };
  }

  async disconnect(
    account: ConnectorAccount,
    hooks: ConnectorHooks,
  ): Promise<void> {
    this.mcpCache.delete(account.id);
    const current = (await hooks.getToken(account.id)) as SlackTokenPayload | null;
    if (current?.botAccessToken) {
      try {
        await fetch(REVOKE_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${current.botAccessToken}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        });
      } catch {
        // Network failures during disconnect aren't worth surfacing —
        // local tokens are dropped via clearToken regardless.
      }
    }
  }
}

interface SlackTokenResponse {
  ok: boolean;
  error?: string;
  access_token: string;
  token_type: string;
  scope: string;
  bot_user_id?: string;
  app_id?: string;
  team: { id: string; name: string };
  authed_user: {
    id: string;
    scope: string;
    access_token: string;
    token_type: string;
  };
}

async function exchangeCode(code: string): Promise<SlackTokenResponse> {
  const creds = await resolveCreds();
  if (!creds) throw new Error('Slack credentials missing');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) {
    throw new Error(`Slack token exchange failed (${res.status}): ${await res.text()}`);
  }
  // Slack returns 200 with `ok: false` on auth errors instead of HTTP error codes.
  const data = (await res.json()) as Partial<SlackTokenResponse>;
  if (!data.ok || !data.access_token || !data.authed_user?.access_token) {
    throw new Error(`Slack token exchange refused: ${data.error ?? 'unknown'}`);
  }
  return data as SlackTokenResponse;
}

async function readPayload(accountId: string): Promise<SlackTokenPayload | null> {
  const raw = await getConnectorToken('slack', accountId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SlackTokenPayload;
  } catch {
    return null;
  }
}

function readSendAs(account: ConnectorAccount): SendAs {
  const v = (account.meta as { sendAs?: unknown }).sendAs;
  return v === 'user' ? 'user' : 'bot';
}

export const slackConnector = new SlackConnector();
