import { app, globalShortcut, ipcMain, Notification } from 'electron';
import {
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize, relative, resolve } from 'node:path';

import { IpcChannels } from '@shared/ipc';
import type {
  AppStatus,
  AuthMode,
  DispatchIntentResult,
  JarvisFileEntry,
  LaunchTaskRequest,
  TaskEvent,
  TaskSummary,
} from '@shared/types';

import {
  clearAuthMode,
  detectClaudeBinary,
  loadAuthMode,
  saveAuthMode,
} from './auth.js';
import { closeDatabase, getTaskEvents, initDatabase, listRecentTasks } from './db.js';
import { McpConfigStore } from './mcp-config.js';
import { ModuleRegistry } from './module-registry.js';
import { claudeCodeWatchModule } from './modules/claude-code-watch.js';
import { quickNoteModule } from './modules/quick-note.js';
import { RoutineStore } from './routines.js';
import { seedDefaultsIfEmpty } from './seed.js';
import {
  clearAnthropicApiKey,
  getAnthropicApiKey,
  setAnthropicApiKey,
} from './secrets.js';
import { SkillStore } from './skill-store.js';
import { asTaskOrigin, TaskRunner } from './task-runner.js';
import { getRunningTasksCount, initTray, setRunningTasksCount } from './tray.js';
import { broadcast, hidePalette, openObservatory, openPalette } from './windows.js';

const skills = new SkillStore();
const mcp = new McpConfigStore();
const runner = new TaskRunner();
const routines = new RoutineStore();
const modules = new ModuleRegistry();
runner.setSkillStore(skills);
runner.setMcpStore(mcp);
routines.setRunner(runner);

let claudeBinaryPath: string | null = null;

async function refreshAuth(): Promise<AppStatus> {
  const apiKey = await getAnthropicApiKey();
  const hasApiKey = !!apiKey;
  claudeBinaryPath = detectClaudeBinary();
  let mode = loadAuthMode();
  // Auto-pick: subscription if the user's claude CLI is logged in,
  // else api-key if they've configured one, else null (show Setup).
  if (!mode) {
    if (claudeBinaryPath) mode = 'subscription';
    else if (hasApiKey) mode = 'api-key';
  }
  // If they picked subscription but the binary disappeared, fall back.
  if (mode === 'subscription' && !claudeBinaryPath && hasApiKey) {
    mode = 'api-key';
  }
  // Never leave a stale API key in the env for subscription mode — the SDK
  // would otherwise prefer it over OAuth.
  if (mode === 'subscription') delete process.env['ANTHROPIC_API_KEY'];
  else if (mode === 'api-key' && apiKey) process.env['ANTHROPIC_API_KEY'] = apiKey;

  runner.setAuth({
    mode: mode ?? 'subscription',
    apiKey: apiKey ?? null,
    claudeBinaryPath,
  });

  return {
    authMode: mode,
    hasApiKey,
    claudeBinaryPath,
    version: app.getVersion(),
  };
}

async function broadcastStatus(): Promise<AppStatus> {
  const status = await refreshAuth();
  broadcast(IpcChannels.appStatus, status);
  return status;
}

