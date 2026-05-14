import { app, globalShortcut, ipcMain, Notification, shell, systemPreferences } from 'electron';
import {
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
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
import { meetingRecorderModule, persistMeeting } from './modules/meeting-recorder.js';
import { prWorkflowsModule } from './modules/pr-workflows.js';
import { quickNoteModule } from './modules/quick-note.js';
import { sendModule } from './modules/send.js';
import { skillSuggesterModule } from './modules/skill-suggester.js';
import { statusModule } from './modules/status.js';
import { listClaudeMcps } from './claude-mcp.js';
import { probeMcpTools } from './mcp-probe.js';
import { parseIntent } from './intent-router.js';
import { ProjectStore } from './projects.js';
import { ReminderStore } from './reminders.js';
import { RoutineStore } from './routines.js';
import { seedDefaultsIfEmpty } from './seed.js';
import { SkillSuggestionStore } from './skill-suggestions.js';
import {
  clearAnthropicApiKey,
  clearClaudeCodeOAuthToken,
  getAnthropicApiKey,
  getClaudeCodeOAuthToken,
  setAnthropicApiKey,
  setClaudeCodeOAuthToken,
} from './secrets.js';
import { SkillStore } from './skill-store.js';
import { asTaskOrigin, TaskRunner } from './task-runner.js';
import { setProgressEmitter, transcribePcm } from './transcribe.js';
import {
  getRunningTasksCount,
  initTray,
  setAbortAllHandler,
  setAwaitingRepliesCount,
  setPendingRemindersCount,
  setRunningTasksCount,
} from './tray.js';
import {
  broadcast,
  getAnswerHudWindow,
  hideAnswerHud,
  hidePalette,
  openObservatory,
  openPalette,
  resizeAnswerHud,
  resizePalette,
  showAnswerHud,
} from './windows.js';

const skills = new SkillStore();
const mcp = new McpConfigStore();
const projects = new ProjectStore();
const runner = new TaskRunner();
const routines = new RoutineStore();
const reminders = new ReminderStore();
const skillSuggestions = new SkillSuggestionStore(join(homedir(), '.jarvis'));
const modules = new ModuleRegistry();
runner.setSkillStore(skills);
runner.setMcpStore(mcp);
runner.setProjectStore(projects);
routines.setRunner(runner);

let claudeBinaryPath: string | null = null;

async function refreshAuth(): Promise<AppStatus> {
  const apiKey = await getAnthropicApiKey();
  const hasApiKey = !!apiKey;
  const subscriptionToken = await getClaudeCodeOAuthToken();
  const hasSubscriptionToken = !!subscriptionToken;
  claudeBinaryPath = detectClaudeBinary();
  let mode = loadAuthMode();
  // Auto-pick: subscription if the CLI + a setup-token are present, else
  // api-key if a key is on file, else null (show Setup).
  if (!mode) {
    if (claudeBinaryPath && hasSubscriptionToken) mode = 'subscription';
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
    claudeOauthToken: mode === 'subscription' ? subscriptionToken : null,
  });

  return {
    authMode: mode,
    hasApiKey,
    hasSubscriptionToken,
    claudeBinaryPath,
    version: app.getVersion(),
  };
}

async function broadcastStatus(): Promise<AppStatus> {
  const status = await refreshAuth();
  broadcast(IpcChannels.appStatus, status);
  return status;
}

/**
 * Show the Answer HUD and push a taskId into its stack. Used by both the
 * palette IPC handler and the reminder fire handler — anything that wants a
 * Claude task to surface to the user as a HUD card.
 */
