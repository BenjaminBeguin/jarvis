import { ipcMain, shell } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type {
  ConnectorAccount,
  ConnectorId,
  ConnectorSummary,
} from '@shared/types';

import type { ActivityStore } from '../activity-store.js';
import type { IntegrationsStore } from '../integrations-store.js';
import type { ConnectorRegistry } from '../oauth/connector-registry.js';
import type { OAuthOrchestrator } from '../oauth/orchestrator.js';
import type { ConnectorHooks, ConnectorTokenPayload } from '../oauth/types.js';
import {
  clearConnectorCredentials,
  clearConnectorToken,
  getConnectorToken,
  setConnectorCredentials,
  setConnectorToken,
} from '../secrets.js';

export interface IntegrationsIpcDeps {
  integrations: IntegrationsStore;
  registry: ConnectorRegistry;
  orchestrator: OAuthOrchestrator;
  activity: ActivityStore;
}

export function registerIntegrationsIpc(deps: IntegrationsIpcDeps): void {
  const { integrations, registry, orchestrator, activity } = deps;

  ipcMain.handle(
    IpcChannels.listIntegrations,
    async (): Promise<ConnectorSummary[]> => {
      const accounts = integrations.list();
      return Promise.all(
        registry.list().map(async (connector) => ({
          id: connector.id,
          name: connector.name,
          description: connector.description,
          builtIn: connector.builtIn,
          accounts: accounts.filter((a) => a.connectorId === connector.id),
          defaultAccountId: integrations.defaultFor(connector.id),
          credentialSpec: {
            needsCredentials: connector.credentialSpec.needsCredentials,
            needsClientSecret: connector.credentialSpec.needsClientSecret,
          },
          credentialsConfigured: connector.credentialSpec.needsCredentials
            ? await connector.hasUsableCredentials()
            : true,
          ...(connector.apiKeyMode
            ? {
                apiKeyMode: {
                  label: connector.apiKeyMode.label,
                  helpText: connector.apiKeyMode.helpText,
                  ...(connector.apiKeyMode.helpUrl
                    ? { helpUrl: connector.apiKeyMode.helpUrl }
                    : {}),
                  placeholder: connector.apiKeyMode.placeholder,
                },
              }
            : {}),
        })),
      );
    },
  );

  ipcMain.handle(
    IpcChannels.connectIntegration,
    async (
      _e,
      payload: { connectorId: ConnectorId },
    ): Promise<{
      ok: boolean;
      flowId?: string;
      authUrl?: string;
      message?: string;
    }> => {
      try {
        if (!payload || typeof payload.connectorId !== 'string') {
          return { ok: false, message: 'Invalid connectorId' };
        }
        const { authUrl, flowId } = await orchestrator.start(
          payload.connectorId,
        );
        // Open the consent URL in the user's default browser. The
        // loopback callback fires once they grant.
        void shell.openExternal(authUrl);
        return { ok: true, authUrl, flowId };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.cancelIntegrationFlow,
    (
      _e,
      payload: { flowId: string },
    ): { ok: boolean; message?: string } => {
      if (!payload || typeof payload.flowId !== 'string') {
        return { ok: false, message: 'Invalid flowId' };
      }
      const cancelled = orchestrator.cancelFlow(payload.flowId);
      return cancelled
        ? { ok: true }
        : { ok: false, message: 'Flow not found (already completed?)' };
    },
  );

  ipcMain.handle(
    IpcChannels.awaitIntegrationCallback,
    async (
      _e,
      payload: { flowId: string },
    ): Promise<{ ok: boolean; account?: ConnectorAccount; message?: string }> => {
      try {
        if (!payload || typeof payload.flowId !== 'string') {
          return { ok: false, message: 'Invalid flowId' };
        }
        const account = await orchestrator.awaitFlow(payload.flowId);
        activity.record({
          kind: 'integration.connected',
          label: `${account.connectorId} connected · ${account.label}`,
          detail: {
            connectorId: account.connectorId,
            accountId: account.id,
            via: 'oauth',
          },
        });
        return { ok: true, account };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.disconnectIntegration,
    async (
      _e,
      payload: { accountId: string },
    ): Promise<{ ok: boolean; message?: string }> => {
      try {
        if (!payload || typeof payload.accountId !== 'string') {
          return { ok: false, message: 'Invalid accountId' };
        }
        const account = integrations.get(payload.accountId);
        if (!account) return { ok: false, message: 'Account not found' };
        const connector = registry.get(account.connectorId);
        if (connector) {
          await orchestrator.disconnect(connector, account);
        }
        integrations.remove(account.id);
        activity.record({
          kind: 'integration.disconnected',
          label: `${account.connectorId} disconnected · ${account.label}`,
          detail: {
            connectorId: account.connectorId,
            accountId: account.id,
          },
        });
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.testIntegrationAccount,
    async (
      _e,
      payload: { accountId: string },
    ): Promise<{ ok: boolean; summary?: string; message?: string }> => {
      if (!payload || typeof payload.accountId !== 'string') {
        return { ok: false, message: 'Invalid accountId' };
      }
      const account = integrations.get(payload.accountId);
      if (!account) return { ok: false, message: 'Account not found' };
      const connector = registry.get(account.connectorId);
      if (!connector) return { ok: false, message: 'Unknown connector' };
      if (!connector.test) {
        return {
          ok: false,
          message: 'This connector does not expose a test endpoint',
        };
      }
      const hooks = makeApiKeyHooks(account.connectorId);
      const result = await connector.test(account, hooks);
      activity.record({
        kind: result.ok ? 'integration.test-ok' : 'integration.test-failed',
        label: result.ok
          ? `${account.connectorId} test · ${result.summary}`
          : `${account.connectorId} test failed · ${result.message}`,
        detail: {
          connectorId: account.connectorId,
          accountId: account.id,
          ...(result.ok
            ? { summary: result.summary }
            : { error: result.message }),
        },
      });
      return result.ok
        ? { ok: true, summary: result.summary }
        : { ok: false, message: result.message };
    },
  );

  ipcMain.handle(
    IpcChannels.setIntegrationAccountMeta,
    (
      _e,
      payload: { accountId: string; patch: Partial<ConnectorAccount> },
    ): { ok: boolean; message?: string } => {
      if (
        !payload ||
        typeof payload.accountId !== 'string' ||
        !payload.patch ||
        typeof payload.patch !== 'object'
      ) {
        return { ok: false, message: 'Invalid payload' };
      }
      // The renderer is only allowed to update `meta` and `label`
      // through this channel — never tokens, scopes, expiresAt, or id.
      const safePatch: Partial<ConnectorAccount> = {};
      if ('label' in payload.patch && typeof payload.patch.label === 'string') {
        safePatch.label = payload.patch.label;
      }
      if ('meta' in payload.patch && typeof payload.patch.meta === 'object') {
        // Merge with the existing meta so a single-key partial update
        // (e.g. `{ sendAs: 'user' }`) doesn't blow away the other keys
        // the connector populated at connect time (teamId, email, …).
        const existing = integrations.get(payload.accountId);
        if (!existing) return { ok: false, message: 'Account not found' };
        safePatch.meta = {
          ...existing.meta,
          ...(payload.patch.meta as Record<string, unknown>),
        };
      }
      const ok = integrations.update(payload.accountId, safePatch);
      return ok ? { ok: true } : { ok: false, message: 'Account not found' };
    },
  );

  ipcMain.handle(
    IpcChannels.setIntegrationDefault,
    (
      _e,
      payload: { connectorId: ConnectorId; accountId: string | null },
    ): { ok: boolean; message?: string } => {
      if (
        !payload ||
        typeof payload.connectorId !== 'string' ||
        (payload.accountId !== null && typeof payload.accountId !== 'string')
      ) {
        return { ok: false, message: 'Invalid payload' };
      }
      const ok = integrations.setDefault(
        payload.connectorId,
        payload.accountId,
      );
      return ok
        ? { ok: true }
        : { ok: false, message: 'No change (already that default)' };
    },
  );

  ipcMain.handle(
    IpcChannels.setIntegrationCredentials,
    async (
      _e,
      payload: {
        connectorId: ConnectorId;
        clientId: string;
        clientSecret?: string;
      },
    ): Promise<{ ok: boolean; message?: string }> => {
      try {
        if (
          !payload ||
          typeof payload.connectorId !== 'string' ||
          typeof payload.clientId !== 'string' ||
          payload.clientId.trim().length === 0
        ) {
          return { ok: false, message: 'clientId is required' };
        }
        const connector = registry.get(payload.connectorId);
        if (!connector) return { ok: false, message: 'Unknown connector' };
        if (
          connector.credentialSpec.needsClientSecret === 'required' &&
          !payload.clientSecret?.trim()
        ) {
          return {
            ok: false,
            message: 'clientSecret is required for this connector',
          };
        }
        await setConnectorCredentials(payload.connectorId, {
          clientId: payload.clientId.trim(),
          clientSecret:
            payload.clientSecret && payload.clientSecret.trim().length > 0
              ? payload.clientSecret.trim()
              : undefined,
        });
        activity.record({
          kind: 'integration.credentials-set',
          label: `Credentials set · ${payload.connectorId}`,
          detail: { connectorId: payload.connectorId },
        });
        // Trigger a renderer refresh so credentialsConfigured flips.
        integrations.emit('changed');
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.connectIntegrationByApiKey,
    async (
      _e,
      payload: { connectorId: ConnectorId; apiKey: string },
    ): Promise<{ ok: boolean; account?: ConnectorAccount; message?: string }> => {
      try {
        if (
          !payload ||
          typeof payload.connectorId !== 'string' ||
          typeof payload.apiKey !== 'string' ||
          payload.apiKey.trim().length === 0
        ) {
          return { ok: false, message: 'apiKey is required' };
        }
        const connector = registry.get(payload.connectorId);
        if (!connector) return { ok: false, message: 'Unknown connector' };
        if (!connector.apiKeyMode) {
          return {
            ok: false,
            message: 'This connector does not support API-key auth',
          };
        }
        const hooks = makeApiKeyHooks(payload.connectorId);
        const account = await connector.apiKeyMode.connect(
          payload.apiKey.trim(),
          hooks,
        );
        integrations.upsert(account);
        activity.record({
          kind: 'integration.connected',
          label: `${account.connectorId} connected · ${account.label}`,
          detail: {
            connectorId: account.connectorId,
            accountId: account.id,
            via: 'api-key',
          },
        });
        return { ok: true, account };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.clearIntegrationCredentials,
    async (
      _e,
      payload: { connectorId: ConnectorId },
    ): Promise<{ ok: boolean; message?: string }> => {
      try {
        if (!payload || typeof payload.connectorId !== 'string') {
          return { ok: false, message: 'Invalid connectorId' };
        }
        await clearConnectorCredentials(payload.connectorId);
        activity.record({
          kind: 'integration.credentials-cleared',
          label: `Credentials cleared · ${payload.connectorId}`,
          detail: { connectorId: payload.connectorId },
        });
        integrations.emit('changed');
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}

/** Minimal hooks injected into a connector's API-key connect path.
 *  Same shape the orchestrator builds for OAuth callbacks. */
function makeApiKeyHooks(connectorId: string): ConnectorHooks {
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
