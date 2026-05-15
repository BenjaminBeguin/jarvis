import { app, globalShortcut, ipcMain, Notification, shell } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { IpcChannels } from '@shared/ipc';
import type { AppStatus, TaskEvent, TaskSummary } from '@shared/types';

import { detectClaudeBinary, loadAuthMode } from './auth.js';
import { BriefingsStore } from './briefings.js';
import { closeDatabase, initDatabase, listRecentTasks } from './db.js';
import { startHttpServer, type HttpServerHandle } from './http-server.js';
import { InboxStore } from './inbox.js';
import { InboxProximityWatcher } from './inbox-proximity.js';
import { MeetingActivityWatcher } from './meeting-activity-watcher.js';
import { BUILTIN_BRIEFING_KINDS } from './seeds/briefing-kinds.js';
import {
  failedRoutinesInboxSource,
  prAddressCommentsInboxSource,
  prReviewQueueInboxSource,
  remindersInboxSource,
  userInboxSource,
} from './inbox-sources/index.js';
import { registerAllIpc } from './ipc/index.js';
import { McpConfigStore } from './mcp-config.js';
import { ModuleRegistry } from './module-registry.js';
import { DashboardStore } from './dashboard-store.js';
import { PreferencesStore } from './preferences-store.js';
import { calendarModule } from './modules/calendar.js';
import { claudeCodeWatchModule } from './modules/claude-code-watch.js';
import { meetingRecorderModule } from './modules/meeting-recorder.js';
import { prWorkflowsModule } from './modules/pr-workflows.js';
import { quickNoteModule } from './modules/quick-note.js';
import { sendModule } from './modules/send.js';
import { shellModule } from './modules/shell.js';
import { shellNavModule } from './modules/shell-nav.js';
import { skillSuggesterModule } from './modules/skill-suggester.js';
import { statusModule } from './modules/status.js';
import { parseIntent } from './intent-router.js';
import { ProjectMemoryStore } from './project-memory.js';
import { ProjectStore } from './projects.js';
import { ReminderStore } from './reminders.js';
import { RoutineStore } from './routines.js';
import { seedDefaultsIfEmpty } from './seed.js';
import {
  getAnthropicApiKey,
  getClaudeCodeOAuthToken,
  getOrCreateHttpApiToken,
  rotateHttpApiToken,
} from './secrets.js';
import { ShellRunner } from './shell-runner.js';
import { SkillStore } from './skill-store.js';
import { SkillSuggestionStore } from './skill-suggestions.js';
import { asTaskOrigin, TaskRunner } from './task-runner.js';
import { setProgressEmitter } from './transcribe.js';
import {
  activeProjectProfileProvider,
  activeProjectProvider,
  projectsProvider,
  recentTaskProvider,
  timeProvider,
  UserContextStore,
} from './user-context.js';
import {
  initTray,
  setAbortAllHandler,
  setAwaitingRepliesCount,
  setPendingRemindersCount,
  setRunningTasksCount,
} from './tray.js';
import {
  broadcast,
  getAnswerHudWindow,
  openObservatory,
  openPalette,
  showAnswerHud,
} from './windows.js';

// ─── stores (Electron-free; pure domain logic) ───────────────────────────────

