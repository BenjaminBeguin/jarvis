import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';

import type { IpcDeps } from './types.js';

export function registerRemindersIpc({ reminders }: IpcDeps): void {
  ipcMain.handle(IpcChannels.listReminders, () => reminders.list());
  ipcMain.handle(IpcChannels.cancelReminder, (_e, id: string) =>
    reminders.cancel(id),
  );
  ipcMain.handle(IpcChannels.removeReminder, (_e, id: string) =>
    reminders.remove(id),
  );
  ipcMain.handle(IpcChannels.fireReminderNow, (_e, id: string) =>
    reminders.fireNow(id),
  );
}
