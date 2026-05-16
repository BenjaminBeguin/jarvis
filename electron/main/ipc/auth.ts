import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type { AuthMode } from '@shared/types';

import { clearAuthMode, saveAuthMode } from '../auth.js';
import {
  clearAnthropicApiKey,
  clearClaudeCodeOAuthToken,
  getAnthropicApiKey,
  getClaudeCodeOAuthToken,
  setAnthropicApiKey,
  setClaudeCodeOAuthToken,
} from '../secrets.js';
import type { IpcDeps } from './types.js';

export function registerAuthIpc({ auth, activity }: IpcDeps): void {
  ipcMain.handle(IpcChannels.appStatus, () => auth.refresh());

  ipcMain.handle(IpcChannels.setApiKey, async (_e, value: string) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('API key cannot be empty');
    }
    await setAnthropicApiKey(value.trim());
    saveAuthMode('api-key');
    activity.record({
      kind: 'auth.api-key-set',
      label: 'API key saved to Keychain',
    });
    await auth.broadcastStatus();
  });

  ipcMain.handle(IpcChannels.clearApiKey, async () => {
    await clearAnthropicApiKey();
    clearAuthMode();
    activity.record({
      kind: 'auth.api-key-cleared',
      label: 'API key removed from Keychain',
    });
    await auth.broadcastStatus();
  });

  ipcMain.handle(IpcChannels.setSubscriptionToken, async (_e, value: string) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('Subscription token cannot be empty');
    }
    await setClaudeCodeOAuthToken(value.trim());
    saveAuthMode('subscription');
    activity.record({
      kind: 'auth.subscription-token-set',
      label: 'Subscription token saved to Keychain',
    });
    await auth.broadcastStatus();
  });

  ipcMain.handle(IpcChannels.clearSubscriptionToken, async () => {
    await clearClaudeCodeOAuthToken();
    clearAuthMode();
    activity.record({
      kind: 'auth.subscription-token-cleared',
      label: 'Subscription token removed from Keychain',
    });
    await auth.broadcastStatus();
  });

  ipcMain.handle(IpcChannels.setAuthMode, async (_e, mode: AuthMode) => {
    if (mode !== 'subscription' && mode !== 'api-key') {
      throw new Error(`Invalid auth mode: ${String(mode)}`);
    }
    if (mode === 'subscription' && !auth.currentBinaryPath()) {
      throw new Error(
        'Claude Code CLI not found. Install it from claude.ai/download or run `claude login`.',
      );
    }
    if (mode === 'subscription' && !(await getClaudeCodeOAuthToken())) {
      throw new Error(
        'Run `claude setup-token` in Terminal, then paste the token here.',
      );
    }
    if (mode === 'api-key' && !(await getAnthropicApiKey())) {
      throw new Error('Add an API key first.');
    }
    saveAuthMode(mode);
    activity.record({
      kind: 'auth.mode-changed',
      label: `Auth mode → ${mode}`,
      detail: { mode },
    });
    await auth.broadcastStatus();
  });
}
