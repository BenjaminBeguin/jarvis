import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';

import { setReducedConversationsCount } from '../tray.js';

/**
 * IPC for the unified conversation sidebar. Currently just the
 * reduced-chip count → tray tooltip pipe so the user sees what's
 * waiting when Jarvis isn't focused. Lives in its own file so the
 * conversation surface can grow without crowding the autopilot
 * handlers next door.
 */

export function registerConversationIpc(): void {
  ipcMain.handle(
    IpcChannels.conversationsSetReducedCount,
    (_e, payload: { count: number }): { ok: boolean } => {
      if (!payload || typeof payload.count !== 'number') {
        return { ok: false };
      }
      setReducedConversationsCount(payload.count);
      return { ok: true };
    },
  );
}
