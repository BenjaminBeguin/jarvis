import { BrowserWindow, ipcMain, shell } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type { InboxPrefs, NotificationPrefs } from '@shared/types';

import {
  loadInboxPrefs,
  loadNotificationPrefs,
  loadSpeedBias,
  loadVoiceAlwaysSpeak,
  saveInboxPrefs,
  saveNotificationPrefs,
  saveSpeedBias,
  saveVoiceAlwaysSpeak,
} from '../auth.js';
import { asSpeedBias } from '../model-tiers.js';
import type { IpcDeps } from './types.js';

/**
 * User preferences = the markdown file at `~/.jarvis/preferences.md` that
 * gets prepended to every task's system prompt. The renderer reads + writes
 * it via this channel; the store handles caching + chokidar.
 *
 * Notification prefs (config.json) ride on the same registrar since they
 * sit in the same Settings tab — one IPC file for "everything you tweak
 * in Preferences-flavoured panels."
 */
export function registerPreferencesIpc({ preferences, activity }: IpcDeps): void {
  ipcMain.handle(IpcChannels.readPreferences, () => ({
    path: preferences.path,
    contents: preferences.read(),
  }));

  ipcMain.handle(
    IpcChannels.writePreferences,
    (_e, contents: string) => {
      if (typeof contents !== 'string') {
        throw new Error('preferences contents must be a string');
      }
      preferences.write(contents);
      activity.record({
        kind: 'preferences.edited',
        label: `Preferences edited · ${contents.length} bytes`,
        detail: { bytes: contents.length },
      });
    },
  );

  ipcMain.handle(IpcChannels.revealPreferences, () => {
    shell.showItemInFolder(preferences.path);
  });

  ipcMain.handle(IpcChannels.readNotificationPrefs, () =>
    loadNotificationPrefs(),
  );

  ipcMain.handle(
    IpcChannels.writeNotificationPrefs,
    (_e, prefs: NotificationPrefs) => {
      saveNotificationPrefs(prefs);
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IpcChannels.notificationPrefsChanged, prefs);
      }
      activity.record({
        kind: 'notification-prefs.changed',
        label: `Notification prefs · on-ask=${prefs.onAsk} · on-launch=${prefs.onLaunch}`,
        detail: prefs,
      });
    },
  );

  ipcMain.handle(IpcChannels.readSpeedBias, () => loadSpeedBias());

  ipcMain.handle(
    IpcChannels.writeSpeedBias,
    (_e, raw: unknown) => {
      const next = asSpeedBias(raw);
      saveSpeedBias(next);
      activity.record({
        kind: 'speed-bias.changed',
        label: `Speed bias · ${next}`,
        detail: { speedBias: next },
      });
      return next;
    },
  );

  ipcMain.handle(IpcChannels.readVoiceAlwaysSpeak, () =>
    loadVoiceAlwaysSpeak(),
  );
  ipcMain.handle(
    IpcChannels.writeVoiceAlwaysSpeak,
    (_e, value: unknown) => {
      const next = value === true;
      saveVoiceAlwaysSpeak(next);
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IpcChannels.readVoiceAlwaysSpeak, next);
      }
      activity.record({
        kind: 'voice.always-speak.changed',
        label: `Always read aloud · ${next ? 'on' : 'off'}`,
        detail: { value: next },
      });
      return next;
    },
  );

  ipcMain.handle(IpcChannels.readInboxPrefs, () => loadInboxPrefs());
  ipcMain.handle(
    IpcChannels.writeInboxPrefs,
    (_e, prefs: InboxPrefs) => {
      saveInboxPrefs(prefs);
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IpcChannels.inboxPrefsChanged, prefs);
      }
      activity.record({
        kind: 'inbox-prefs.changed',
        label: `Inbox prefs changed`,
        detail: prefs,
      });
    },
  );
}
