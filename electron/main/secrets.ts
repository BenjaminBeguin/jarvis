import keytar from 'keytar';

const SERVICE = 'app.jarvis';
const ACCOUNT_API_KEY = 'anthropic-api-key';

export async function getAnthropicApiKey(): Promise<string | null> {
  return keytar.getPassword(SERVICE, ACCOUNT_API_KEY);
}

export async function setAnthropicApiKey(value: string): Promise<void> {
  await keytar.setPassword(SERVICE, ACCOUNT_API_KEY, value);
}

export async function clearAnthropicApiKey(): Promise<void> {
  await keytar.deletePassword(SERVICE, ACCOUNT_API_KEY);
}
