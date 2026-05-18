import { randomBytes } from 'node:crypto';

import type { ConnectorAccount } from '@shared/types';

import { randomState } from '../pkce.js';
import type {
  Connector,
  ConnectorHooks,
  CredentialSpec,
  OAuthRequest,
} from '../types.js';

/**
 * No-op connector for round-tripping the OAuth machinery without any
 * real provider behind it. The "auth URL" points straight back at our
 * own loopback callback with a fake code already set, so opening it in
 * a browser immediately fires `handleCallback`, which resolves the
 * pending flow and writes a synthetic account + token entry.
 *
 * Useful for:
 *   - verifying the IPC → orchestrator → store → renderer loop
 *   - manual exercise before any real OAuth app is registered
 *   - integration tests later
 *
 * Phase 2 (Google) is the first real connector and replaces nothing
 * about this file — test-echo stays registered so it remains an easy
 * way to poke at the system.
 */
const PROVIDER = 'test-echo';
const CALLBACK_URL = 'http://127.0.0.1:4747/oauth/callback/test-echo';

class TestEchoConnector implements Connector {
  readonly id = 'test-echo' as const;
  readonly name = 'Test Echo';
  readonly description =
    'No-op connector used to verify the OAuth wiring end-to-end without a real provider.';
  readonly builtIn = false;
  readonly credentialSpec: CredentialSpec = {
    needsCredentials: false,
    needsClientSecret: 'never',
  };

  async hasUsableCredentials(): Promise<boolean> {
    return true;
  }

  async buildAuthRequest(): Promise<OAuthRequest> {
    const state = randomState();
    const code = `fake-${randomBytes(8).toString('hex')}`;
    const url = new URL(CALLBACK_URL);
    url.searchParams.set('state', state);
    url.searchParams.set('code', code);
    return {
      authUrl: url.toString(),
      state,
      codeVerifier: 'unused',
      provider: PROVIDER,
    };
  }

  async completeAuth(
    _req: OAuthRequest,
    code: string,
    _query: URLSearchParams,
    hooks: ConnectorHooks,
  ): Promise<ConnectorAccount> {
    const accountId = `test-${randomBytes(4).toString('hex')}`;
    await hooks.setToken(accountId, {
      synthetic: true,
      receivedCode: code,
      issuedAt: Date.now(),
    });
    return {
      id: accountId,
      connectorId: 'test-echo',
      label: accountId,
      addedAt: Date.now(),
      expiresAt: null,
      scopes: [],
      meta: {},
    };
  }

  async refresh(): Promise<null> {
    return null;
  }

  mcpEntries(): Record<string, never> {
    return {};
  }

  async disconnect(): Promise<void> {
    // Nothing to revoke.
  }
}

export const testEchoConnector = new TestEchoConnector();