const skills = new SkillStore();
const mcp = new McpConfigStore();
const projects = new ProjectStore();
const runner = new TaskRunner();
const routines = new RoutineStore();
const reminders = new ReminderStore();
const skillSuggestions = new SkillSuggestionStore(join(homedir(), '.jarvis'));
const projectMemory = new ProjectMemoryStore();
const modules = new ModuleRegistry();
const shellRunner = new ShellRunner(runner);
const preferences = new PreferencesStore(
  join(homedir(), '.jarvis', 'preferences.md'),
);
const dashboard = new DashboardStore(
  join(homedir(), '.jarvis', 'dashboard.json'),
);
const userContext = new UserContextStore();
const inbox = new InboxStore();
const briefings = new BriefingsStore(BUILTIN_BRIEFING_KINDS);
// "Heads up" notifications when an inbox item with fireAt is within 5
// min. Calendar events flow naturally through this; reminders are
// skipped (ReminderStore handles those at fireAt time).
const inboxProximity = new InboxProximityWatcher(
  inbox,
  (item, minutesUntil) => {
    try {
      const minutesLabel =
        minutesUntil <= 1 ? 'starting now' : `in ${minutesUntil} min`;
      const notif = new Notification({
        title: `Heads up · ${minutesLabel}`,
        body: item.title,
        silent: false,
      });
      notif.on('click', () => {
        if (item.url && /^https?:\/\//i.test(item.url)) {
          void shell.openExternal(item.url);
          return;
        }
        const win = openObservatory();
        win.focus();
        const send = () =>
          win.webContents.send(IpcChannels.shellNavigate, { tab: 'inbox' });
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
  },
  // Imminent meeting prompt — bring the window forward and broadcast
  // a meeting-imminent event. The renderer mounts a toast with [Record]
  // / [Skip] buttons; the user picks. No native notification here —
  // an in-app actionable toast is the only place we can offer buttons.
  (item, minutesUntil) => {
    try {
      const win = openObservatory();
      win.focus();
      const send = () =>
        win.webContents.send(IpcChannels.meetingImminent, { item, minutesUntil });
      if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', send);
      } else {
        send();
      }
    } catch (err) {
      console.warn('Meeting prompt broadcast failed:', err);
    }
  },
);

// Wire the renderer's "Skip" button so we don't re-prompt for the same
// item every minute when the user dismissed it.
// Ad-hoc meeting detection: when macOS reports the system mic or
// camera went active and no calendar prompt is in flight, fire the
// same "want to record this?" toast. Catches Google Meet, Zoom,
// Discord, FaceTime, etc. — anything that touches Core Audio / CMIO.
// macOS-only; no-op on other platforms.
const meetingActivity = new MeetingActivityWatcher((item) => {
  try {
    const win = openObservatory();
    win.focus();
    const send = () =>
      win.webContents.send(IpcChannels.meetingImminent, {
        item,
        minutesUntil: 0,
      });
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', send);
    } else {
      send();
    }
  } catch (err) {
    console.warn('Meeting activity broadcast failed:', err);
  }
});

ipcMain.handle(IpcChannels.suppressMeetingPrompt, (_e, id: string) => {
  if (typeof id !== 'string') return;
  // Route to whichever watcher owns this id. Ad-hoc ids carry the
  // 'ad-hoc-' prefix; everything else is a calendar item id.
  if (id.startsWith('ad-hoc-')) meetingActivity.suppress(id);
  else inboxProximity.suppressMeetingPrompt(id);
});
// Built-in context providers: time + active project (set from renderer) +
// projects list + recent task. Order matters — first registered is first
// in the prepended block. Modules can add more via
// `ctx.registerContextProvider(...)`.
userContext.register(timeProvider);
userContext.register(activeProjectProvider(userContext));
userContext.register(activeProjectProfileProvider(userContext, projects));
userContext.register(projectsProvider(projects));
userContext.register(recentTaskProvider(runner));

// Built-in inbox sources: time-pressured reminders, errored routines, and
// the two gh-CLI driven PR queues. Modules can add more via the module
// context (e.g. Slack DM count, Linear assignments) once registered.
inbox.register(remindersInboxSource(reminders));
inbox.register(failedRoutinesInboxSource());
inbox.register(prReviewQueueInboxSource(projects));
inbox.register(prAddressCommentsInboxSource(projects));
// User-authored scenarios — reads JSON files under ~/.jarvis/inbox/
// that any skill / routine can write to. The Slack inbox skill is the
// canonical first example.
inbox.register(userInboxSource);

runner.setSkillStore(skills);
runner.setMcpStore(mcp);
runner.setProjectStore(projects);
runner.setUserContextStore(userContext);
runner.setPreferencesStore(preferences);
routines.setRunner(runner);

let claudeBinaryPath: string | null = null;
let httpServer: HttpServerHandle | null = null;

// ─── auth + status reconciliation ────────────────────────────────────────────

async function refreshAuth(): Promise<AppStatus> {
  const apiKey = await getAnthropicApiKey();
  const hasApiKey = !!apiKey;
  const subscriptionToken = await getClaudeCodeOAuthToken();
  const hasSubscriptionToken = !!subscriptionToken;
  claudeBinaryPath = detectClaudeBinary();
  let mode = loadAuthMode();
  if (!mode) {
    if (claudeBinaryPath && hasSubscriptionToken) mode = 'subscription';
    else if (hasApiKey) mode = 'api-key';
  }
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

// ─── HUD: show Answer HUD + push a taskId so the renderer focuses it ─────────

function pushTaskToHud(taskId: string): void {
  showAnswerHud();
  const hud = getAnswerHudWindow();
  if (!hud) return;
  if (hud.webContents.isLoading()) {
    hud.webContents.once('did-finish-load', () => {
      hud.webContents.send(IpcChannels.answerHudTrack, taskId);
    });
  } else {
    hud.webContents.send(IpcChannels.answerHudTrack, taskId);
  }
}

// ─── runner event → broadcast + completion notifications ─────────────────────

/** Track previous awaitingInput per task so we only ping on false→true. */
const awaitingFlipped = new Map<string, boolean>();

/**
 * Cost guardrail: warn the user when a task crosses a spending threshold.
 * Single-fire per task to avoid notification spam. Hard-coded for now;
 * later this could read from preferences.md or per-skill frontmatter.
 */
const COST_GUARDRAIL_USD = 0.5;
const costWarned = new Set<string>();

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

    // Cost guardrail: fire ONCE when a task crosses the threshold.
    // Useful for unattended routines that could otherwise run away —
    // gives the user a chance to abort before the cost grows further.
    // Clears on completion / error so a future run of the same skill
    // starts fresh.
    if (
      summary.origin !== 'external' &&
      summary.costUsd > COST_GUARDRAIL_USD &&
      !costWarned.has(summary.id)
    ) {
      costWarned.add(summary.id);
      try {
        const notif = new Notification({
          title: `Jarvis · task at $${summary.costUsd.toFixed(2)}`,
          body: `${summary.title.length > 60 ? summary.title.slice(0, 60) + '…' : summary.title}\nClick to open · abort if surprising.`,
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
        // Notifications can fail pre-permission; the task continues.
      }
    }
    if (
      summary.status === 'completed' ||
      summary.status === 'errored' ||
      summary.status === 'aborted'
    ) {
      costWarned.delete(summary.id);
    }

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
          summary.origin === 'routine' ? 'Jarvis · routine' : 'Jarvis · task';
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

// ─── bootstrap ───────────────────────────────────────────────────────────────

app.setName('Jarvis');

// Single-instance lock. Belt-and-suspenders against stale Electron mains
// from old `pnpm dev` runs grabbing the global shortcut.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openPalette());
}

app.whenReady().then(async () => {
  // macOS: show in Dock + Cmd+Tab so it feels like a "real app" while the
  // tray icon stays the always-on entry point.
  if (process.platform === 'darwin' && app.dock) void app.dock.show();

  initDatabase();
  await refreshAuth();
  seedDefaultsIfEmpty();
  skills.init();
  mcp.init();
  projects.init();
  preferences.init();
  dashboard.init();
  briefings.init();
  routines.init();

  // Reminder fire handler must be set BEFORE init() so past-due reminders
  // that fire on this tick land in the runner.
  reminders.setFireHandler((reminder) => {
    let firedTaskId: string | null = null;
    // Reminders nudge the user; scheduled actions tell Claude to do the
    // thing. Both end up as a normal task — only the system framing differs.
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
  const jarvisRoot = join(homedir(), '.jarvis');
  modules.setContext({
    jarvisRoot,
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
    runShell: (cmd) => shellRunner.launch(cmd),
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
    resolveProject: (query: string) => projects.resolve(query),
    memoryRead: (project: string, file?: string) =>
      projectMemory.read(project, file),
    memoryAppend: (project: string, file: string, content: string) => {
      projectMemory.append(project, file, content);
    },
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
    registerContextProvider: (provider) => userContext.register(provider),
  });
  await modules.register(quickNoteModule);
  await modules.register(claudeCodeWatchModule);
  await modules.register(meetingRecorderModule);
  await modules.register(statusModule);
  await modules.register(skillSuggesterModule);
  await modules.register(sendModule);
  await modules.register(prWorkflowsModule);
  await modules.register(calendarModule);
  await modules.register(shellNavModule);
  await modules.register(shellModule);

  // ─── change → broadcast event fan-out ──────────────────────────────────────

  skills.on('changed', (list) => broadcast(IpcChannels.listSkills, list));
  mcp.on('changed', (list) => broadcast(IpcChannels.listMcpServers, list));
  routines.on('changed', (list) => broadcast(IpcChannels.routinesChanged, list));
  reminders.on('changed', (list) => {
    broadcast(IpcChannels.remindersChanged, list);
    setPendingRemindersCount(reminders.pendingCount());
  });
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
      // Suggestions are still in the store; user will see them in the dashboard.
    }
  });
  modules.on('changed', (list) => broadcast(IpcChannels.modulesChanged, list));
  projects.on('changed', (list) => broadcast(IpcChannels.projectsChanged, list));
  preferences.on('changed', (contents: string) =>
    broadcast(IpcChannels.preferencesChanged, contents),
  );
  inbox.on('changed', (items) => broadcast(IpcChannels.inboxChanged, items));
  inbox.on('refreshing', (flag: boolean) =>
    broadcast(IpcChannels.inboxRefreshing, flag),
  );
  briefings.on('changed', () => broadcast(IpcChannels.briefingsChanged, null));
  dashboard.on('changed', (cfg) => broadcast(IpcChannels.dashboardChanged, cfg));
  // Proactive Jarvis: ping the user once when new inbox items appear since
  // the previous refresh. Grouped — one notification for N items, not N
  // notifications. Click jumps to the Inbox tab.
  inbox.on('new-items', (fresh: import('@shared/types').InboxItem[]) => {
    if (fresh.length === 0) return;
    try {
      const bySrc = new Map<string, number>();
      for (const it of fresh) bySrc.set(it.source, (bySrc.get(it.source) ?? 0) + 1);
      const parts: string[] = [];
      for (const [src, n] of bySrc) {
        const label =
          src === 'pr-review' ? 'PR review' :
          src === 'pr-comments' ? 'PR comment' :
          src === 'reminders' ? 'reminder' :
          src === 'failed-routines' ? 'failed routine' :
          src;
        parts.push(`${n} ${label}${n === 1 ? '' : 's'}`);
      }
      const body = parts.join(' · ');
      new Notification({ title: 'Jarvis · new in inbox', body, silent: false })
        .on('click', () => {
          const win = openObservatory();
          win.focus();
          const send = () =>
            win.webContents.send(IpcChannels.shellNavigate, { tab: 'inbox' });
          if (win.webContents.isLoading()) {
            win.webContents.once('did-finish-load', send);
          } else {
            send();
          }
        })
        .show();
    } catch {
      // Notifications can fail pre-permission; not fatal.
    }
  });
  // Refresh the inbox every 5 minutes in the background. First tick is
  // delayed 5s so the renderer's on-mount refresh wins the race.
  inbox.startAutoRefresh(5 * 60 * 1000);
  // Watch every minute for fireAt items in the next 5 min so the user
  // gets a "starting soon" popup. Click → opens the meeting URL.
  inboxProximity.start();
  // Ad-hoc meeting detection via macOS Core Audio / CMIO log stream.
  meetingActivity.start();

  // Localhost HTTP API. Auto-generates a bearer token on first launch
  // and binds 127.0.0.1:4747. Lets iOS Shortcuts / CLI / future phone
  // clients drive Jarvis the same way the renderer does via IPC.
  // If the port is taken the server logs + skips — Jarvis works fine
  // without it; the user just won't have external access.
  try {
    const token = await getOrCreateHttpApiToken();
    httpServer = await startHttpServer({
      runner,
      reminders,
      inbox,
      token,
      version: app.getVersion(),
    });
  } catch (err) {
    console.warn('HTTP API startup failed:', err);
  }

  // Settings → API status. Inline here (rather than in ipc/<domain>.ts)
  // because the handle is module-scoped in this bootstrap. If the API
  // grows more endpoints / surface area, lift these into ipc/http.ts.
  ipcMain.handle(IpcChannels.httpApiStatus, async () => {
    const token = await getOrCreateHttpApiToken();
    return {
      running: httpServer !== null,
      url: httpServer?.url ?? null,
      token,
    };
  });
  ipcMain.handle(IpcChannels.rotateHttpApiToken, async () => {
    const fresh = await rotateHttpApiToken();
    // Restart the server so the new token takes effect immediately;
    // existing in-flight requests fail with 401 on the next call.
    if (httpServer) {
      await httpServer.close();
      httpServer = await startHttpServer({
        runner,
        reminders,
        inbox,
        token: fresh,
        version: app.getVersion(),
      });
    }
    return { token: fresh, url: httpServer?.url ?? null };
  });

  setProgressEmitter((event) =>
    broadcast(IpcChannels.transcribeProgress, event),
  );

  registerAllIpc({
    skills,
    mcp,
    projects,
    projectMemory,
    modules,
    runner,
    shellRunner,
    routines,
    reminders,
    skillSuggestions,
    userContext,
    preferences,
    inbox,
    briefings,
    dashboard,
    jarvisRoot,
    auth: {
      refresh: refreshAuth,
      broadcastStatus,
      currentBinaryPath: () => claudeBinaryPath,
    },
    hud: { pushTask: pushTaskToHud },
  });

  wireRunnerEvents();
  initTray();
  setAbortAllHandler(() => runner.abortAll());
  registerGlobalShortcut();

  // Open observatory on first launch.
  openObservatory();
});

app.on('window-all-closed', () => {
  // Stay alive in tray.
});

app.on('before-quit', () => {
  runner.abortAll();
  shellRunner.abortAll();
  globalShortcut.unregisterAll();
  void modules.unloadAll();
  routines.close();
  reminders.disposeAll();
  skillSuggestions.close();
  skills.close();
  mcp.close();
  projects.close();
  preferences.close();
  inbox.stopAutoRefresh();
  inboxProximity.stop();
  meetingActivity.stop();
  briefings.close();
  void httpServer?.close();
  closeDatabase();
});