function pushTaskToHud(taskId: string): void {
  showAnswerHud();
  const hud = getAnswerHudWindow();
  if (!hud) return;
  // If the HUD just opened, webContents.send before did-finish-load is
  // dropped; gate on isLoading.
  if (hud.webContents.isLoading()) {
    hud.webContents.once('did-finish-load', () => {
      hud.webContents.send(IpcChannels.answerHudTrack, taskId);
    });
  } else {
    hud.webContents.send(IpcChannels.answerHudTrack, taskId);
  }
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

  ipcMain.handle(IpcChannels.setSubscriptionToken, async (_e, value: string) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('Subscription token cannot be empty');
    }
    await setClaudeCodeOAuthToken(value.trim());
    saveAuthMode('subscription');
    await broadcastStatus();
  });

  ipcMain.handle(IpcChannels.clearSubscriptionToken, async () => {
    await clearClaudeCodeOAuthToken();
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
    if (mode === 'subscription' && !(await getClaudeCodeOAuthToken())) {
      throw new Error(
        'Run `claude setup-token` in Terminal, then paste the token here.',
      );
    }
    if (mode === 'api-key' && !(await getAnthropicApiKey())) {
      throw new Error('Add an API key first.');
    }
    saveAuthMode(mode);
    await broadcastStatus();
  });

  ipcMain.handle(IpcChannels.openObservatory, (_e, taskId?: string) => {
    const win = openObservatory();
    win.focus();
    if (typeof taskId === 'string' && taskId) {
      // Emit after the renderer has mounted; if it's already up, this is a
      // no-op delay. Otherwise the message would land before subscriptions
      // are set up.
      const send = () =>
        win.webContents.send(IpcChannels.observatoryFocusTask, taskId);
      if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', send);
      } else {
        send();
      }
    }
  });
  ipcMain.handle(IpcChannels.openPalette, () => {
    openPalette();
  });
  ipcMain.handle(IpcChannels.resizePalette, (_e, height: number) => {
    if (typeof height === 'number' && Number.isFinite(height)) {
      resizePalette(height);
    }
  });
  ipcMain.handle(IpcChannels.showAnswerHud, (_e, taskId: string) => {
    if (typeof taskId !== 'string' || !taskId) return;
    pushTaskToHud(taskId);
  });
  ipcMain.handle(IpcChannels.hideAnswerHud, () => {
    hideAnswerHud();
  });
  ipcMain.handle(IpcChannels.resizeAnswerHud, (_e, height: number) => {
    if (typeof height === 'number' && Number.isFinite(height)) {
      resizeAnswerHud(height);
    }
  });
  ipcMain.handle(IpcChannels.openExternal, async (_e, url: string) => {
    // Only allow http/https. mailto + other schemes are easy XSS vectors
    // when the URL comes from rendered assistant content.
    if (typeof url !== 'string') return;
    if (!/^https?:\/\//i.test(url)) return;
    await shell.openExternal(url);
  });

  ipcMain.handle(IpcChannels.listSkills, () => skills.list());
  ipcMain.handle(IpcChannels.refreshSkills, () => {
    skills.reloadAll();
    return skills.list();
  });

  ipcMain.handle(IpcChannels.listMcpServers, () => mcp.list());
  ipcMain.handle(IpcChannels.listClaudeMcps, async () => {
    const bin = claudeBinaryPath ?? '';
    return listClaudeMcps(bin);
  });

  ipcMain.handle(
    IpcChannels.addMcpServer,
    (
      _e,
      input: {
        id: string;
        type: 'stdio' | 'sse' | 'http';
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
        headers?: Record<string, string>;
      },
    ): { ok: boolean; message?: string } => {
      try {
        if (input.type === 'stdio') {
          if (!input.command) {
            return { ok: false, message: 'stdio servers require a command.' };
          }
          mcp.upsert(input.id, {
            type: 'stdio',
            command: input.command,
            args: input.args && input.args.length ? input.args : undefined,
            env:
              input.env && Object.keys(input.env).length ? input.env : undefined,
          });
        } else {
          if (!input.url) {
            return { ok: false, message: `${input.type} servers require a URL.` };
          }
          mcp.upsert(input.id, {
            type: input.type,
            url: input.url,
            headers:
              input.headers && Object.keys(input.headers).length
                ? input.headers
                : undefined,
          });
        }
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.removeMcpServer,
    (_e, id: string): { ok: boolean; message?: string } => {
      if (typeof id !== 'string' || !id) {
        return { ok: false, message: 'Invalid server id.' };
      }
      const removed = mcp.remove(id);
      return removed ? { ok: true } : { ok: false, message: 'Not found.' };
    },
  );

  ipcMain.handle(IpcChannels.readMcpFile, () => ({
    path: mcp.path,
    contents: mcp.rawFileContents(),
  }));

  ipcMain.handle(IpcChannels.revealMcpFile, async () => {
    // Show the mcp.json file in Finder. If it doesn't exist yet, fall back
    // to the parent directory so the user can see where it would land.
    const target = mcp.rawFileContents() !== null
      ? mcp.path
      : join(homedir(), '.jarvis');
    shell.showItemInFolder(target);
  });

  ipcMain.handle(IpcChannels.probeMcpTools, async (_e, id: string) => {
    if (typeof id !== 'string' || !id) {
      return { ok: false, message: 'Invalid server id.' };
    }
    return probeMcpTools(mcp, id);
  });

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

  // Delete a single timestamped entry from a daily notes/<date>.md file.
  // The note file is a sequence of `## HH:MM\n\n<body>\n` blocks appended
  // over the day; we re-parse, drop the one at `fileIndex` (top-down
  // order), and rewrite. Deleting the last entry deletes the file.
  ipcMain.handle(
    IpcChannels.deleteNoteEntry,
    (
      _e,
      { date, fileIndex }: { date: string; fileIndex: number },
    ): { ok: boolean; message?: string } => {
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { ok: false, message: 'Invalid date' };
      }
      if (!Number.isInteger(fileIndex) || fileIndex < 0) {
        return { ok: false, message: 'Invalid entry index' };
      }
      const path = resolveSafe(join('notes', `${date}.md`));
      let raw: string;
      try {
        raw = readFileSync(path, 'utf8');
      } catch {
        return { ok: false, message: 'Note file not found' };
      }
      // Same parser shape the renderer uses. Capture each entry as a block
      // including its `## HH:MM` header so we can splice it out by index.
      const re = /(?:^|\n)(## \d{2}:\d{2}\n[\s\S]*?)(?=\n## \d{2}:\d{2}|$)/g;
      const blocks: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null) blocks.push(m[1]!);
      if (fileIndex >= blocks.length) {
        return { ok: false, message: 'Entry not found' };
      }
      blocks.splice(fileIndex, 1);
      if (blocks.length === 0) {
        try {
          rmSync(path);
        } catch {
          // ignore
        }
        return { ok: true };
      }
      writeFileSync(path, blocks.join('\n') + '\n', 'utf8');
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.requestMicAccess,
    async (): Promise<{ granted: boolean; status: string }> => {
      if (process.platform !== 'darwin') {
        return { granted: true, status: 'unrestricted' };
      }
      const status = systemPreferences.getMediaAccessStatus('microphone');
      if (status === 'granted') return { granted: true, status };
      // 'not-determined' triggers the system prompt; 'denied'/'restricted' won't.
      const ok = await systemPreferences.askForMediaAccess('microphone');
      const after = systemPreferences.getMediaAccessStatus('microphone');
      return { granted: ok && after === 'granted', status: after };
    },
  );

  ipcMain.handle(
    IpcChannels.micStatus,
    (): { status: string } => {
      const status =
        process.platform === 'darwin'
          ? systemPreferences.getMediaAccessStatus('microphone')
          : 'unrestricted';
      return { status };
    },
  );

  ipcMain.handle(
    IpcChannels.transcribeAudio,
    async (_e, payload: ArrayBuffer): Promise<string> => {
      const pcm = new Float32Array(payload);
      return transcribePcm(pcm);
    },
  );

  ipcMain.handle(
    IpcChannels.meetingFinish,
    async (
      _e,
      payload: {
        title: string;
        startedAt: number;
        endedAt: number;
        sampleRate: number;
        pcm: ArrayBuffer;
      },
    ): Promise<{ filename: string }> => {
      const filename = await persistMeeting(join(homedir(), '.jarvis'), {
        title: payload.title,
        startedAt: payload.startedAt,
        endedAt: payload.endedAt,
        sampleRate: payload.sampleRate,
        pcm: new Float32Array(payload.pcm),
      });
      const relPath = `~/.jarvis/meetings/${filename}`;
      new Notification({
        title: 'Meeting saved',
        body: relPath,
      })
        .on('click', () => openObservatory())
        .show();
      // Auto-debrief: kick off a Claude task using the meeting-debrief skill,
      // which reads the transcript file and rewrites it with structured
      // Summary / Decisions / Action items / Open questions sections. Runs
      // in the background; the user sees it in the dashboard.
      try {
        const debrief = runner.launch({
          prompt: `Path: ~/.jarvis/meetings/${filename}\n\nRead this freshly recorded meeting transcript and restructure the file as the skill instructs.`,
          skillId: 'meeting-debrief',
          origin: 'routine',
        });
        pushTaskToHud(debrief.id);
      } catch (e) {
        console.error('Meeting auto-debrief failed to launch:', e);
      }
      return { filename };
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

  ipcMain.handle(IpcChannels.listSkillSuggestions, () =>
    skillSuggestions.list(),
  );
  ipcMain.handle(IpcChannels.acceptSkillSuggestion, (_e, id: string) =>
    skillSuggestions.accept(id),
  );
  ipcMain.handle(IpcChannels.dismissSkillSuggestion, (_e, id: string) =>
    skillSuggestions.dismiss(id),
  );
  ipcMain.handle(IpcChannels.removeSkillSuggestion, (_e, id: string) =>
    skillSuggestions.remove(id),
  );

  ipcMain.handle(IpcChannels.previewIntent, (_e, prompt: string) => {
    if (typeof prompt !== 'string') return { kind: 'task', body: '' };
    return parseIntent(prompt);
  });

  ipcMain.handle(
    IpcChannels.routePrompt,
    async (
      _e,
      payload: { prompt: string; origin?: 'palette' | 'voice' },
    ) => {
      const prompt = typeof payload?.prompt === 'string' ? payload.prompt : '';
      // 1. Verbal intent match: "record the meeting" → meeting/start, etc.
      //    Routed BEFORE parseIntent so module-owned phrases win over the
      //    reminder parser (a phrase like 'remind me to record the meeting'
      //    still parses as a reminder because the leading word is 'remind').
      const verbal = modules.matchVerbal(prompt);
      if (verbal) {
        const result = await modules.dispatch(
          verbal.moduleId,
          verbal.intentId,
          verbal.rest,
        );
        return {
          kind: 'intent' as const,
          moduleId: verbal.moduleId,
          intentId: verbal.intentId,
          ok: result.ok,
          message: result.message,
        };
      }
      const intent = parseIntent(prompt);
      if (intent.kind === 'reminder') {
        const reminder = reminders.create({
          body: intent.body,
          mode: intent.mode,
          fireAt: intent.fireAt,
        });
        try {
          const when = new Date(reminder.fireAt).toLocaleString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            day: 'numeric',
            month: 'short',
          });
          const title =
            intent.mode === 'scheduled'
              ? `Scheduled · ${when}`
              : `Reminder set · ${when}`;
          new Notification({ title, body: reminder.body, silent: true })
            .on('click', () => openObservatory())
            .show();
        } catch {
          // Notifications can fail pre-permission; the reminder is still
          // scheduled.
        }
        return { kind: 'reminder' as const, reminder };
      }
      // Fall through to a normal task launch — same auth + plumbing as the
      // launchTask handler, but inline to avoid a second IPC hop.
      const status = await refreshAuth();
      if (!status.authMode) throw new Error('Pick an auth mode first.');
      if (status.authMode === 'api-key' && !status.hasApiKey) {
        throw new Error('Add an API key first.');
      }
      if (status.authMode === 'subscription' && !status.claudeBinaryPath) {
        throw new Error(
          'Claude Code CLI not found. Run `claude login` or switch to API-key mode.',
        );
      }
      const task = runner.launch({
        prompt: intent.body,
        origin: asTaskOrigin(payload?.origin),
      });
      return { kind: 'task' as const, task };
    },
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
    // Token is loaded by refreshAuth above; if missing, the spawned claude
    // will 401 — fail loudly with the recovery path.
    if (status.authMode === 'subscription' && !status.hasSubscriptionToken) {
      throw new Error(
        'No subscription token configured. Run `claude setup-token` in a ' +
          'terminal, then paste the token in Setup — or switch to API-key mode.',
      );
    }
    const summary = runner.launch({
      ...req,
      origin: asTaskOrigin(req.origin),
    });
    // Don't hide the palette or pop the observatory anymore — the renderer
    // now streams the response inline in the palette ("Jarvis mode"). The
    // user can explicitly switch to the observatory from there if they
    // want the full view.
    return summary;
  });

  ipcMain.handle(IpcChannels.abortTask, (_e, taskId: string) =>
    runner.abort(taskId),
  );

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
}

// Track previous awaitingInput per task id so we only fire the "ready for
// your reply" notification on the false→true transition (not every status
// tick while the task remains parked).
const awaitingFlipped = new Map<string, boolean>();

function wireRunnerEvents(): void {
  runner.on('event', (payload: { taskId: string; event: TaskEvent }) => {
    broadcast(IpcChannels.taskEvent, payload);
  });
  runner.on('removed', (taskId: string) => {
    broadcast(IpcChannels.taskRemoved, taskId);
  });
  runner.on('status', (summary: TaskSummary) => {
    // Tray indicator counts only tasks Jarvis owns — external sessions cycle
    // between running/idle and would make the indicator meaningless.
    const tasks = runner.list();
    const running = tasks.filter(
      (t) => t.status === 'running' && t.origin !== 'external',
    ).length;
    const awaiting = tasks.filter(
      (t) => t.awaitingInput && t.origin !== 'external',
    ).length;
    setRunningTasksCount(running);
    setAwaitingRepliesCount(awaiting);
    broadcast(IpcChannels.taskStatus, summary);

    // Awaiting-input transition. Fire on false→true so each pause gets one
    // ping (and a follow-up pause after the user replies pings again).
    if (summary.origin !== 'external') {
      const was = awaitingFlipped.get(summary.id) ?? false;
      const now = !!summary.awaitingInput;
      if (!was && now) {
        try {
          const preview =
            summary.title.length > 80
              ? `${summary.title.slice(0, 80)}…`
              : summary.title;
          const notif = new Notification({
            title: 'Jarvis · ready for your reply',
            body: preview,
            silent: false,
          });
          notif.on('click', () => {
            const win = openObservatory();
            win.focus();
            const send = () =>
              win.webContents.send(IpcChannels.observatoryFocusTask, summary.id);
            if (win.webContents.isLoading()) {
              win.webContents.once('did-finish-load', send);
            } else {
              send();
            }
          });
          notif.show();
        } catch {
          // Notifications can fail pre-permission; not fatal.
        }
      }
      awaitingFlipped.set(summary.id, now);
      if (summary.status === 'completed' || summary.status === 'errored') {
        awaitingFlipped.delete(summary.id);
      }
    }

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

// Single-instance lock. Belt-and-suspenders against stale Electron mains
// from old `pnpm dev` runs grabbing the global shortcut. If we can't get
// the lock, just exit — `predev` (in package.json) already pkilled stale
// processes, but a race or an unrelated electron-vite child could still
// double-launch.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openPalette());
}

app.whenReady().then(async () => {
  // macOS: keep app alive in tray even when no windows are open.
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  initDatabase();
  await refreshAuth();
  seedDefaultsIfEmpty();
  skills.init();
  mcp.init();
  projects.init();
  routines.init();
  // Wire reminder fire handler before init() so any past-due reminders that
  // fire on this tick land in the runner. The handler launches a Claude
  // task with the original body and pops a native notification — clicking
  // it focuses the spawned task in the observatory.
  reminders.setFireHandler((reminder) => {
    let firedTaskId: string | null = null;
    // Different framings: reminders nudge the user; scheduled actions tell
    // Claude to do the thing. Both end up as a normal task with full tool
    // access — only the system framing differs.
    const prompt =
      reminder.mode === 'scheduled'
        ? `It's the scheduled time you set earlier for this. Carry it out now using whatever tools fit (gh, slack, fs, etc.). If a precondition isn't met (e.g. "if Luca hasn't reviewed"), check first and skip the action accordingly. Task:\n\n${reminder.body}`
        : `Earlier I asked you to remind me about this. Surface it clearly. If it's a question, answer it; if it's a task, propose the concrete next step.\n\n${reminder.body}`;
    try {
      const t = runner.launch({ prompt, origin: 'palette' });
      firedTaskId = t.id;
      pushTaskToHud(t.id);
    } catch (e) {
      console.error('Reminder fire failed:', e);
    }
    reminders.markFired(reminder.id, firedTaskId);
    try {
      const preview =
        reminder.body.length > 80 ? `${reminder.body.slice(0, 80)}…` : reminder.body;
      const title = reminder.mode === 'scheduled' ? 'Jarvis is on it' : 'Reminder';
      const notif = new Notification({ title, body: preview, silent: false });
      notif.on('click', () => {
        if (firedTaskId) {
          const win = openObservatory();
          win.focus();
          const send = () =>
            win.webContents.send(IpcChannels.observatoryFocusTask, firedTaskId);
          if (win.webContents.isLoading()) {
            win.webContents.once('did-finish-load', send);
          } else {
            send();
          }
        } else {
          openObservatory();
        }
      });
      // If the spawned task is also going to pop the HUD (always, since
      // origin: 'palette'), we don't need this notification to dominate.
      notif.show();
    } catch {
      // Notifications can fail pre-permission; not fatal.
    }
  });
  reminders.init();
  skillSuggestions.init();

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
    showHud: (taskId) => pushTaskToHud(taskId),
    listRecentTasks: (limit) => {
      // Mirror the listTasks IPC: if the in-memory runner is empty (fresh
      // boot, or all tasks aged out), fall back to SQLite history so the
      // suggester can still see what the user has run over time.
      const live = runner.list();
      const all = live.length > 0 ? live : listRecentTasks();
      return typeof limit === 'number' ? all.slice(0, limit) : all;
    },
    parseFreeTextIntent: (input: string) => parseIntent(input),
    createReminder: (input) => reminders.create(input),
    registerExternalTask: (summary) => runner.registerExternal(summary),
    recordExternalEvent: (taskId, msg) =>
      runner.recordExternalEvent(taskId, msg),
    updateExternalTaskStatus: (taskId, status, endedAt) =>
      runner.updateExternalStatus(taskId, status, endedAt),
    updateExternalTaskMeta: (taskId, patch) =>
      runner.updateExternalMeta(taskId, patch),
    hasExternalTask: (id) => runner.hasExternal(id),
    isOwnedSessionId: (id) => runner.isOwnedSessionId(id),
    removeExternalTask: (id) => {
      runner.removeExternal(id);
    },
    broadcast: (channel, payload) => broadcast(channel, payload),
  });
  await modules.register(quickNoteModule);
  await modules.register(claudeCodeWatchModule);
  await modules.register(meetingRecorderModule);
  await modules.register(statusModule);
  await modules.register(skillSuggesterModule);
  await modules.register(sendModule);
  await modules.register(prWorkflowsModule);

  skills.on('changed', (list) => broadcast(IpcChannels.listSkills, list));
  mcp.on('changed', (list) => broadcast(IpcChannels.listMcpServers, list));
  routines.on('changed', (list) => broadcast(IpcChannels.routinesChanged, list));
  reminders.on('changed', (list) => {
    broadcast(IpcChannels.remindersChanged, list);
    setPendingRemindersCount(reminders.pendingCount());
  });
  // Seed initial count after init().
  setPendingRemindersCount(reminders.pendingCount());

  skillSuggestions.on('changed', (list) =>
    broadcast(IpcChannels.skillSuggestionsChanged, list),
  );
  skillSuggestions.on('batch', ({ added }: { added: number }) => {
    try {
      new Notification({
        title: 'Skill ideas',
        body: `Jarvis proposed ${added} new skill${added === 1 ? '' : 's'} based on your recent prompts`,
      })
        .on('click', () => openObservatory())
        .show();
    } catch {
      // Notifications can fail pre-permission; suggestions are still in
      // the store, the user will see them in the dashboard.
    }
  });
  modules.on('changed', (list) => broadcast(IpcChannels.modulesChanged, list));

  setProgressEmitter((event) =>
    broadcast(IpcChannels.transcribeProgress, event),
  );
  registerIpc();
  wireRunnerEvents();
  initTray();
  setAbortAllHandler(() => runner.abortAll());
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
  reminders.disposeAll();
  skillSuggestions.close();
  skills.close();
  mcp.close();
  projects.close();
  closeDatabase();
});

app.on('will-quit', () => {
  void getRunningTasksCount;
});
