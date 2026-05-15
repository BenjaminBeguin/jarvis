import { BrowserWindow, ipcMain, shell } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type { NotificationPrefs } from '@shared/types';

import { loadNotificationPrefs, saveNotificationPrefs } from '../auth.js';
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
export function registerPreferencesIpc({ preferences }: IpcDeps): void {
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
    },
  );
}