function registerIpc(): void {
  ipcMain.handle(IpcChannels.appStatus, () => refreshAuth());

  ipcMain.handle(IpcChannels.setApiKey, async (_e, value: string) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('API key cannot be empty');
    }
    await setAnthropicApiKey(value.trim());
    saveAuthMode('api-key');
    await broadcastStatus();
  });

  ipcMain.handle(IpcChannels.clearApiKey, async () => {
    await clearAnthropicApiKey();
    // Drop their explicit api-key preference; refreshAuth will fall back.
    clearAuthMode();
    await broadcastStatus();
  });

  ipcMain.handle(IpcChannels.setAuthMode, async (_e, mode: AuthMode) => {
    if (mode !== 'subscription' && mode !== 'api-key') {
      throw new Error(`Invalid auth mode: ${String(mode)}`);
    }
    if (mode === 'subscription' && !claudeBinaryPath) {
      throw new Error(
        'Claude Code CLI not found. Install it from claude.ai/download or run `claude login`.',
      );
    }
    if (mode === 'api-key' && !(await getAnthropicApiKey())) {
      throw new Error('Add an API key first.');
    }
    saveAuthMode(mode);
    await broadcastStatus();
  });

  ipcMain.handle(IpcChannels.openObservatory, () => {
    openObservatory();
  });
  ipcMain.handle(IpcChannels.openPalette, () => {
    openPalette();
  });

  ipcMain.handle(IpcChannels.listSkills, () => skills.list());
  ipcMain.handle(IpcChannels.refreshSkills, () => {
    skills.reloadAll();
    return skills.list();
  });

  ipcMain.handle(IpcChannels.listMcpServers, () => mcp.list());

  ipcMain.handle(IpcChannels.listModules, () => modules.list());
  ipcMain.handle(
    IpcChannels.dispatchIntent,
    async (
      _e,
      { moduleId, intentId, input }: { moduleId: string; intentId: string; input: string },
    ): Promise<DispatchIntentResult> => {
      const result = await modules.dispatch(moduleId, intentId, input);
      // Hide the palette on success so the user has a clear "command landed"
      // signal — the notification + reopening behavior takes over from here.
      if (result.ok) hidePalette();
      return result;
    },
  );
  ipcMain.handle(
    IpcChannels.setModuleEnabled,
    async (_e, { moduleId, enabled }: { moduleId: string; enabled: boolean }) => {
      await modules.setEnabled(moduleId, enabled);
    },
  );

  const jarvisRoot = join(homedir(), '.jarvis');
  const resolveSafe = (rel: string): string => {
    const target = normalize(resolve(jarvisRoot, rel || '.'));
    const within = relative(jarvisRoot, target);
    if (within.startsWith('..') || within === '..') {
      throw new Error(`Path escapes ~/.jarvis: ${rel}`);
    }
    return target;
  };
  ipcMain.handle(
    IpcChannels.listJarvisDir,
    (_e, rel: string): JarvisFileEntry[] => {
      const target = resolveSafe(rel);
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(target, { withFileTypes: true });
      } catch {
        return [];
      }
      const out: JarvisFileEntry[] = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = join(target, entry.name);
        try {
          const stat = statSync(full);
          out.push({
            name: entry.name,
            isDir: entry.isDirectory(),
            mtimeMs: stat.mtimeMs,
            sizeBytes: stat.size,
          });
        } catch {
          // skip unreadable
        }
      }
      return out;
    },
  );
  ipcMain.handle(
    IpcChannels.readJarvisFile,
    (_e, rel: string): string => {
      const target = resolveSafe(rel);
      return readFileSync(target, 'utf8');
    },
  );

  ipcMain.handle(IpcChannels.listRoutines, () => routines.list());
  ipcMain.handle(IpcChannels.saveRoutine, (_e, input) => routines.save(input));
  ipcMain.handle(IpcChannels.deleteRoutine, (_e, id: string) =>
    routines.remove(id),
  );
  ipcMain.handle(IpcChannels.runRoutineNow, (_e, id: string) =>
    routines.runNow(id),
  );

  ipcMain.handle(IpcChannels.launchTask, async (_e, req: LaunchTaskRequest) => {
    const status = await refreshAuth();
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
    // Tray indicator counts only tasks Jarvis owns — external sessions cycle
    // between running/idle and would make the indicator meaningless.
    const running = runner
      .list()
      .filter((t) => t.status === 'running' && t.origin !== 'external').length;
    setRunningTasksCount(running);
    broadcast(IpcChannels.taskStatus, summary);
    if (
      summary.origin !== 'external' &&
      (summary.status === 'completed' || summary.status === 'errored')
    ) {
      try {
        const titlePrefix =
          summary.origin === 'routine'
            ? 'Jarvis · routine'
            : 'Jarvis · task';
        const titleSuffix =
          summary.status === 'completed' ? 'complete' : 'failed';
        new Notification({
          title: `${titlePrefix} ${titleSuffix}`,
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
  await refreshAuth();
  seedDefaultsIfEmpty();
  skills.init();
  mcp.init();
  routines.init();

  // Module foundation: every user-asked feature ships as a module that
  // registers here. Built-ins live in electron/main/modules/. External
  // (community) modules can follow the same shape later.
  modules.setContext({
    jarvisRoot: join(homedir(), '.jarvis'),
    notify: (title, body) => {
      try {
        new Notification({ title, body, silent: false })
          .on('click', () => openObservatory())
          .show();
      } catch {
        // Notifications can fail pre-permission; not fatal.
      }
    },
    launchTask: (req) =>
      runner.launch({ ...req, origin: asTaskOrigin(req.origin) }),
    registerExternalTask: (summary) => runner.registerExternal(summary),
    recordExternalEvent: (taskId, msg) =>
      runner.recordExternalEvent(taskId, msg),
    updateExternalTaskStatus: (taskId, status, endedAt) =>
      runner.updateExternalStatus(taskId, status, endedAt),
    updateExternalTaskMeta: (taskId, patch) =>
      runner.updateExternalMeta(taskId, patch),
    hasExternalTask: (id) => runner.hasExternal(id),
  });
  await modules.register(quickNoteModule);
  await modules.register(claudeCodeWatchModule);

  skills.on('changed', (list) => broadcast(IpcChannels.listSkills, list));
  mcp.on('changed', (list) => broadcast(IpcChannels.listMcpServers, list));
  routines.on('changed', (list) => broadcast(IpcChannels.routinesChanged, list));
  modules.on('changed', (list) => broadcast(IpcChannels.modulesChanged, list));
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
  void modules.unloadAll();
  routines.close();
  skills.close();
  mcp.close();
  closeDatabase();
});

app.on('will-quit', () => {
  void getRunningTasksCount;
});
