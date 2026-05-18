import type { ConnectorAccount, ConnectorId } from '@shared/types';

import type { McpServerConfig } from '../mcp-config.js';

/**
 * Token payload stored in Keychain (JSON-stringified, one entry per
 * account). Connectors define their own concrete shape on top of the
 * generic envelope — Slack stores both `bot` + `user`, Google stores
 * `accessToken` + `refreshToken` + `expiresAt`, etc.
 */
export type ConnectorTokenPayload = Record<string, unknown>;

/** Returned from `Connector.buildAuthRequest()` to drive the consent flow. */
export interface OAuthRequest {
  /** URL the renderer opens in the external browser. */
  authUrl: string;
  /** OAuth `state` nonce we'll match on callback. */
  state: string;
  /** PKCE verifier (challenge is what we sent to the provider). */
  codeVerifier: string;
  /** Provider's identifier as it appears in the callback path:
   *  `/oauth/callback/<provider>`. Usually the connectorId. */
  provider: string;
}

/**
 * Declares what OAuth app credentials a connector needs from the user
 * (or bundles internally). Drives the Settings UI form: clientId is
 * always shown when needed; clientSecret is conditional. Providers
 * with PKCE-only flows set `needsClientSecret: 'never'`.
 */
export interface CredentialSpec {
  /** True when this connector needs OAuth app credentials at all.
   *  False only for test-echo + future connectors that don't talk to
   *  any external provider. */
  needsCredentials: boolean;
  /** Whether the provider requires a client_secret in addition to the
   *  client_id. `optional` means "if you registered a Web-app type
   *  client, paste the secret; if Desktop/PKCE, leave blank". */
  needsClientSecret: 'required' | 'optional' | 'never';
}

/**
 * Some providers ship long-lived personal API keys that bypass OAuth
 * entirely (Linear's "Personal API keys", Notion's "Internal
 * integration secret", etc.). When a connector declares an
 * `ApiKeyMode`, the Integrations UI offers a second tab next to the
 * OAuth flow where the user pastes a key directly. Useful when the
 * user can't / won't register an OAuth app (no workspace admin
 * access, solo use, etc.).
 */
export interface ApiKeyMode {
  /** Label shown on the tab + the input. e.g. "Personal API Key". */
  label: string;
  /** One-paragraph explanation of where to find the key. */
  helpText: string;
  /** Optional deep link to the provider's key-management page. */
  helpUrl?: string;
  /** Placeholder for the input. e.g. "lin_api_...". */
  placeholder: string;
  /** Validate the key + create an account record. Implementations
   *  typically call the provider's `viewer` / `me` endpoint to confirm
   *  the key works + derive the account id. Throws on bad key. */
  connect(apiKey: string, hooks: ConnectorHooks): Promise<ConnectorAccount>;
}

/**
 * The minimum surface a connector must implement. Phase 1 wires the
 * registry + orchestrator against this shape; phase 2+ ships concrete
 * Slack/Google/Notion/Linear implementations.
 */
export interface Connector {
  readonly id: ConnectorId;
  readonly name: string;
  readonly description: string;
  /** When false, the renderer hides the "Connect" button (kept for
   *  test-echo to look distinct from production providers). */
  readonly builtIn: boolean;
  /** Credential requirements. Connector surface in the Settings UI
   *  reads this to decide whether to render input fields + which ones. */
  readonly credentialSpec: CredentialSpec;
  /** Optional personal-API-key path that sidesteps OAuth entirely.
   *  When present, the renderer offers a second tab in the setup
   *  panel for pasting a key directly. */
  readonly apiKeyMode?: ApiKeyMode;
  /** True when the connector has working credentials — either user-
   *  supplied (Keychain) or the bundled constants in the connector
   *  source. False means "Connect" should be disabled until the user
   *  pastes credentials. */
  hasUsableCredentials(): Promise<boolean>;

  /** Build the auth URL (with PKCE + state) for a new account. The
   *  orchestrator stashes the OAuthRequest under its `state` key and
   *  matches on the callback. Async so connectors can read user-
   *  supplied credentials from Keychain on demand. */
  buildAuthRequest(): Promise<OAuthRequest>;

  /** Exchange the callback code for tokens + identity. Throws on
   *  failure — the orchestrator surfaces the error to the renderer.
   *  Returns the account metadata; the implementation is responsible
   *  for writing tokens to Keychain via the provided setToken hook. */
  completeAuth(
    req: OAuthRequest,
    code: string,
    callbackQuery: URLSearchParams,
    hooks: ConnectorHooks,
  ): Promise<ConnectorAccount>;

  /** Refresh expiring tokens. Resolves to the updated account when
   *  anything changed (new `expiresAt`, new scopes, etc.); `null` for
   *  no-op connectors (long-lived tokens) or when no refresh was
   *  needed. Throws on transient failure (network, 5xx) so the
   *  refresher can count strikes and eventually mark `needsReauth`. */
  refresh(
    account: ConnectorAccount,
    hooks: ConnectorHooks,
  ): Promise<ConnectorAccount | null>;

  /** Materialize the MCP server entries for this account. Phase 1
   *  connectors typically return `{}` until their MCP wiring lands. */
  mcpEntries(account: ConnectorAccount): Record<string, McpServerConfig>;

  /** Tear down. Drop tokens; the orchestrator persists the account
   *  removal separately. Errors are logged, never propagated — the user
   *  doesn't care if the provider's revoke endpoint is down. */
  disconnect(account: ConnectorAccount, hooks: ConnectorHooks): Promise<void>;

  /** Optional one-shot init called by index.ts after the
   *  IntegrationsStore has loaded its accounts at boot. Useful for
   *  connectors that publish stdio MCPs and need to read their
   *  tokens into a sync-accessible cache before mcpEntries() can
   *  return a usable config. SDK-MCP connectors typically don't
   *  need this — their tool callbacks read tokens lazily. */
  init?(
    accounts: ConnectorAccount[],
    hooks: ConnectorHooks,
  ): Promise<void>;
}

/**
 * Capabilities injected into connector methods so they don't reach into
 * the wider electron/main namespace directly. Keeps connectors testable
 * and makes the swap to an aggregator (Nango/Composio) a one-file change.
 */
export interface ConnectorHooks {
  /** Read the previously-stored token payload, if any. */
  getToken(accountId: string): Promise<ConnectorTokenPayload | null>;
  /** Persist a token payload. */
  setToken(accountId: string, payload: ConnectorTokenPayload): Promise<void>;
  /** Drop the token payload. */
  clearToken(accountId: string): Promise<void>;
}

/** Internal: orchestrator tracks pending flows by `state`. */
export interface PendingFlow {
  request: OAuthRequest;
  connectorId: ConnectorId;
  flowId: string;
  startedAt: number;
  resolve: (account: ConnectorAccount) => void;
  reject: (err: Error) => void;
}
