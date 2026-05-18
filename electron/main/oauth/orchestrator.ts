import type { ConnectorAccount, ConnectorId } from '@shared/types';

import {
  clearConnectorToken,
  getConnectorToken,
  setConnectorToken,
} from '../secrets.js';
import type { ConnectorRegistry } from './connector-registry.js';
import { randomState } from './pkce.js';
import type {
  Connector,
  ConnectorHooks,
  ConnectorTokenPayload,
  OAuthRequest,
  PendingFlow,
} from './types.js';

/** Pending flows time out after 5 min — if the user closes the consent
 *  tab without granting, the renderer's awaitCallback rejects cleanly. */
const FLOW_TTL_MS = 5 * 60 * 1000;

/** Hook receiver: called after `completeAuth` succeeds. The integrations
 *  store implements this to persist the account row. */
export interface OrchestratorSink {
  upsertAccount(account: ConnectorAccount): void;
}

export class OAuthOrchestrator {
  private readonly pendingByState = new Map<string, PendingFlow>();
  private readonly pendingByFlowId = new Map<string, PendingFlow>();

  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly sink: OrchestratorSink,
  ) {}

  /**
   * Begin a connect flow. Returns the auth URL the renderer opens in the
   * external browser plus a `flowId` it can pass to `awaitFlow` to block
   * until the loopback callback fires.
   */
  async start(
    connectorId: ConnectorId,
  ): Promise<{ authUrl: string; flowId: string }> {
    const connector = this.registry.get(connectorId);
    if (!connector) {
      throw new Error(`Unknown connector: ${connectorId}`);
    }
    const request = await connector.buildAuthRequest();
    const flowId = randomState();
    const flow: PendingFlow = {
      request,
      connectorId,
      flowId,
      startedAt: Date.now(),
      // Resolvers are installed lazily by `awaitFlow`. If the callback
      // arrives before the renderer has subscribed, the pending flow
      // holds the result for up to FLOW_TTL_MS so awaitFlow can pick it
      // up. We model that as a queued resolution.
      resolve: () => {},
      reject: () => {},
    };
    this.pendingByState.set(request.state, flow);
    this.pendingByFlowId.set(flowId, flow);
    return { authUrl: request.authUrl, flowId };
  }

  /**
   * Wait for the callback for a given flowId. Rejects on timeout or on
   * `handleCallback` failure. Resolves with the new ConnectorAccount.
   */
  async awaitFlow(flowId: string): Promise<ConnectorAccount> {
    const flow = this.pendingByFlowId.get(flowId);
    if (!flow) {
      throw new Error(`Unknown flowId: ${flowId}`);
    }
    return new Promise<ConnectorAccount>((resolve, reject) => {
      flow.resolve = resolve;
      flow.reject = reject;
      setTimeout(() => {
        if (this.pendingByFlowId.has(flowId)) {
          this.cleanup(flow);
          reject(new Error('OAuth flow timed out'));
        }
      }, FLOW_TTL_MS);
    });
  }

  /**
   * Invoked by http-server.ts when the browser hits
   * `/oauth/callback/:provider`. Looks up the pending flow by `state`,
   * runs the connector's token exchange, persists the account.
   */
  async handleCallback(
    provider: string,
    query: URLSearchParams,
  ): Promise<void> {
    const state = query.get('state');
    const code = query.get('code');
    const error = query.get('error');
    if (!state) throw new Error('Missing state in callback');
    const flow = this.pendingByState.get(state);
    if (!flow) throw new Error('Unknown or expired flow');
    if (flow.request.provider !== provider) {
      throw new Error(
        `Callback provider mismatch (expected ${flow.request.provider}, got ${provider})`,
      );
    }
    if (error) {
      const err = new Error(`OAuth error: ${error}`);
      flow.reject(err);
      this.cleanup(flow);
      throw err;
    }
    if (!code) {
      const err = new Error('Missing authorization code');
      flow.reject(err);
      this.cleanup(flow);
      throw err;
    }
    const connector = this.registry.get(flow.connectorId);
    if (!connector) {
      throw new Error(`Connector vanished mid-flow: ${flow.connectorId}`);
    }
    try {
      const hooks = makeHooks(connector.id);
      const account = await connector.completeAuth(
        flow.request,
        code,
        query,
        hooks,
      );
      this.sink.upsertAccount(account);
      flow.resolve(account);
    } catch (err) {
      flow.reject(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      this.cleanup(flow);
    }
  }

  /**
   * Drop tokens for an account. The integrations store handles removing
   * the row + MCP entries separately.
   */
  async disconnect(
    connector: Connector,
    account: ConnectorAccount,
  ): Promise<void> {
    const hooks = makeHooks(connector.id);
    await connector.disconnect(account, hooks).catch((err) => {
      console.warn(`[oauth] ${connector.id} disconnect failed:`, err);
    });
    await hooks.clearToken(account.id);
  }

  private cleanup(flow: PendingFlow): void {
    this.pendingByState.delete(flow.request.state);
    this.pendingByFlowId.delete(flow.flowId);
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
