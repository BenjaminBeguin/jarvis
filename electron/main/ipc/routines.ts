import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';

import type { IpcDeps } from './types.js';

export function registerRoutinesIpc({ routines, activity }: IpcDeps): void {
  ipcMain.handle(IpcChannels.listRoutines, () => routines.list());
  ipcMain.handle(IpcChannels.saveRoutine, (_e, input) => {
    const before = routines.list().find((r) => r.id === input?.id);
    const result = routines.save(input);
    if (input && typeof input.id === 'string') {
      activity.record({
        kind: before ? 'routine.updated' : 'routine.created',
        label: before
          ? `Routine updated · ${input.skillId ?? input.id}`
          : `Routine created · ${input.skillId ?? input.id}`,
        detail: {
          routineId: input.id,
          skillId: input.skillId,
          cron: input.cron,
          enabled: input.enabled,
        },
      });
    }
    return result;
  });
  ipcMain.handle(IpcChannels.deleteRoutine, (_e, id: string) => {
    const before = routines.list().find((r) => r.id === id);
    const result = routines.remove(id);
    if (before) {
      activity.record({
        kind: 'routine.deleted',
        label: `Routine deleted · ${before.skillId ?? id}`,
        detail: {
          routineId: id,
          skillId: before.skillId,
          cron: before.cron,
        },
      });
    }
    return result;
  });
  ipcMain.handle(IpcChannels.runRoutineNow, (_e, id: string) => {
    const r = routines.list().find((x) => x.id === id);
    const result = routines.runNow(id);
    if (r) {
      activity.record({
        kind: 'routine.ran-manually',
        label: `Routine fired manually · ${r.skillId ?? id}`,
        detail: { routineId: id, skillId: r.skillId },
      });
    }
    return result;
  });
}
