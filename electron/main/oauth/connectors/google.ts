import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

import type { ConnectorAccount } from "@shared/types";

import type { McpServerConfig } from "../../mcp-config.js";
import {
  getConnectorCredentials,
  getConnectorToken,
  setConnectorToken,
} from "../../secrets.js";
import { challengeFor, generateVerifier, randomState } from "../pkce.js";
import type {
  Connector,
  ConnectorHooks,
  ConnectorTokenPayload,
  CredentialSpec,
  OAuthRequest,
} from "../types.js";
import { buildCalendarMcp } from "./google-mcp/calendar.js";
import { buildGmailMcp } from "./google-mcp/gmail.js";

/**
 * Google OAuth connector — Gmail + Calendar in one consent flow.
 *
 * Uses the Desktop-app OAuth client type:
 *   - PKCE (no client secret needed; safe to bundle the client_id)
 *   - Loopback redirect URI: http://127.0.0.1:4747/oauth/callback/google
 *   - `access_type=offline` + `prompt=consent` so we always get a
 *     refresh_token (Google omits it on re-grants without prompt=consent)
 *
 * To activate: register a "Desktop app" OAuth client at
 *   https://console.cloud.google.com/apis/credentials
 * add `http://127.0.0.1:4747/oauth/callback/google` to the authorized
 * redirect URIs, paste the client_id into CLIENT_ID below, then
 * `pnpm dev` and click Connect from Settings → Integrations.
 *
 * MCP wiring is intentionally empty in this phase — tokens land in
 * Keychain and the account row appears in the UI, but Gmail/Calendar
 * MCP entries come in a follow-up (we own the wrapper to avoid
 * brittle dependencies on community packages that have their own
 * auth model).
 */

/** Fallback bundled credentials. Settings → Integrations can override
 *  these at runtime by writing to Keychain; the resolved pair below
 *  always prefers the Keychain copy. Leave both as `REPLACE_ME_*` if
 *  you want to force every install to paste their own. */
const FALLBACK_CLIENT_ID =
  "REPLACE_ME_CLIENT_ID";
/**
 * Empty for **Desktop app** clients (PKCE-only). Required for **Web
 * application** clients — Google's token endpoint returns 400
 * `client_secret is missing` if you try to exchange a Web-app code
 * without it.
 */
const FALLBACK_CLIENT_SECRET = "REPLACE_ME_CLIENT_SECRET";

interface ResolvedCreds {
  clientId: string;
  clientSecret: string;
}

/** Keychain > bundled fallback. Returns null when neither has a
 *  usable clientId, so callers can throw the consistent "credentials
 *  not configured" error. */
async function resolveCreds(): Promise<ResolvedCreds | null> {
  const stored = await getConnectorCredentials('google');
  const clientId = stored?.clientId ?? FALLBACK_CLIENT_ID;
  if (!clientId || clientId.startsWith('REPLACE_ME')) return null;
  return {
    clientId,
    clientSecret: stored?.clientSecret ?? FALLBACK_CLIENT_SECRET,
  };
}
const REDIRECT_URI = "http://127.0.0.1:4747/oauth/callback/google";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** Single flow gathers everything we'll need for Gmail + Calendar. The
 *  Google consent screen lists each scope individually; users see one
 *  approve button. */
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
];

interface GoogleTokenPayload extends ConnectorTokenPayload {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  /** Raw id_token (JWT) for future identity refresh; we read email
   *  from it on initial connect and otherwise don't touch it. */
  idToken?: string;
}

class GoogleConnector implements Connector {
  readonly id = "google" as const;
  readonly name = "Google";
  readonly description =
    "Gmail + Calendar across personal and work accounts. One sign-in covers both APIs.";
  readonly builtIn = true;
  readonly credentialSpec: CredentialSpec = {
    needsCredentials: true,
    // Desktop-app OAuth clients use PKCE only (no secret).
    // Web-application clients require it. Optional covers both.
    needsClientSecret: 'optional',
  };

  async hasUsableCredentials(): Promise<boolean> {
    return (await resolveCreds()) !== null;
  }

  /** Cached MCP instances per account so we don't rebuild the server
   *  (and re-register tools) on every `resolve()` pass. Tool callbacks
   *  read the token lazily on each call, so a refresh under the hood
   *  doesn't require invalidating the cache. */
  private readonly mcpCache = new Map<
    string,
    { gmail: McpSdkServerConfigWithInstance; calendar: McpSdkServerConfigWithInstance }
  >();

  async buildAuthRequest(): Promise<OAuthRequest> {
    const creds = await resolveCreds();
    if (!creds) {
      throw new Error(
        "Google client_id not configured. Open Settings → Integrations → Connect Google to paste your OAuth client id (or register a Desktop client at https://console.cloud.google.com/apis/credentials).",
      );
    }
    const state = randomState();
    const codeVerifier = generateVerifier();
    const codeChallenge = challengeFor(codeVerifier);
    const url = new URL(AUTH_URL);
    url.searchParams.set("client_id", creds.clientId);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    return {
      authUrl: url.toString(),
      state,
      codeVerifier,
      provider: "google",
    };
  }

