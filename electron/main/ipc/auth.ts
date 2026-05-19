import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type { AppMode, AuthMode } from '@shared/types';

import {
  clearAuthMode,
  loadAfkMode,
  loadAppMode,
  loadPaused,
  saveAfkMode,
  saveAppMode,
  saveAuthMode,
  savePaused,
} from '../auth.js';
import {
  clearAnthropicApiKey,
  clearClaudeCodeOAuthToken,
  clearTelegramBotToken,
  getAnthropicApiKey,
  getClaudeCodeOAuthToken,
  getTelegramBotToken,
  setAnthropicApiKey,
  setClaudeCodeOAuthToken,
  setTelegramBotToken,
} from '../secrets.js';
import { refreshTrayMenu } from '../tray.js';
import { broadcast } from '../windows.js';
import type { IpcDeps } from './types.js';

export function registerAuthIpc({ auth, activity, modules }: IpcDeps): void {
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

  ipcMain.handle(IpcChannels.getAfk, () => loadAfkMode());

  ipcMain.handle(IpcChannels.setAfk, (_e, value: unknown) => {
    const next = value === true;
    saveAfkMode(next);
    broadcast(IpcChannels.afkChanged, next);
    refreshTrayMenu();
    activity.record({
      kind: 'afk.toggled',
      label: `AFK mode → ${next ? 'on' : 'off'}`,
      detail: { afk: next },
    });
  });

  ipcMain.handle(IpcChannels.getPaused, () => loadPaused());

  ipcMain.handle(IpcChannels.setPaused, (_e, value: unknown) => {
    const next = value === true;
    // Mirror onto the canonical appMode setter — fires the unified
    // event below.
    setMode(next ? 'paused' : 'running');
  });

  ipcMain.handle(IpcChannels.getAppMode, () => loadAppMode());

  ipcMain.handle(IpcChannels.setAppMode, (_e, value: unknown) => {
    if (value !== 'paused' && value !== 'running' && value !== 'autopilot') {
      throw new Error(`setAppMode: invalid mode "${String(value)}"`);
    }
    setMode(value);
  });

  function setMode(next: AppMode): void {
    const prev = loadAppMode();
    if (prev === next) return;
    saveAppMode(next);
    // Fire BOTH events so legacy consumers (renderer Shell's
    // onPausedChanged subscription) keep working alongside the new
    // appMode-aware ones.
    broadcast(IpcChannels.appModeChanged, next);
    broadcast(IpcChannels.pausedChanged, next === 'paused');
    refreshTrayMenu();
    activity.record({
      kind: 'mode.changed',
      label: `Jarvis ${prev} → ${next}`,
      detail: { from: prev, to: next, source: 'ipc' },
    });
  }

  ipcMain.handle(IpcChannels.setTelegramBotToken, async (_e, value: string) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('Telegram bot token cannot be empty');
    }
    await setTelegramBotToken(value.trim());
    activity.record({
      kind: 'telegram.token-set',
      label: 'Telegram bot token saved to Keychain',
    });
    // Reload the module so onLoad picks up the new token without an
    // app restart. No-op if the module is disabled.
    try {
      await modules.reload('telegram-bot');
    } catch (err) {
      console.warn('[telegram-bot] reload after token-set failed:', err);
    }
  });

  ipcMain.handle(IpcChannels.clearTelegramBotToken, async () => {
    await clearTelegramBotToken();
    activity.record({
      kind: 'telegram.token-cleared',
      label: 'Telegram bot token removed from Keychain',
    });
    try {
      await modules.reload('telegram-bot');
    } catch (err) {
      console.warn('[telegram-bot] reload after token-clear failed:', err);
    }
  });

  ipcMain.handle(IpcChannels.hasTelegramBotToken, async () => {
    return !!(await getTelegramBotToken());
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
