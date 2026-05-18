import { randomBytes } from 'node:crypto';

import keytar from 'keytar';

const SERVICE = 'app.jarvis';
const ACCOUNT_API_KEY = 'anthropic-api-key';
const ACCOUNT_SUBSCRIPTION_TOKEN = 'claude-code-subscription-token';
const ACCOUNT_HTTP_API_TOKEN = 'jarvis-http-api-token';
const ACCOUNT_TELEGRAM_BOT_TOKEN = 'telegram-bot-token';

export async function getAnthropicApiKey(): Promise<string | null> {
  return keytar.getPassword(SERVICE, ACCOUNT_API_KEY);
}

export async function setAnthropicApiKey(value: string): Promise<void> {
  await keytar.setPassword(SERVICE, ACCOUNT_API_KEY, value);
}

export async function clearAnthropicApiKey(): Promise<void> {
  await keytar.deletePassword(SERVICE, ACCOUNT_API_KEY);
}

/**
 * Long-lived "setup token" the user generated with `claude setup-token`.
 * Stored in our own Keychain item. Injected as CLAUDE_CODE_OAUTH_TOKEN when
 * Jarvis spawns the claude binary in subscription mode. This is the
 * Anthropic-blessed path for programmatic auth — Claude Code's own Keychain
 * OAuth state is short-lived (access tokens expire in hours/days) and
 * tied to the original requester, so reading it from Electron doesn't work.
 */
export async function getClaudeCodeOAuthToken(): Promise<string | null> {
  return keytar.getPassword(SERVICE, ACCOUNT_SUBSCRIPTION_TOKEN);
}

export async function setClaudeCodeOAuthToken(value: string): Promise<void> {
  await keytar.setPassword(SERVICE, ACCOUNT_SUBSCRIPTION_TOKEN, value);
}

export async function clearClaudeCodeOAuthToken(): Promise<void> {
  await keytar.deletePassword(SERVICE, ACCOUNT_SUBSCRIPTION_TOKEN);
}

/**
 * Bearer token for the localhost HTTP API. Auto-generated on first
 * launch and persisted in Keychain. Required on every API request as
 * `Authorization: Bearer <token>`. The user copies it from Settings →
 * API to paste into Shortcuts / scripts / future phone clients.
 */
export async function getOrCreateHttpApiToken(): Promise<string> {
  const existing = await keytar.getPassword(SERVICE, ACCOUNT_HTTP_API_TOKEN);
  if (existing) return existing;
  const fresh = randomBytes(32).toString('hex');
  await keytar.setPassword(SERVICE, ACCOUNT_HTTP_API_TOKEN, fresh);
  return fresh;
}

export async function rotateHttpApiToken(): Promise<string> {
  const fresh = randomBytes(32).toString('hex');
  await keytar.setPassword(SERVICE, ACCOUNT_HTTP_API_TOKEN, fresh);
  return fresh;
}

/**
 * Telegram bot token from BotFather. Set via the Settings → Modules →
 * Telegram bot panel (the renderer never reads the token itself; it only
 * triggers writes through the dedicated IPC channel so the value never
 * lives in any in-memory renderer store or config.json).
 */
export async function getTelegramBotToken(): Promise<string | null> {
  return keytar.getPassword(SERVICE, ACCOUNT_TELEGRAM_BOT_TOKEN);
}

export async function setTelegramBotToken(value: string): Promise<void> {
  await keytar.setPassword(SERVICE, ACCOUNT_TELEGRAM_BOT_TOKEN, value);
}

export async function clearTelegramBotToken(): Promise<void> {
  await keytar.deletePassword(SERVICE, ACCOUNT_TELEGRAM_BOT_TOKEN);
}

/**
 * OAuth integrations — one Keychain entry per connected account. The
 * payload is JSON encoded: connectors define their own shape (Slack
 * stores bot + user tokens, Google stores access + refresh + expiresAt,
 * etc.). Tokens never cross IPC; the renderer only ever sees account
 * metadata via integrations.json.
 *
 * Account name format: `connector-<connectorId>-<accountId>`.
 */
function connectorAccount(connectorId: string, accountId: string): string {
  return `connector-${connectorId}-${accountId}`;
}

export async function getConnectorToken(
  connectorId: string,
  accountId: string,
): Promise<string | null> {
  return keytar.getPassword(SERVICE, connectorAccount(connectorId, accountId));
}

export async function setConnectorToken(
  connectorId: string,
  accountId: string,
  payload: string,
): Promise<void> {
  await keytar.setPassword(
    SERVICE,
    connectorAccount(connectorId, accountId),
    payload,
  );
}

export async function clearConnectorToken(
  connectorId: string,
  accountId: string,
): Promise<void> {
  await keytar.deletePassword(
    SERVICE,
    connectorAccount(connectorId, accountId),
  );
}

/**
 * Per-connector OAuth app credentials (client_id + optional secret).
 * Lets users paste their own provider credentials at runtime instead
 * of editing the bundled constants in the connector source. Connectors
 * still ship with constant fallbacks for the dev path, but when a
 * Keychain payload exists it takes precedence.
 *
 * Account name: `connector-creds-<connectorId>`. Payload JSON:
 *   { clientId: string, clientSecret?: string }
 */
export interface ConnectorCredentials {
  clientId: string;
  clientSecret?: string;
}

function connectorCredsAccount(connectorId: string): string {
  return `connector-creds-${connectorId}`;
}

export async function getConnectorCredentials(
  connectorId: string,
): Promise<ConnectorCredentials | null> {
  const raw = await keytar.getPassword(
    SERVICE,
    connectorCredsAccount(connectorId),
  );
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ConnectorCredentials;
    if (!parsed.clientId || typeof parsed.clientId !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function setConnectorCredentials(
  connectorId: string,
  creds: ConnectorCredentials,
): Promise<void> {
  await keytar.setPassword(
    SERVICE,
    connectorCredsAccount(connectorId),
    JSON.stringify({
      clientId: creds.clientId,
      ...(creds.clientSecret ? { clientSecret: creds.clientSecret } : {}),
    }),
  );
}

export async function clearConnectorCredentials(
  connectorId: string,
): Promise<void> {
  await keytar.deletePassword(SERVICE, connectorCredsAccount(connectorId));
}