  async completeAuth(
    req: OAuthRequest,
    code: string,
    _query: URLSearchParams,
    hooks: ConnectorHooks,
  ): Promise<ConnectorAccount> {
    const tokens = await exchangeCode(code, req.codeVerifier);
    const email = identityFrom(tokens.id_token ?? "");
    if (!email) {
      throw new Error("Google response missing email claim");
    }
    const payload: GoogleTokenPayload = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      scope: tokens.scope,
      idToken: tokens.id_token,
    };
    await hooks.setToken(email, payload);
    return {
      id: email,
      connectorId: "google",
      label: email,
      addedAt: Date.now(),
      expiresAt: payload.expiresAt,
      scopes: tokens.scope.split(/\s+/).filter(Boolean),
      meta: { email },
    };
  }

  async refresh(
    account: ConnectorAccount,
    hooks: ConnectorHooks,
  ): Promise<ConnectorAccount | null> {
    const current = (await hooks.getToken(
      account.id,
    )) as GoogleTokenPayload | null;
    if (!current?.refreshToken) {
      throw new Error("Google account is missing a refresh token");
    }
    const tokens = await refreshAccessToken(current.refreshToken);
    const next: GoogleTokenPayload = {
      ...current,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      scope: tokens.scope ?? current.scope,
    };
    await hooks.setToken(account.id, next);
    return {
      ...account,
      expiresAt: next.expiresAt,
      scopes: next.scope.split(/\s+/).filter(Boolean),
      needsReauth: false,
    };
  }

  mcpEntries(account: ConnectorAccount): Record<string, McpServerConfig> {
    let cached = this.mcpCache.get(account.id);
    if (!cached) {
      const getter = (): Promise<string | null> =>
        this.getValidAccessToken(account.id);
      cached = {
        gmail: buildGmailMcp(account.id, getter),
        calendar: buildCalendarMcp(account.id, getter),
      };
      this.mcpCache.set(account.id, cached);
    }
    return {
      [`gmail-${account.id}`]: { type: "sdk", instance: cached.gmail },
      [`calendar-${account.id}`]: { type: "sdk", instance: cached.calendar },
    };
  }

  /**
   * Read the current access token from Keychain. If it's within 60 s
   * of expiry, refresh it inline and persist the new payload before
   * returning. The 5-min `TokenRefresher` keeps tokens fresh at scale;
   * this just plugs the inevitable "tool fires right at the edge" gap.
   */
  private async getValidAccessToken(
    accountId: string,
  ): Promise<string | null> {
    const raw = await getConnectorToken("google", accountId);
    if (!raw) return null;
    let payload: GoogleTokenPayload;
    try {
      payload = JSON.parse(raw) as GoogleTokenPayload;
    } catch {
      return null;
    }
    const BUFFER_MS = 60 * 1000;
    if (payload.expiresAt - BUFFER_MS > Date.now()) {
      return payload.accessToken;
    }
    try {
      const tokens = await refreshAccessToken(payload.refreshToken);
      const next: GoogleTokenPayload = {
        ...payload,
        accessToken: tokens.access_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        scope: tokens.scope ?? payload.scope,
      };
      await setConnectorToken("google", accountId, JSON.stringify(next));
      return next.accessToken;
    } catch {
      // Fall back to the stale token — the API call will likely 401
      // and surface that to the caller, which is more actionable than
      // returning null here.
      return payload.accessToken;
    }
  }

  async test(
    account: ConnectorAccount,
    _hooks: ConnectorHooks,
  ): Promise<{ ok: true; summary: string } | { ok: false; message: string }> {
    try {
      const token = await this.getValidAccessToken(account.id);
      if (!token) return { ok: false, message: 'No token in Keychain' };
      const res = await fetch(
        'https://openidconnect.googleapis.com/v1/userinfo',
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        return {
          ok: false,
          message: `userinfo returned ${res.status}`,
        };
      }
      const data = (await res.json()) as { email?: string };
      return {
        ok: true,
        summary: `Google · ${data.email ?? account.label}`,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async disconnect(
    account: ConnectorAccount,
    hooks: ConnectorHooks,
  ): Promise<void> {
    this.mcpCache.delete(account.id);
    const current = (await hooks.getToken(
      account.id,
    )) as GoogleTokenPayload | null;
    if (current?.refreshToken) {
      // Best-effort revoke. Google's revoke endpoint accepts either an
      // access or refresh token; we send the refresh because it's the
      // long-lived credential.
      try {
        await fetch(REVOKE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: current.refreshToken }),
        });
      } catch {
        // Network glitches during disconnect aren't worth surfacing —
        // the local token is dropped regardless via clearToken in the
        // orchestrator.
      }
    }
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
  id_token?: string;
}

async function exchangeCode(
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const creds = await resolveCreds();
  if (!creds) throw new Error('Google credentials missing');
  const body: Record<string, string> = {
    code,
    client_id: creds.clientId,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  };
  if (creds.clientSecret) body['client_secret'] = creds.clientSecret;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${detail}`);
  }
  const data = (await res.json()) as Partial<TokenResponse>;
  if (!data.access_token || !data.refresh_token) {
    throw new Error("Google token response missing access/refresh token");
  }
  return data as TokenResponse;
}

interface RefreshResponse {
  access_token: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

async function refreshAccessToken(
  refreshToken: string,
): Promise<RefreshResponse> {
  const creds = await resolveCreds();
  if (!creds) throw new Error('Google credentials missing');
  const body: Record<string, string> = {
    client_id: creds.clientId,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  };
  if (creds.clientSecret) body['client_secret'] = creds.clientSecret;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Google refresh failed (${res.status}): ${detail}`);
  }
  const data = (await res.json()) as Partial<RefreshResponse>;
  if (!data.access_token) {
    throw new Error("Google refresh response missing access_token");
  }
  return data as RefreshResponse;
}

/**
 * Pull the user's email out of the id_token JWT. We don't verify the
 * signature — the token came directly from Google's TLS endpoint, not
 * via the client, so trusting the claims is appropriate for identity
 * derivation here. Tools that need verified identity should re-fetch
 * via Google's userinfo endpoint.
 */
function identityFrom(idToken: string): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(
        parts[1]!.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8"),
    ) as { email?: string };
    return typeof payload.email === "string" && payload.email
      ? payload.email
      : null;
  } catch {
    return null;
  }
}

export const googleConnector = new GoogleConnector();
