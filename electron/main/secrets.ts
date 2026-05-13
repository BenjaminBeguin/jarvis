import keytar from 'keytar';

const SERVICE = 'app.jarvis';
const ACCOUNT_API_KEY = 'anthropic-api-key';
const ACCOUNT_SUBSCRIPTION_TOKEN = 'claude-code-subscription-token';

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
