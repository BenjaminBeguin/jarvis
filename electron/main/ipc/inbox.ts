import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';

import type { IpcDeps } from './types.js';

/**
 * Inbox IPC: list (cheap, returns cached items) + refresh (re-runs every
 * source). Renderer fetches on tab open + on a manual refresh button.
 * Broadcasts `inbox:changed` whenever items update, `inbox:refreshing`
 * with bool so the spinner can fire from any window.
 */
export function registerInboxIpc({ inbox }: IpcDeps): void {
  ipcMain.handle(IpcChannels.listInbox, () => inbox.list());
  ipcMain.handle(IpcChannels.refreshInbox, () => inbox.refresh());
}
