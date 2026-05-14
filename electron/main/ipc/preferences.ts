import { ipcMain, shell } from 'electron';

import { IpcChannels } from '@shared/ipc';

import type { IpcDeps } from './types.js';

/**
 * User preferences = the markdown file at `~/.jarvis/preferences.md` that
 * gets prepended to every task's system prompt. The renderer reads + writes
 * it via this channel; the store handles caching + chokidar.
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
}
