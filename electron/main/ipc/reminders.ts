import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';

import type { IpcDeps } from './types.js';

export function registerRemindersIpc({ reminders, activity }: IpcDeps): void {
  ipcMain.handle(IpcChannels.listReminders, () => reminders.list());
  ipcMain.handle(IpcChannels.cancelReminder, (_e, id: string) => {
    const before = reminders.list().find((r) => r.id === id);
    const result = reminders.cancel(id);
    if (before) {
      activity.record({
        kind: 'reminder.cancelled',
        label: `Reminder cancelled · ${truncate(before.body, 80)}`,
        detail: { id, body: before.body, mode: before.mode },
      });
    }
    return result;
  });
  ipcMain.handle(IpcChannels.removeReminder, (_e, id: string) =>
    reminders.remove(id),
  );
  ipcMain.handle(IpcChannels.fireReminderNow, (_e, id: string) =>
    reminders.fireNow(id),
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
