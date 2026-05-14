import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';

import type { IpcDeps } from './types.js';

export function registerRoutinesIpc({ routines }: IpcDeps): void {
  ipcMain.handle(IpcChannels.listRoutines, () => routines.list());
  ipcMain.handle(IpcChannels.saveRoutine, (_e, input) => routines.save(input));
  ipcMain.handle(IpcChannels.deleteRoutine, (_e, id: string) =>
    routines.remove(id),
  );
  ipcMain.handle(IpcChannels.runRoutineNow, (_e, id: string) =>
    routines.runNow(id),
  );
}
