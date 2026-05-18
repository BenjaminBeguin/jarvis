import type { ConnectorAccount } from '@shared/types';

import type { McpServerConfig } from '../../mcp-config.js';
import { getConnectorCredentials, getConnectorToken } from '../../secrets.js';
import { randomState } from '../pkce.js';
import type {
  ApiKeyMode,
  Connector,
  ConnectorHooks,
  ConnectorTokenPayload,
  CredentialSpec,
  OAuthRequest,
} from '../types.js';

/**
 * GitHub OAuth connector. Two auth paths:
 *
 *   - OAuth App (confidential client) — register at
 *     github.com/settings/developers → OAuth Apps → New OAuth App.
 *     Client ID + Client Secret required. Redirect URI must be
 *     http://127.0.0.1:4747/oauth/callback/github.
 *   - Personal Access Token (apiKeyMode) — paste a token from
 *     github.com/settings/tokens. Classic (ghp_...) or fine-grained
 *     (github_pat_...) both work.
 *
 * Publishes a stdio MCP entry per account spawning
 * `@modelcontextprotocol/server-github` with the token in env. Tokens
 * live in main-process memory (cache) so mcpEntries can return a
 * usable spawn config synchronously; the cache is warmed at boot via
 * the Connector.init() lifecycle hook.
 *
 * NOTE: SSH keys don't authenticate to GitHub's REST API — they're
 * for `git push/pull` only. Use Bash + git for SSH-authed git
 * operations; this connector is for API-level access (PRs, issues,
 * files, search, etc.).
 */

const FALLBACK_CLIENT_ID = 'REPLACE_ME_GITHUB_CLIENT_ID';
const FALLBACK_CLIENT_SECRET = 'REPLACE_ME_GITHUB_CLIENT_SECRET';
const REDIRECT_URI = 'http://127.0.0.1:4747/oauth/callback/github';
const AUTH_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const REVOKE_URL_PREFIX = 'https://api.github.com/applications';

const SCOPES = ['repo', 'read:user', 'read:org', 'workflow'];

interface ResolvedCreds {
  clientId: string;
  clientSecret: string;
}

async function resolveCreds(): Promise<ResolvedCreds | null> {
  const stored = await getConnectorCredentials('github');
  const clientId = stored?.clientId ?? FALLBACK_CLIENT_ID;
  const clientSecret = stored?.clientSecret ?? FALLBACK_CLIENT_SECRET;
  if (!clientId || clientId.startsWith('REPLACE_ME')) return null;
  if (!clientSecret || clientSecret.startsWith('REPLACE_ME')) return null;
  return { clientId, clientSecret };
}

export interface GitHubTokenPayload extends ConnectorTokenPayload {
  accessToken: string;
  login: string;
  userId: number;
  scope: string;
  authMode: 'oauth' | 'apiKey';
}

class GitHubConnector implements Connector {
  readonly id = 'github' as const;
  readonly name = 'GitHub';
  readonly description =
    'Issues, PRs, files, repos via the GitHub API. Bash + gh is already wired for any operation you\'d do from a terminal; the MCP adds structured tool calls.';
  readonly builtIn = true;
  readonly credentialSpec: CredentialSpec = {
    needsCredentials: true,
    needsClientSecret: 'required',
  };
  readonly apiKeyMode: ApiKeyMode = {
    label: 'Personal Access Token',
    helpText:
      'Paste a GitHub PAT (classic ghp_… or fine-grained github_pat_…). Generate at github.com/settings/tokens with at least repo + read:user + read:org scopes. Token is stored in Keychain, never written to mcp.json.',
    helpUrl: 'https://github.com/settings/tokens',
    placeholder: 'ghp_… or github_pat_…',
    connect: async (apiKey, hooks) => {
      const user = await fetchGitHubUser(apiKey);
      const payload: GitHubTokenPayload = {
        accessToken: apiKey,
        login: user.login,
        userId: user.id,
        scope: 'personal-access-token',
        authMode: 'apiKey',
      };
      await hooks.setToken(user.login, payload);
      this.tokenCache.set(user.login, apiKey);
      return {
        id: user.login,
        connectorId: 'github',
        label: `${user.login} (PAT)`,
        addedAt: Date.now(),
        expiresAt: null,
        scopes: ['personal-access-token'],
        meta: {
          login: user.login,
          userId: user.id,
          authMode: 'apiKey',
        },
      };
    },
  };

  /** Token cache keyed by accountId (the GitHub login). mcpEntries
   *  reads from this synchronously to build the stdio spawn config.
   *  Warmed at boot by init() and updated on each connect. */
  private readonly tokenCache = new Map<string, string>();

  async hasUsableCredentials(): Promise<boolean> {
    return (await resolveCreds()) !== null;
  }

  async init(accounts: ConnectorAccount[], hooks: ConnectorHooks): Promise<void> {
    for (const account of accounts) {
      const raw = await hooks.getToken(account.id);
      if (!raw) continue;
      const payload = raw as Partial<GitHubTokenPayload>;
      if (typeof payload.accessToken === 'string') {
        this.tokenCache.set(account.id, payload.accessToken);
      }
    }
  }

