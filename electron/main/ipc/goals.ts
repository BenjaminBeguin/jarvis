import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type { Goal, GoalProgressEntry, GoalStatus } from '@shared/types';

import type { IpcDeps } from './types.js';

interface CreateGoalInput {
  title: string;
  body?: string;
  deadline?: number | null;
  relatedKeywords?: string[];
  project?: string | null;
}

export function registerGoalsIpc({ goals, activity }: IpcDeps): void {
  ipcMain.handle(IpcChannels.listGoals, (): Goal[] => goals.list());
  ipcMain.handle(IpcChannels.createGoal, (_e, input: CreateGoalInput): Goal => {
    const g = goals.create(input);
    activity.record({
      kind: 'goal.created',
      label: `Goal · ${truncate(g.title, 80)}`,
      detail: {
        id: g.id,
        title: g.title,
        deadline: g.deadline,
        project: g.project ?? null,
      },
    });
    return g;
  });
  ipcMain.handle(
    IpcChannels.appendGoalProgress,
    (_e, id: string, entry: Omit<GoalProgressEntry, 'at'>): Goal | null =>
      goals.appendProgress(id, entry),
  );
  ipcMain.handle(
    IpcChannels.setGoalStatus,
    (_e, id: string, status: GoalStatus): Goal | null => {
      const before = goals.get(id);
      const next = goals.setStatus(id, status);
      if (next && before && before.status !== status) {
        activity.record({
          kind: status === 'done' ? 'goal.done' : 'goal.status',
          label:
            status === 'done'
              ? `Goal done · ${truncate(next.title, 80)}`
              : `Goal ${status} · ${truncate(next.title, 80)}`,
          detail: { id, title: next.title, status },
        });
      }
      return next;
    },
  );
  ipcMain.handle(IpcChannels.removeGoal, (_e, id: string): boolean =>
    goals.remove(id),
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
