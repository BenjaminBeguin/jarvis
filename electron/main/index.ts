import { app, globalShortcut, ipcMain, Notification } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type {
  AppStatus,
  LaunchTaskRequest,
  TaskEvent,
  TaskSummary,
} from '@shared/types';

import { closeDatabase, getTaskEvents, initDatabase, listRecentTasks } from './db.js';
import {
  clearAnthropicApiKey,
  getAnthropicApiKey,
  setAnthropicApiKey,
} from './secrets.js';
import { asTaskOrigin, TaskRunner } from './task-runner.js';
import { getRunningTasksCount, initTray, setRunningTasksCount } from './tray.js';
import { broadcast, hidePalette, openObservatory, openPalette } from './windows.js';

const runner = new TaskRunner();

async function loadApiKeyIntoEnv(): Promise<boolean> {
  const key = await getAnthropicApiKey();
  if (key) {
    process.env['ANTHROPIC_API_KEY'] = key;
    return true;
  }
  return false;
}

async function buildAppStatus(): Promise<AppStatus> {
  const hasApiKey = !!(await getAnthropicApiKey());
  return { hasApiKey, version: app.getVersion() };
}

function registerIpc(): void {
  ipcMain.handle(IpcChannels.appStatus, () => buildAppStatus());

  ipcMain.handle(IpcChannels.setApiKey, async (_e, value: string) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('API key cannot be empty');
    }
    await setAnthropicApiKey(value.trim());
    process.env['ANTHROPIC_API_KEY'] = value.trim();
    broadcast(IpcChannels.appStatus, await buildAppStatus());
  });

  ipcMain.handle(IpcChannels.clearApiKey, async () => {
    await clearAnthropicApiKey();
    delete process.env['ANTHROPIC_API_KEY'];
    broadcast(IpcChannels.appStatus, await buildAppStatus());
  });

  ipcMain.handle(IpcChannels.openObservatory, () => {
    openObservatory();
  });
  ipcMain.handle(IpcChannels.openPalette, () => {
    openPalette();
  });

  // Phase 0 stub: no skill store yet.
  ipcMain.handle(IpcChannels.listSkills, () => []);
  ipcMain.handle(IpcChannels.refreshSkills, () => []);

  ipcMain.handle(IpcChannels.launchTask, (_e, req: LaunchTaskRequest) => {
    if (!process.env['ANTHROPIC_API_KEY']) {
      throw new Error('Set your Anthropic API key first.');
    }
    const summary = runner.launch({
      ...req,
      origin: asTaskOrigin(req.origin),
    });
    hidePalette();
    openObservatory();
    return summary;
  });

  ipcMain.handle(IpcChannels.abortTask, (_e, taskId: string) =>
    runner.abort(taskId),
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
}

function wireRunnerEvents(): void {
  runner.on('event', (payload: { taskId: string; event: TaskEvent }) => {
    broadcast(IpcChannels.taskEvent, payload);
  });
  runner.on('status', (summary: TaskSummary) => {
    const running = runner.list().filter((t) => t.status === 'running').length;
    setRunningTasksCount(running);
    broadcast(IpcChannels.taskStatus, summary);
    if (summary.status === 'completed' || summary.status === 'errored') {
      try {
        new Notification({
          title:
            summary.status === 'completed'
              ? 'Jarvis · task complete'
              : 'Jarvis · task failed',
          body: summary.title,
          silent: false,
        })
          .on('click', () => openObservatory())
          .show();
      } catch {
        // Notifications can fail on first-launch permission denial; ignore.
      }
    }
  });
}

function registerGlobalShortcut(): void {
  const accelerator = 'CommandOrControl+Shift+J';
  const ok = globalShortcut.register(accelerator, () => openPalette());
  if (!ok) {
    console.warn(`failed to register global shortcut ${accelerator}`);
  }
}

app.setName('Jarvis');

app.whenReady().then(async () => {
  // macOS: keep app alive in tray even when no windows are open.
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  initDatabase();
  await loadApiKeyIntoEnv();
  registerIpc();
  wireRunnerEvents();
  initTray();
  registerGlobalShortcut();

  // Open observatory on first launch (or whenever no API key is configured).
  openObservatory();
});

app.on('window-all-closed', () => {
  // Stay alive in tray.
});

app.on('before-quit', () => {
  runner.abortAll();
  globalShortcut.unregisterAll();
  closeDatabase();
});

app.on('will-quit', () => {
  void getRunningTasksCount;
});
