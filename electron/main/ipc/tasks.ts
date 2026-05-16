import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type { LaunchTaskRequest } from '@shared/types';

import {
  getCostBreakdown,
  getCostSummary,
  getTaskEvents,
  listRecentTasks,
} from '../db.js';
import { asTaskOrigin } from '../task-runner.js';
import type { IpcDeps } from './types.js';

export function registerTasksIpc({
  runner,
  shellRunner,
  auth,
}: IpcDeps): void {
  ipcMain.handle(IpcChannels.launchTask, async (_e, req: LaunchTaskRequest) => {
    const status = await auth.refresh();
    if (!status.authMode) {
      throw new Error('Pick an auth mode first.');
    }
    if (status.authMode === 'api-key' && !status.hasApiKey) {
      throw new Error('Add an API key first.');
    }
    if (status.authMode === 'subscription' && !status.claudeBinaryPath) {
      throw new Error(
        'Claude Code CLI not found. Run `claude login` or switch to API-key mode.',
      );
    }
    if (status.authMode === 'subscription' && !status.hasSubscriptionToken) {
      throw new Error(
        'No subscription token configured. Run `claude setup-token` in a ' +
          'terminal, then paste the token in Setup — or switch to API-key mode.',
      );
    }
    return runner.launch({ ...req, origin: asTaskOrigin(req.origin) });
  });

  ipcMain.handle(IpcChannels.abortTask, (_e, taskId: string) =>
    runner.abort(taskId),
  );

  ipcMain.handle(IpcChannels.launchShell, (_e, cmd: string) => {
    if (typeof cmd !== 'string' || !cmd.trim()) {
      throw new Error('Empty shell command.');
    }
    return shellRunner.launch(cmd);
  });

  ipcMain.handle(
    IpcChannels.sendTaskMessage,
    (_e, { taskId, text }: { taskId: string; text: string }) =>
      runner.sendMessage(taskId, text),
  );

  ipcMain.handle(IpcChannels.listTasks, () => {
    const live = runner.list();
    if (live.length > 0) return live;
    return listRecentTasks();
  });

  ipcMain.handle(IpcChannels.getTaskHistory, (_e, taskId: string) => {
    const live = runner.getEvents(taskId);
    return live.length > 0 ? live : getTaskEvents(taskId);
  });

  ipcMain.handle(IpcChannels.costSummary, () => getCostSummary());
  ipcMain.handle(IpcChannels.costBreakdown, (_e, windowDays: unknown) => {
    // Clamp to a sensible range; default to 7 if the caller didn't say.
    const n =
      typeof windowDays === 'number' && Number.isFinite(windowDays)
        ? Math.max(1, Math.min(90, Math.round(windowDays)))
        : 7;
    return getCostBreakdown(n);
  });
}
