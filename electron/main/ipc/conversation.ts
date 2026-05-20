import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';

import type { TaskStatus } from '@shared/types';

import {
  setPinnedConversations,
  setReducedConversationsCount,
  type PinnedConversationEntry,
} from '../tray.js';

/**
 * IPC for the unified conversation sidebar. Two pipes today:
 *   - reduced-chip count → tray tooltip ("💬 N reduced")
 *   - pinned list → tray context menu so the user can jump back to
 *     anything they pinned without bringing Jarvis forward first.
 *
 * Lives in its own file so the conversation surface can grow
 * without crowding the autopilot handlers next door.
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

  ipcMain.handle(
    IpcChannels.conversationsSetPinned,
    (
      _e,
      payload: { entries: PinnedConversationEntry[] },
    ): { ok: boolean } => {
      if (!payload || !Array.isArray(payload.entries)) {
        return { ok: false };
      }
      const validStatuses: TaskStatus[] = [
        'queued',
        'running',
        'completed',
        'aborted',
        'errored',
      ];
      const sanitized = payload.entries
        .filter(
          (e): e is PinnedConversationEntry =>
            !!e &&
            typeof e.taskId === 'string' &&
            typeof e.title === 'string' &&
            validStatuses.includes(e.status as TaskStatus) &&
            typeof e.reduced === 'boolean',
        )
        .slice(0, 32);
      setPinnedConversations(sanitized);
      return { ok: true };
    },
  );
}
