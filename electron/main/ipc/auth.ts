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
  clearDeepgramApiKey,
  clearTelegramBotToken,
  getAnthropicApiKey,
  getClaudeCodeOAuthToken,
  getDeepgramApiKey,
  getTelegramBotToken,
  setAnthropicApiKey,
  setClaudeCodeOAuthToken,
  setDeepgramApiKey,
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

  ipcMain.handle(IpcChannels.setDeepgramApiKey, async (_e, value: string) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('Deepgram API key cannot be empty');
    }
    await setDeepgramApiKey(value.trim());
    activity.record({
      kind: 'deepgram.key-set',
      label: 'Deepgram API key saved to Keychain',
    });
  });

  ipcMain.handle(IpcChannels.clearDeepgramApiKey, async () => {
    await clearDeepgramApiKey();
    activity.record({
      kind: 'deepgram.key-cleared',
      label: 'Deepgram API key removed from Keychain',
    });
  });

  ipcMain.handle(IpcChannels.hasDeepgramApiKey, async () => {
    return !!(await getDeepgramApiKey());
  });

  ipcMain.handle(
    IpcChannels.testDeepgram,
    async (): Promise<{
      ok: boolean;
      latencyMs?: number;
      detail?: string;
      provider?: string;
    }> => {
      const key = await getDeepgramApiKey();
      if (!key) {
        return {
          ok: false,
          detail: 'No Deepgram API key set.',
        };
      }
      // Read the current provider so we can flag the case where the
      // key is set but the dropdown is still on "local" — the most
      // common reason "I enabled Deepgram but logs show nothing".
      const { loadModuleSettings } = await import('../auth.js');
      const cfg = loadModuleSettings('voice');
      const provider =
        cfg.transcribeProvider === 'deepgram' ? 'deepgram' : 'local';
      const t0 = Date.now();
      try {
        // /v1/projects is a cheap auth-only ping — confirms the key
        // is recognised without burning a transcription minute.
        const res = await fetch('https://api.deepgram.com/v1/projects', {
          method: 'GET',
          headers: { Authorization: `Token ${key}` },
        });
        const latencyMs = Date.now() - t0;
        if (res.status === 401) {
          return {
            ok: false,
            detail: 'Deepgram rejected the API key (401).',
            provider,
          };
        }
        if (!res.ok) {
          return {
            ok: false,
            detail: `Deepgram returned HTTP ${res.status}.`,
            provider,
          };
        }
        return { ok: true, latencyMs, provider };
      } catch (err) {
        return {
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
          provider,
        };
      }
    },
  );

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
