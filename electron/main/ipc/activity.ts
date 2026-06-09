import { BrowserWindow, ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type { ActivityEvent } from '@shared/types';

import {
  onBrowserActivity,
  readRecentActivity,
  type BrowserActivityEvent,
} from '../browser-activity.js';
import type { IpcDeps } from './types.js';

/**
 * Activity log IPC. The store is append-only; the renderer reads on
 * mount and subscribes to `activityChanged` for live appends.
 *
 * Browser activity is a separate, RAM-only stream (see browser-activity.ts).
 * It's merged into the Activity tab view in the renderer.
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

  // RAM-only browser ring buffer — surfaced to the renderer for the
  // Activity feed merge. Same window the context provider uses (1h
  // rolling), so the agent and the UI see the same set of pages.
  ipcMain.handle(IpcChannels.listBrowserActivity, () => readRecentActivity());

  onBrowserActivity((event: BrowserActivityEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IpcChannels.browserActivityChanged, event);
    }
  });
}
