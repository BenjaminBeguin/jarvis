import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type { LaunchTaskRequest } from '@shared/types';

import { loadCostPrefs, saveCostPrefs } from '../auth.js';
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
  activity,
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

  ipcMain.handle(IpcChannels.abortTask, (_e, taskId: string) => {
    const task = runner.list().find((t) => t.id === taskId);
    const ok = runner.abort(taskId);
    if (ok) {
      activity.record({
        kind: 'task.aborted',
        label: `Task aborted · ${task?.title ?? taskId}`,
        detail: { taskId, title: task?.title, origin: task?.origin },
      });
    }
    return ok;
  });

  ipcMain.handle(IpcChannels.launchShell, (_e, cmd: string) => {
    if (typeof cmd !== 'string' || !cmd.trim()) {
      throw new Error('Empty shell command.');
    }
    return shellRunner.launch(cmd);
  });

  ipcMain.handle(
    IpcChannels.sendTaskMessage,
    (
      _e,
      {
        taskId,
        text,
        images,
      }: {
        taskId: string;
        text: string;
        images?: Array<{ mediaType: string; base64: string }>;
      },
    ) => {
      const safeImages = Array.isArray(images)
        ? images
            .filter(
              (i): i is { mediaType: string; base64: string } =>
                !!i &&
                typeof i.mediaType === 'string' &&
                typeof i.base64 === 'string',
            )
            // Cap at 8 attachments per message — anything more is
            // almost certainly accidental (drag-drop of a folder).
            .slice(0, 8)
        : [];
      return runner.sendMessage(taskId, text, safeImages);
    },
  );

  ipcMain.handle(IpcChannels.listTasks, () => {
    // Always merge live (in-memory) + persisted (SQLite history). Live
    // wins on id collision — it has fresher status / cost / awaiting.
    //
    // The old "if live.length > 0 return live; else SQLite" pattern
    // hid archived tasks the moment any task was active, which broke
    // surfaces that pin a specific task id (Routines history pane,
    // TaskAnswerPreview, etc.) — those would stall on a "loading"
    // status forever because the runner had already aged out the row.
    const live = runner.list();
    const liveIds = new Set(live.map((t) => t.id));
    const persisted = listRecentTasks().filter((t) => !liveIds.has(t.id));
    return [...live, ...persisted];
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

  ipcMain.handle(IpcChannels.costPrefsRead, () => loadCostPrefs());
  ipcMain.handle(
    IpcChannels.costPrefsWrite,
    (
      _e,
      prefs: {
        perTaskUsd: unknown;
        dailyUsd: unknown;
        autoPauseOnDaily?: unknown;
      },
    ) => {
      const perTaskUsd =
        typeof prefs?.perTaskUsd === 'number' && prefs.perTaskUsd >= 0
          ? prefs.perTaskUsd
          : 0;
      const dailyUsd =
        typeof prefs?.dailyUsd === 'number' && prefs.dailyUsd >= 0
          ? prefs.dailyUsd
          : 0;
      const autoPauseOnDaily =
        typeof prefs?.autoPauseOnDaily === 'boolean'
          ? prefs.autoPauseOnDaily
          : false;
      saveCostPrefs({ perTaskUsd, dailyUsd, autoPauseOnDaily });
    },
  );
}
