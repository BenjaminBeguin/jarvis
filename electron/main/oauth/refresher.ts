import type { ConnectorAccount, ConnectorId } from '@shared/types';

import type { IntegrationsStore } from '../integrations-store.js';
import {
  clearConnectorToken,
  getConnectorToken,
  setConnectorToken,
} from '../secrets.js';
import type { ConnectorRegistry } from './connector-registry.js';
import type { ConnectorHooks, ConnectorTokenPayload } from './types.js';

const TICK_INTERVAL_MS = 5 * 60 * 1000;
/** Refresh tokens that expire within this window. Same threshold
 *  Google's docs recommend (and the SDK we use for Anthropic auth). */
const REFRESH_BUFFER_MS = 10 * 60 * 1000;
/** After this many consecutive transient failures we give up and flag
 *  the account `needsReauth: true`. The UI shows a "Reconnect" prompt
 *  next to that row. */
const FAILURE_STRIKEOUT = 3;

/**
 * Periodically renews near-expiry access tokens for every connected
 * account. Connectors with non-expiring tokens (Slack, Notion) are
 * skipped at the `expiresAt == null` check; their `refresh()` is a
 * no-op and we don't even call it.
 *
 * Failures are counted per-account (in-memory). Once an account hits
 * FAILURE_STRIKEOUT, we mark it `needsReauth` in the store and stop
 * retrying until the user re-connects. This avoids hammering Google's
 * revoke endpoint when the user has revoked from their side.
 */
export class TokenRefresher {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly failures = new Map<string, number>();

  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly store: IntegrationsStore,
  ) {}

  start(): void {
    if (this.intervalId) return;
    // First tick fires immediately so freshly-restored sessions
    // (Jarvis just restarted after sleep) get a chance to refresh
    // before any task tries to use the stale token.
    void this.tick();
    this.intervalId = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
  }

  /** Exposed for tests / manual triggering from the integrations IPC
   *  (e.g. when the user manually clicks a "Refresh now" affordance). */
  async runOnce(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const account of this.store.list()) {
      if (account.needsReauth) continue;
      if (account.expiresAt == null) continue;
      if (account.expiresAt - REFRESH_BUFFER_MS > now) continue;
      await this.refreshOne(account);
    }
  }

  private async refreshOne(account: ConnectorAccount): Promise<void> {
    const connector = this.registry.get(account.connectorId);
    if (!connector) {
      // Account is in the store for a connector that's no longer
      // registered (rare — a removed connector during dev). Skip; the
      // user can clean up manually.
      return;
    }
    try {
      const updated = await connector.refresh(account, makeHooks(connector.id));
      if (updated) this.store.upsert(updated);
      this.failures.delete(account.id);
    } catch (err) {
      const count = (this.failures.get(account.id) ?? 0) + 1;
      this.failures.set(account.id, count);
      console.warn(
        `[oauth refresher] ${account.connectorId}/${account.id} ` +
          `refresh failed (${count}/${FAILURE_STRIKEOUT}):`,
        err instanceof Error ? err.message : err,
      );
      if (count >= FAILURE_STRIKEOUT) {
        this.store.update(account.id, { needsReauth: true });
        this.failures.delete(account.id);
      }
    }
  }
}

function makeHooks(connectorId: ConnectorId): ConnectorHooks {
  return {
    async getToken(accountId): Promise<ConnectorTokenPayload | null> {
      const raw = await getConnectorToken(connectorId, accountId);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as ConnectorTokenPayload;
      } catch {
        return null;
      }
    },
    async setToken(accountId, payload): Promise<void> {
      await setConnectorToken(connectorId, accountId, JSON.stringify(payload));
    },
    async clearToken(accountId): Promise<void> {
      await clearConnectorToken(connectorId, accountId);
    },
  };
}
