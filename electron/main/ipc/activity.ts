import { BrowserWindow, ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type { ActivityEvent } from '@shared/types';

import type { IpcDeps } from './types.js';

/**
 * Activity log IPC. The store is append-only; the renderer reads on
 * mount and subscribes to `activityChanged` for live appends.
 */
export function registerActivityIpc({ activity }: IpcDeps): void {
  ipcMain.handle(IpcChannels.listActivity, (_e, limit?: number) =>
    activity.list(typeof limit === 'number' ? limit : 100),
  );

  activity.on('changed', (event: ActivityEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IpcChannels.activityChanged, event);
    }
  });
}