  async buildAuthRequest(): Promise<OAuthRequest> {
    const creds = await resolveCreds();
    if (!creds) {
      throw new Error(
        'GitHub OAuth client not configured. Either paste a Personal Access Token in the API Key tab, or register an OAuth App at https://github.com/settings/developers and save its Client ID + Secret here.',
      );
    }
    const state = randomState();
    const url = new URL(AUTH_URL);
    url.searchParams.set('client_id', creds.clientId);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', SCOPES.join(' '));
    url.searchParams.set('state', state);
    return {
      authUrl: url.toString(),
      state,
      // GitHub OAuth Apps don't support PKCE — code_verifier unused.
      codeVerifier: '',
      provider: 'github',
    };
  }

  async completeAuth(
    _req: OAuthRequest,
    code: string,
    _query: URLSearchParams,
    hooks: ConnectorHooks,
  ): Promise<ConnectorAccount> {
    const creds = await resolveCreds();
    if (!creds) throw new Error('GitHub credentials missing');
    const tokens = await exchangeCode(creds, code);
    const user = await fetchGitHubUser(tokens.access_token);
    const payload: GitHubTokenPayload = {
      accessToken: tokens.access_token,
      login: user.login,
      userId: user.id,
      scope: tokens.scope ?? SCOPES.join(','),
      authMode: 'oauth',
    };
    await hooks.setToken(user.login, payload);
    this.tokenCache.set(user.login, tokens.access_token);
    return {
      id: user.login,
      connectorId: 'github',
      label: user.login,
      addedAt: Date.now(),
      expiresAt: null,
      scopes: payload.scope.split(/[ ,]/).filter(Boolean),
      meta: {
        login: user.login,
        userId: user.id,
        authMode: 'oauth',
      },
    };
  }

  async refresh(): Promise<ConnectorAccount | null> {
    // GitHub OAuth App tokens don't expire by default (no refresh
    // endpoint in classic flow). Personal access tokens may carry an
    // expiry the user set at generation time but GitHub doesn't
    // expose a refresh path — the user re-pastes when it lapses.
    return null;
  }

  mcpEntries(account: ConnectorAccount): Record<string, McpServerConfig> {
    const token = this.tokenCache.get(account.id);
    if (!token) {
      // Cache miss — init() didn't pick this up (account added mid-
      // session before init ran again, or cache cleared somehow).
      // Return an entry without the env var; the agent will surface
      // GitHub's auth-required error so the user can reconnect.
      return {
        [`github-${account.id}`]: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: {},
        },
      };
    }
    return {
      [`github-${account.id}`]: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: token },
      },
    };
  }

  async disconnect(
    account: ConnectorAccount,
    hooks: ConnectorHooks,
  ): Promise<void> {
    this.tokenCache.delete(account.id);
    const current = (await hooks.getToken(account.id)) as
      | GitHubTokenPayload
      | null;
    // GitHub OAuth App tokens can be revoked via DELETE
    // /applications/:client_id/grant; PATs are user-managed only
    // (drop locally and tell the user to delete the token in
    // github.com/settings/tokens if they want full revocation).
    if (current?.authMode === 'oauth' && current.accessToken) {
      const creds = await resolveCreds();
      if (!creds) return;
      const basic = Buffer.from(
        `${creds.clientId}:${creds.clientSecret}`,
      ).toString('base64');
      try {
        await fetch(
          `${REVOKE_URL_PREFIX}/${encodeURIComponent(creds.clientId)}/grant`,
          {
            method: 'DELETE',
            headers: {
              Authorization: `Basic ${basic}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ access_token: current.accessToken }),
          },
        );
      } catch {
        // Best-effort; local token is already gone via clearToken.
      }
    }
  }
}

interface GitHubTokenResponse {
  access_token: string;
  scope?: string;
  token_type: string;
}

async function exchangeCode(
  creds: ResolvedCreds,
  code: string,
): Promise<GitHubTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `GitHub token exchange failed (${res.status}): ${await res.text()}`,
    );
  }
  const data = (await res.json()) as Partial<GitHubTokenResponse> & {
    error?: string;
    error_description?: string;
  };
  if (data.error) {
    throw new Error(
      `GitHub OAuth error: ${data.error_description ?? data.error}`,
    );
  }
  if (!data.access_token) {
    throw new Error('GitHub token response missing access_token');
  }
  return data as GitHubTokenResponse;
}

interface GitHubUserResponse {
  login: string;
  id: number;
  name?: string;
  email?: string;
}

async function fetchGitHubUser(token: string): Promise<GitHubUserResponse> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new Error(
      `GitHub auth check failed (${res.status}): ${await res.text()}`,
    );
  }
  return (await res.json()) as GitHubUserResponse;
}

// Read-only helper for index.ts init wiring — TaskRunner doesn't need it.
export async function loadStoredGitHubToken(
  accountId: string,
): Promise<string | null> {
  const raw = await getConnectorToken('github', accountId);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as GitHubTokenPayload;
    return payload.accessToken;
  } catch {
    return null;
  }
}

export const githubConnector = new GitHubConnector();
