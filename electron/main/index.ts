import { app, globalShortcut, ipcMain, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { join } from 'node:path';

import { IpcChannels } from '@shared/ipc';
import type { AppStatus, TaskEvent, TaskSummary } from '@shared/types';

import {
  detectClaudeBinary,
  loadAfkMode,
  loadAuthMode,
  loadCostPrefs,
  loadNotificationPrefs,
  loadPaused,
  saveAfkMode,
  savePaused,
} from './auth.js';
import { awaitTurnResult } from './await-turn.js';
import { notifier } from './notifier.js';
import { routePrompt } from './route-prompt.js';
import { BriefingsStore } from './briefings.js';
import {
  closeDatabase,
  getCostBreakdown,
  getCostSummary,
  initDatabase,
  listRecentTasks,
} from './db.js';
import { startHttpServer, type HttpServerHandle } from './http-server.js';
import { ActivityStore } from './activity-store.js';
import { IntentClassifier } from './intent-classifier.js';
import { createJarvisMcp } from './jarvis-mcp.js';
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
import { remindersModule } from './modules/reminders.js';
import { sendModule } from './modules/send.js';
import { shellModule } from './modules/shell.js';
import { shellNavModule } from './modules/shell-nav.js';
import { skillSuggesterModule } from './modules/skill-suggester.js';
import { statusModule } from './modules/status.js';
import { telegramBotModule } from './modules/telegram-bot/index.js';
import { workflowsModule } from './modules/workflows.js';
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
import { SkillSessionStore } from './skill-sessions.js';
import { WorkflowRunner } from './workflow-runner.js';
import { WorkflowScheduler } from './workflow-scheduler.js';
import { WorkflowStore } from './workflow-store.js';
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
  refreshTrayMenu,
  setAbortAllHandler,
  setAwaitingRepliesCount,
  setPendingRemindersCount,
  setRunningTasksCount,
  setTodaySpend,
} from './tray.js';
import {
  broadcast,
  getAnswerHudWindow,
  openObservatory,
  openPalette,
  sendWhenReady,
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
const skillSessions = new SkillSessionStore();
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
const intentClassifier = new IntentClassifier(
  join(homedir(), '.jarvis', 'intent-cache.json'),
  { mode: 'subscription' },
);
const inbox = new InboxStore();
const activity = new ActivityStore();
const briefings = new BriefingsStore(BUILTIN_BRIEFING_KINDS);
const workflows = new WorkflowStore();
const workflowRunner = new WorkflowRunner();
const workflowScheduler = new WorkflowScheduler(workflows, workflowRunner, {
  isPaused: () => loadPaused(),
});
// "Heads up" notifications when an inbox item with fireAt is within 5
// min. Calendar events flow naturally through this; reminders are
// skipped (ReminderStore handles those at fireAt time).
const inboxProximity = new InboxProximityWatcher(
  inbox,
  (item, minutesUntil) => {
    const minutesLabel =
      minutesUntil <= 1 ? 'starting now' : `in ${minutesUntil} min`;
    notifier.post({
      source: 'meeting-heads-up',
      title: `Heads up · ${minutesLabel}`,
      body: item.title,
      onClick: () => {
        if (item.url && /^https?:\/\//i.test(item.url)) {
          void shell.openExternal(item.url);
          return;
        }
        const win = openObservatory();
        win.focus();
        sendWhenReady(win, IpcChannels.shellNavigate, { tab: 'inbox' });
      },
    });
  },
  // Imminent meeting prompt — bring the window forward and broadcast
  // a meeting-imminent event. The renderer mounts a toast with [Record]
  // / [Skip] buttons; the user picks. No native notification here —
  // an in-app actionable toast is the only place we can offer buttons.
  (item, minutesUntil) => {
    try {
      const win = openObservatory();
      win.focus();
      sendWhenReady(win, IpcChannels.meetingImminent, { item, minutesUntil });
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
    sendWhenReady(win, IpcChannels.meetingImminent, { item, minutesUntil: 0 });
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

// Renderer can pull the current watcher state on demand (e.g. when
// the Now view mounts and wants to show "auto-detect quiet → record
// manually" instead of pretending it's working).
ipcMain.handle(IpcChannels.meetingDetectionStatus, () => meetingActivity.status());
// Broadcast on every status change so a permanently-mounted status
// pill in the Shell can react without polling.
meetingActivity.on('status', (status) => {
  broadcast(IpcChannels.meetingDetectionChanged, status);
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

// Built-in inbox sources — all direct JS, no agent fires.
//   - reminders / failed-routines: local stores
//   - PR queues: gh CLI via execFile (pattern from inbox-sources/gh.ts)
//   - linear / slack / calendar: replaced the cron-fired *-inbox skills
//     with direct API/AppleScript calls. Tokens come from ~/.jarvis/mcp.json
//     (the same ones the MCP servers already use). No-op gracefully when
//     tokens are missing or the platform doesn't support them.
inbox.register(remindersInboxSource(reminders));
inbox.register(failedRoutinesInboxSource());
inbox.register(prReviewQueueInboxSource(projects));
inbox.register(prAddressCommentsInboxSource(projects));
// Linear / Slack / Calendar used to be registered InboxSources here.
// They're now driven by workflows (seeds/workflows/{linear,slack,
// calendar}-*.ts) whose inbox-write nodes call
// inbox.setExternalItems() at the end of each pipeline.
//
// User-authored scenarios — reads JSON files under ~/.jarvis/inbox/
// that any skill / routine can write to. Reserved names (linear, slack,
// calendar) are filtered out so they can't shadow the built-ins above.
inbox.register(userInboxSource);

runner.setSkillStore(skills);
runner.setMcpStore(mcp);
runner.setProjectStore(projects);
runner.setUserContextStore(userContext);
runner.setPreferencesStore(preferences);
runner.setSkillSessionStore(skillSessions);
runner.setClassifier(intentClassifier);
skillSessions.init();

// In-process Jarvis MCP — always available to every task. Tools:
// notify, log_activity, create_reminder, open_url, get_active_project,
// list_recent_meetings/notes, read/write_project_memory.
runner.setJarvisMcp(
  createJarvisMcp({
    notify: (title, body) => {
      notifier.post({
        source: 'notify-tool',
        title,
        body,
        onClick: () => openObservatory(),
      });
    },
    activity,
    reminders,
    projects,
    projectMemory,
    userContext,
    jarvisRoot: join(homedir(), '.jarvis'),
    setPaused: (value) => {
      savePaused(value);
      broadcast(IpcChannels.pausedChanged, value);
      activity.record({
        kind: 'paused.toggled',
        label: `Jarvis ${value ? 'paused' : 'resumed'} (via agent tool)`,
        detail: { paused: value, source: 'mcp' },
      });
    },
    isPaused: () => loadPaused(),
    getCostBreakdown,
    workflows,
    workflowRunner,
  }),
);

routines.setRunner(runner);
routines.setPausePredicate(() => loadPaused());
notifier.setPausePredicate(() => loadPaused());
inbox.setPausePredicate(() => loadPaused());

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

  const authCtx = {
    mode: mode ?? 'subscription',
    apiKey: apiKey ?? null,
    claudeBinaryPath,
    claudeOauthToken: mode === 'subscription' ? subscriptionToken : null,
  };
  runner.setAuth(authCtx);
  intentClassifier.setAuth(authCtx);

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

/**
 * The HUD pop is the launch signal — so it has to respect the
 * 'onLaunch' notification pref. Silent: don't conjure a new HUD
 * window; we still update the tracked task on an already-visible HUD
 * so manual-open users stay in sync. Toast (default): pop the HUD as
 * before.
 */
function pushTaskToHud(taskId: string): void {
  const launchLevel = loadNotificationPrefs().onLaunch;
  let hud: ReturnType<typeof getAnswerHudWindow>;
  if (launchLevel === 'silent') {
    hud = getAnswerHudWindow();
    if (!hud) return;
  } else {
    showAnswerHud();
    hud = getAnswerHudWindow();
    if (!hud) return;
  }
  sendWhenReady(hud, IpcChannels.answerHudTrack, taskId);
}

// ─── runner event → broadcast + completion notifications ─────────────────────

/** Track previous awaitingInput per task so we only ping on false→true. */
const awaitingFlipped = new Map<string, boolean>();

/** Tasks we've already announced as "started" — keeps the launch toast
 * single-fire across the many status events a task emits. */
const launchAnnounced = new Set<string>();

/**
 * Cost guardrails: warn the user when a single task or today's total
 * crosses a threshold. Both single-fire to avoid notification spam.
 * Defaults are in DEFAULT_COST_PREFS; the user can tune via Settings →
 * Spend → "Guardrails" once that affordance ships, or by hand-editing
 * config.json.costPrefs.{perTaskUsd,dailyUsd}.
 */
const costWarned = new Set<string>();
/** Task ids we've already logged as "routine fired" / "scheduled
 *  action fired" — status events arrive many times per task and we
 *  only want one Activity row at first-launch. */
const routineFiredLogged = new Set<string>();
/** Date-stamped "we already warned today" flag so we don't ping the
 *  user 47 times after lunch. Reset implicitly when the date string
 *  flips at local midnight. */
let dailyBudgetWarnedFor: string | null = null;
function todayLocalKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * Subscribe the renderer broadcast to notifier.post() fires so the
 * FlowStream page can render a terminal-stage orb for every
 * notification. Strips onClick (functions can't cross IPC) and
 * stamps a timestamp at the broadcast site.
 */
notifier.subscribe((e) => {
  const payload = {
    source: e.source,
    title: e.title,
    body: e.body,
    ...(e.taskId ? { taskId: e.taskId } : {}),
    ...(e.reminderId ? { reminderId: e.reminderId } : {}),
    ts: Date.now(),
  };
  broadcast(IpcChannels.notifierEmitted, payload);
});

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
    // Tray tooltip "today's spend" — refresh on every status change.
    // getCostSummary is a single SQL query, fast enough to call here.
    try {
      setTodaySpend(getCostSummary().today);
    } catch {
      // DB hiccup — tooltip stays at last value; not worth surfacing.
    }
    broadcast(IpcChannels.taskStatus, summary);

    // Routine + scheduled-action fires: log to Activity once per task
    // id so the user sees an entry in the feed when a cron tick
    // actually fired. Reminder firing has its own dedicated path
    // ('reminder.fired' below). origin='routine' covers cron-fired
    // skill routines; reminderId on the task covers scheduled actions.
    if (
      summary.origin === 'routine' &&
      summary.routineId &&
      !routineFiredLogged.has(summary.id)
    ) {
      routineFiredLogged.add(summary.id);
      const r = routines.list().find((x) => x.id === summary.routineId);
      activity.record({
        kind: 'routine.fired',
        label: `Routine fired · ${r?.skillId ?? summary.routineId}${
          summary.title ? ` — ${summary.title.slice(0, 60)}` : ''
        }`,
        detail: {
          routineId: summary.routineId,
          taskId: summary.id,
          skillId: r?.skillId ?? null,
        },
      });
    }

    // Cost guardrail: fire ONCE when a task crosses the threshold.
    // Useful for unattended routines that could otherwise run away —
    // gives the user a chance to abort before the cost grows further.
    // Clears on completion / error so a future run of the same skill
    // starts fresh.
    const costPrefs = loadCostPrefs();
    if (
      costPrefs.perTaskUsd > 0 &&
      summary.origin !== 'external' &&
      summary.costUsd > costPrefs.perTaskUsd &&
      !costWarned.has(summary.id)
    ) {
      costWarned.add(summary.id);
      notifier.post({
        source: 'cost-guardrail',
        title: `Jarvis · task at $${summary.costUsd.toFixed(2)}`,
        body: `${summary.title.length > 60 ? summary.title.slice(0, 60) + '…' : summary.title}\nClick to open · abort if surprising.`,
        taskId: summary.id,
        onClick: () => {
          const win = openObservatory();
          win.focus();
          sendWhenReady(win, IpcChannels.observatoryFocusTask, summary.id);
        },
      });
    }
    if (
      summary.status === 'completed' ||
      summary.status === 'errored' ||
      summary.status === 'aborted'
    ) {
      costWarned.delete(summary.id);
    }
    // Daily-budget guardrail: warn once per local day when the total
    // crosses the threshold. getCostSummary().today is the SAME number
    // the tray tooltip shows.
    if (costPrefs.dailyUsd > 0) {
      try {
        const today = getCostSummary().today;
        const dayKey = todayLocalKey();
        if (today > costPrefs.dailyUsd && dailyBudgetWarnedFor !== dayKey) {
          dailyBudgetWarnedFor = dayKey;
          // Optional escalation: when autoPauseOnDaily is set, flip the
          // global pause flag so routines + scheduled actions stop. The
          // user keeps user-initiated palette/voice and can resume any
          // time from the Shell header / tray / Telegram / MCP.
          const willAutoPause =
            costPrefs.autoPauseOnDaily && !loadPaused();
          if (willAutoPause) {
            savePaused(true);
            broadcast(IpcChannels.pausedChanged, true);
            activity.record({
              kind: 'paused.toggled',
              label: `Auto-paused: crossed $${costPrefs.dailyUsd.toFixed(2)} daily budget (spent $${today.toFixed(2)})`,
              detail: { paused: true, source: 'auto-budget', today },
            });
          }
          notifier.post({
            source: 'cost-guardrail',
            title: `Jarvis · daily spend at $${today.toFixed(2)}`,
            body: willAutoPause
              ? `Crossed the $${costPrefs.dailyUsd.toFixed(2)} budget — auto-paused. Resume manually when ready.`
              : `Crossed the $${costPrefs.dailyUsd.toFixed(2)} budget. Open Settings → Spend to see where it went, or pause Jarvis until tomorrow.`,
            onClick: () => {
              const win = openObservatory();
              win.focus();
              sendWhenReady(win, IpcChannels.shellNavigate, {
                tab: 'settings',
                settingsSection: 'spend',
              });
            },
          });
        }
      } catch {
        // DB query failed — skip this tick.
      }
    }

    if (summary.origin !== 'external') {
      const was = awaitingFlipped.get(summary.id) ?? false;
      const now = !!summary.awaitingInput;
      if (!was && now) {
        // User picks how loud Jarvis is when the agent asks something
        // (Settings → Notifications). Routine / api tasks always go
        // through 'toast' regardless — we don't yank focus when the
        // user didn't start the conversation.
        const focusTaskInObservatory = () => {
          const win = openObservatory();
          win.focus();
          sendWhenReady(win, IpcChannels.observatoryFocusTask, summary.id);
        };
        const isUserInitiated =
          summary.origin === 'palette' || summary.origin === 'voice';
        const askLevel = isUserInitiated
          ? loadNotificationPrefs().onAsk
          : 'toast';
        if (askLevel === 'open') {
          focusTaskInObservatory();
        }
        if (askLevel !== 'silent') {
          const preview =
            summary.title.length > 80
              ? `${summary.title.slice(0, 80)}…`
              : summary.title;
          notifier.post({
            source: 'task-awaiting',
            title: 'Jarvis · ready for your reply',
            body: preview,
            taskId: summary.id,
            onClick: focusTaskInObservatory,
          });
        } else {
          // Subscribers (e.g. Telegram in AFK mode) still need to hear
          // about awaiting-input even when the local OS toast is silenced.
          const preview =
            summary.title.length > 80
              ? `${summary.title.slice(0, 80)}…`
              : summary.title;
          notifier.post({
            source: 'task-awaiting',
            title: 'Jarvis · ready for your reply',
            body: preview,
            taskId: summary.id,
            skipOsNotification: true,
          });
        }
      }
      awaitingFlipped.set(summary.id, now);
      if (summary.status === 'completed' || summary.status === 'errored') {
        awaitingFlipped.delete(summary.id);
      }
    }

    // Launched-task signal: fire once when a user-initiated task
    // transitions queued → running, so commands like /review-prs don't
    // disappear into the background. Respects the onLaunch pref so
    // users who don't want a chirp can silence it.
    if (
      (summary.origin === 'palette' || summary.origin === 'voice') &&
      summary.status === 'running' &&
      !launchAnnounced.has(summary.id)
    ) {
      launchAnnounced.add(summary.id);
      const launchLevel = loadNotificationPrefs().onLaunch;
      const preview =
        summary.title.length > 80
          ? `${summary.title.slice(0, 80)}…`
          : summary.title;
      notifier.post({
        source: 'task-launched',
        title: 'Jarvis · task started',
        body: preview,
        taskId: summary.id,
        silent: true,
        // Honor the user's launch-toast preference for OS but always
        // emit to subscribers so AFK Telegram users see the task fire.
        skipOsNotification: launchLevel !== 'toast',
        onClick: () => {
          const win = openObservatory();
          win.focus();
          sendWhenReady(win, IpcChannels.observatoryFocusTask, summary.id);
        },
      });
    }
    if (summary.status === 'completed' || summary.status === 'errored' || summary.status === 'aborted') {
      launchAnnounced.delete(summary.id);
    }

    if (
      summary.origin !== 'external' &&
      (summary.status === 'completed' || summary.status === 'errored')
    ) {
      const titlePrefix =
        summary.origin === 'routine' ? 'Jarvis · routine' : 'Jarvis · task';
      const titleSuffix =
        summary.status === 'completed' ? 'complete' : 'failed';
      notifier.post({
        source: summary.status === 'completed' ? 'task-complete' : 'task-errored',
        title: `${titlePrefix} ${titleSuffix}`,
        body: summary.title,
        taskId: summary.id,
        onClick: () => openObservatory(),
      });
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
  // Workflow context must be set before init — running workflows
  // need the shared services (mcp/inbox/notifier/runner). Then the
  // scheduler wires cron jobs from whatever's already on disk.
  workflowRunner.setNodeContext({
    mcp,
    inbox,
    notifier,
    runner,
    jarvisRoot: join(homedir(), '.jarvis'),
  });
  workflows.init();
  workflowScheduler.init();

  // Reminder fire handler must be set BEFORE init() so past-due reminders
  // that fire on this tick land in the runner.
  //
  // Two modes, two paths:
  //   - 'reminder' (a nudge: "remind me to check email") → fires a native
  //     macOS Notification only. No Claude task, no cost, no transcript.
  //     Click opens the Inbox so the user can act on it. Logs to Activity
  //     so the user has a record of what was nudged.
  //   - 'scheduled' (an action: "in 2h, send the email") → spawns a Claude
  //     task with a "carry it out now" framing. Same flow as before.
  //
  // If the user wanted an agent to *think* about a nudge ("check if Luca
  // replied and then ping me"), they should phrase it as a scheduled
  // action — the parser already routes those to 'scheduled' based on
  // verbs / conditions.
  reminders.setFireHandler((reminder) => {
    const preview =
      reminder.body.length > 80 ? `${reminder.body.slice(0, 80)}…` : reminder.body;

    // Pause is a hard silencer for ANY auto-fired reminder — nudge mode
    // included. Mark fired so it doesn't re-trigger, log the skip, and
    // do not post a notification (the whole point of pausing is "leave
    // me alone"). The Activity tab still shows what was supposed to
    // fire; the user can re-issue manually if it actually mattered.
    if (loadPaused()) {
      activity.record({
        kind: 'reminder.fired',
        label:
          reminder.mode === 'reminder'
            ? `Reminder skipped (Jarvis paused) · ${preview}`
            : `Scheduled action skipped (Jarvis paused) · ${preview}`,
        detail: { id: reminder.id, body: reminder.body, paused: true },
      });
      reminders.markFired(reminder.id, null);
      return;
    }

    if (reminder.mode === 'reminder') {
      // Pure nudge — no Claude. Three signals so the user can't miss it:
      //   1. macOS notification (might be silenced by Focus mode or
      //      blocked by Notification perms).
      //   2. Activity log row — visible on the Activity tab.
      //   3. In-app toast via the activityChanged broadcast — renderers
      //      pop this regardless of OS state. See Shell.tsx.
      console.log(
        `[reminder] firing nudge id=${reminder.id} body="${preview}"`,
      );
      notifier.post({
        source: 'reminder',
        title: 'Reminder',
        body: preview,
        reminderId: reminder.id,
        onClick: () => {
          const win = openObservatory();
          win.focus();
          sendWhenReady(win, IpcChannels.shellNavigate, { tab: 'inbox' });
        },
      });
      activity.record({
        kind: 'reminder.fired',
        label: `Reminder fired · ${preview}`,
        detail: { id: reminder.id, body: reminder.body },
      });
      reminders.markFired(reminder.id, null);
      return;
    }

    // 'scheduled' — agent does the thing.
    // Global pause: notify the user that the scheduled time hit, but
    // skip the actual Claude turn. The reminder is marked fired (so it
    // doesn't re-trigger every minute), with firedTaskId=null. The
    // user can manually re-fire from the Reminders page once resumed.
    if (loadPaused()) {
      activity.record({
        kind: 'reminder.fired',
        label: `Scheduled action skipped (Jarvis paused) · ${preview}`,
        detail: { id: reminder.id, body: reminder.body, paused: true },
      });
      reminders.markFired(reminder.id, null);
      return;
    }
    let firedTaskId: string | null = null;
    const prompt = `It's the scheduled time you set earlier for this. Carry it out now using whatever tools fit (gh, slack, fs, etc.). If a precondition isn't met (e.g. "if Luca hasn't reviewed"), check first and skip the action accordingly. Task:\n\n${reminder.body}`;
    try {
      // origin stays 'palette' so the notification policy treats this
      // as user-initiated (the user did initiate it, just earlier in
      // time). reminderId is the real link back to the origin entity.
      // unattended: nobody is watching at the scheduled fire time — if
      // the agent ends with a question, that's a buggy framing and
      // the task should error rather than dangle.
      const t = runner.launch({
        prompt,
        origin: 'palette',
        reminderId: reminder.id,
        unattended: true,
      });
      firedTaskId = t.id;
      pushTaskToHud(t.id);
    } catch (e) {
      console.error('Scheduled action fire failed:', e);
    }
    reminders.markFired(reminder.id, firedTaskId);
    // Activity log: scheduled fires were missing this — only nudges
    // recorded the event before. Logging both modes means the Activity
    // feed shows every fire consistently.
    activity.record({
      kind: 'reminder.fired',
      label: `Scheduled action fired · ${preview}`,
      detail: { id: reminder.id, body: reminder.body, taskId: firedTaskId },
    });
    notifier.post({
      source: 'scheduled-action',
      title: 'Jarvis is on it',
      body: preview,
      reminderId: reminder.id,
      ...(firedTaskId ? { taskId: firedTaskId } : {}),
      onClick: () => {
        if (firedTaskId) {
          const win = openObservatory();
          win.focus();
          sendWhenReady(win, IpcChannels.observatoryFocusTask, firedTaskId);
        } else {
          openObservatory();
        }
      },
    });
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
      notifier.post({
        source: 'other',
        title,
        body,
        onClick: () => openObservatory(),
      });
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
    logActivity: (event) => activity.record(event),
    routePrompt: (input, opts) =>
      routePrompt(input, opts ?? {}, {
        modules,
        reminders,
        runner,
        authStatus: refreshAuth,
      }),
    awaitTurnResult: (taskId, opts) => awaitTurnResult(runner, taskId, opts),
    sendMessageToTask: async (taskId, text) => {
      const ok = runner.sendMessage(taskId, text);
      if (!ok) {
        throw new Error(
          `Cannot send message to task ${taskId}: not active or external.`,
        );
      }
    },
    abortTask: async (taskId) => {
      const ok = runner.abort(taskId);
      if (!ok) {
        throw new Error(`Cannot abort task ${taskId}: not running.`);
      }
    },
    isAfk: () => loadAfkMode(),
    setAfk: (value) => {
      saveAfkMode(value);
      broadcast(IpcChannels.afkChanged, value);
      refreshTrayMenu();
      activity.record({
        kind: 'afk.toggled',
        label: `AFK ${value ? 'on' : 'off'} (via module)`,
        detail: { afk: value },
      });
    },
    isPaused: () => loadPaused(),
    setPaused: (value) => {
      savePaused(value);
      broadcast(IpcChannels.pausedChanged, value);
      refreshTrayMenu();
      activity.record({
        kind: 'paused.toggled',
        label: `Jarvis ${value ? 'paused' : 'resumed'} (via module)`,
        detail: { paused: value },
      });
    },
    listReminders: () => reminders.list(),
    markReminderDone: (id) => {
      const before = reminders.list().find((r) => r.id === id);
      const ok = reminders.markDone(id);
      if (ok && before) {
        activity.record({
          kind: 'reminder.done',
          label: `Reminder marked done (via module) · ${before.body.slice(0, 80)}`,
          detail: { reminderId: id },
        });
      }
      return ok;
    },
    snoozeReminder: (id, msFromNow) => {
      const before = reminders.list().find((r) => r.id === id);
      const result = reminders.snooze(id, msFromNow);
      if (result && before) {
        activity.record({
          kind: 'reminder.snoozed',
          label: `Reminder snoozed ${Math.round(msFromNow / 60_000)}m (via module) · ${before.body.slice(0, 60)}`,
          detail: { reminderId: id, msFromNow },
        });
      }
      return result;
    },
    listSkills: () => skills.list(),
    getCostBreakdown: (windowDays) => getCostBreakdown(windowDays),
    classifyIntent: (message) => intentClassifier.classify(message),
    listWorkflows: () => workflows.list(),
    runWorkflow: (id) => {
      const def = workflows.get(id);
      if (!def) throw new Error(`Workflow not found: ${id}`);
      return workflowRunner.run(def, 'manual');
    },
  });
  await modules.register(quickNoteModule);
  await modules.register(claudeCodeWatchModule);
  await modules.register(meetingRecorderModule);
  await modules.register(statusModule);
  await modules.register(skillSuggesterModule);
  await modules.register(sendModule);
  await modules.register(prWorkflowsModule);
  await modules.register(calendarModule);
  await modules.register(remindersModule);
  await modules.register(shellNavModule);
  await modules.register(shellModule);
  await modules.register(workflowsModule);
  await modules.register(telegramBotModule);

  // Sync the auto-dedupe routine with the quick-note module's
  // dedupe cadence setting. Re-runs on every module-registry change so
  // the routine appears / disappears / shifts cron as the user tweaks
  // the toggle. Routine id is fixed so we always overwrite the same
  // record instead of accumulating duplicates.
  const DEDUPE_ROUTINE_ID = 'auto-dedupe-captures';
  const syncDedupeRoutine = () => {
    const settings = modules.readSettings('quick-note');
    if (!settings) return;
    const cadence = String(settings.dedupeCadence ?? 'off');
    const sensitivity = String(settings.dedupeSensitivity ?? 'medium');
    const existing = routines
      .list()
      .find((r) => r.id === DEDUPE_ROUTINE_ID);
    if (cadence === 'off') {
      if (existing) routines.remove(DEDUPE_ROUTINE_ID);
      return;
    }
    const cron = cadence === 'daily' ? '0 9 * * *' : '0 9 * * 1';
    const input = `Scan recent captures (notes + pending reminders) for duplicates. Sensitivity: ${sensitivity}.`;
    if (existing && existing.cron === cron && existing.input === input) {
      return; // no-op
    }
    routines.save({
      id: DEDUPE_ROUTINE_ID,
      skillId: 'dedupe-captures',
      cron,
      input,
      enabled: true,
      showInCalendar: false,
    });
  };
  modules.on('changed', () => syncDedupeRoutine());
  syncDedupeRoutine(); // initial sync at boot

  // One-shot: auto-seed inbox routines for `<name>-inbox` skills whose
  // matching MCP is present. The Inbox sources file is the canonical
  // location for "what's waiting on you" rows (slack-inbox.json,
  // linear-inbox.json, …), but they only get populated if a routine
  // runs the corresponding skill. Users wire the MCP, get the skill
  // seeded, then forget to add the routine — leaving the Inbox empty
  // of the very signals they configured for. Bridge that gap once,
  // record we did, never repeat (so deleting a routine sticks).
  syncAutoInboxRoutines(jarvisRoot, skills, mcp, routines, activity);
  skills.on('changed', () =>
    syncAutoInboxRoutines(jarvisRoot, skills, mcp, routines, activity),
  );
  mcp.on('changed', () =>
    syncAutoInboxRoutines(jarvisRoot, skills, mcp, routines, activity),
  );

  // ─── change → broadcast event fan-out ──────────────────────────────────────

  skills.on('changed', (list) => broadcast(IpcChannels.listSkills, list));
  mcp.on('changed', (list) => broadcast(IpcChannels.listMcpServers, list));
  routines.on('changed', (list) => broadcast(IpcChannels.routinesChanged, list));
  reminders.on('changed', (list) => {
    broadcast(IpcChannels.remindersChanged, list);
    setPendingRemindersCount(reminders.pendingCount());
  });
  // Activity log: reminders cover all four call paths (palette,
  // quick-note, intent-router, HTTP API) by hooking the store's
  // 'created' event instead of each caller individually.
  reminders.on('created', (reminder) => {
    const when = new Date(reminder.fireAt).toLocaleString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      day: 'numeric',
      month: 'short',
    });
    const body =
      reminder.body.length > 80
        ? `${reminder.body.slice(0, 79)}…`
        : reminder.body;
    activity.record({
      kind:
        reminder.mode === 'scheduled'
          ? 'reminder.scheduled'
          : 'reminder.created',
      label:
        reminder.mode === 'scheduled'
          ? `Scheduled action · ${when} · ${body}`
          : `Reminder set · ${when} · ${body}`,
      detail: { id: reminder.id, body: reminder.body, fireAt: reminder.fireAt },
    });
  });
  setPendingRemindersCount(reminders.pendingCount());

  skillSuggestions.on('changed', (list) =>
    broadcast(IpcChannels.skillSuggestionsChanged, list),
  );
  skillSuggestions.on('batch', ({ added }: { added: number }) => {
    notifier.post({
      source: 'skill-suggestion',
      title: 'Skill ideas',
      body: `Jarvis proposed ${added} new skill${added === 1 ? '' : 's'} based on your recent prompts`,
      onClick: () => openObservatory(),
    });
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
    notifier.post({
      source: 'inbox-new',
      title: 'Jarvis · new in inbox',
      body: parts.join(' · '),
      onClick: () => {
        const win = openObservatory();
        win.focus();
        sendWhenReady(win, IpcChannels.shellNavigate, { tab: 'inbox' });
      },
    });
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
    activity,
    briefings,
    dashboard,
    workflows,
    workflowRunner,
    workflowScheduler,
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
  // Seed the tray's "today" spend bit so it's accurate before the
  // first task status change. Without this, the tooltip would say
  // nothing about spend until a task fires — confusing in the morning
  // before any work has happened.
  try {
    setTodaySpend(getCostSummary().today);
  } catch {
    // DB not ready or empty — leave at 0.
  }
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

/**
 * One-shot auto-seeder for inbox routines. For each `<name>-inbox`
 * skill whose declared MCPs are all configured + enabled, check that:
 *   - No routine already fires it
 *   - We haven't auto-seeded for this skill before
 * If both checks pass, add a routine that fires the skill every 15
 * minutes and record the skill id in ~/.jarvis/auto-seeded-routines.json
 * so we never re-add (deletion sticks).
 *
 * This runs at boot and re-runs on skill / MCP changes (the user
 * could enable Linear MCP mid-session and the routine should appear).
 */
/**
 * Skills replaced by direct-JS inbox sources — must never get
 * auto-seeded routines, and any existing auto-seeded routines for
 * them should be disabled on startup (one-shot migration). Same goes
 * for any stale `~/.jarvis/inbox/{name}.json` files those routines
 * used to produce. */
const RETIRED_INBOX_SKILLS = new Set([
  'slack-inbox',
  'linear-inbox',
  'calendar-today',
]);
const RETIRED_INBOX_JSON_FILES = ['slack.json', 'linear.json', 'calendar.json'];

function syncAutoInboxRoutines(
  jarvisRoot: string,
  skills: SkillStore,
  mcp: McpConfigStore,
  routines: RoutineStore,
  activity: ActivityStore,
): void {
  // One-shot migration: disable any auto-seeded routines for skills
  // that have been replaced by direct-JS sources, and delete stale
  // JSON files those routines wrote. Idempotent — running twice is a
  // no-op because the second pass sees `enabled: false`.
  migrateRetiredInboxSkills(jarvisRoot, routines, activity);

  const markerPath = path.join(jarvisRoot, 'auto-seeded-routines.json');
  let seeded: Set<string>;
  try {
    if (existsSync(markerPath)) {
      const parsed = JSON.parse(readFileSync(markerPath, 'utf8')) as unknown;
      const ids =
        parsed && typeof parsed === 'object' && parsed !== null
          ? (parsed as { seededSkillIds?: unknown }).seededSkillIds
          : null;
      seeded = new Set(
        Array.isArray(ids) ? ids.filter((v): v is string => typeof v === 'string') : [],
      );
    } else {
      seeded = new Set();
    }
  } catch {
    seeded = new Set();
  }

  const inboxSkills = skills
    .list()
    .filter(
      (s) =>
        s.id.endsWith('-inbox') &&
        s.mcpServers.length > 0 &&
        !RETIRED_INBOX_SKILLS.has(s.id),
    );
  if (inboxSkills.length === 0) return;
  const mcpById = new Map(mcp.list().map((m) => [m.id, m]));
  const existingSkillIds = new Set(
    routines.list().map((r) => r.skillId).filter((id): id is string => !!id),
  );

  let changed = false;
  for (const skill of inboxSkills) {
    if (seeded.has(skill.id)) continue;
    if (existingSkillIds.has(skill.id)) {
      // User already wired a routine — record it as "seeded" so we
      // don't reconsider later if they delete that routine.
      seeded.add(skill.id);
      changed = true;
      continue;
    }
    // Wildcard mcp-servers ("*") means inherit-everything; treat as
    // satisfied as long as at least one MCP is configured.
    const wildcard = skill.mcpServers.includes('*');
    const allMcpsReady = wildcard
      ? mcpById.size > 0
      : skill.mcpServers.every((id) => {
          const entry = mcpById.get(id);
          return entry && !entry.disabled;
        });
    if (!allMcpsReady) continue;

    const routineId = `auto-inbox-${skill.id}`;
    routines.save({
      id: routineId,
      skillId: skill.id,
      cron: '*/15 * * * *',
      input: `Refresh ${skill.id}.`,
      enabled: true,
      showInCalendar: false,
    });
    activity.record({
      kind: 'routine.auto-seeded',
      label: `Routine auto-seeded · ${skill.id} every 15 min`,
      detail: { routineId, skillId: skill.id, cron: '*/15 * * * *' },
    });
    seeded.add(skill.id);
    changed = true;
  }

  if (changed) {
    try {
      mkdirSync(path.dirname(markerPath), { recursive: true });
      writeFileSync(
        markerPath,
        JSON.stringify({ seededSkillIds: [...seeded] }, null, 2) + '\n',
        'utf8',
      );
    } catch (err) {
      console.warn('auto-seed marker write failed:', err);
    }
  }
}

/**
 * One-shot migration: skills like slack-inbox / linear-inbox /
 * calendar-today used to run on cron and write JSON files. They've
 * been replaced by direct-JS inbox sources. Disable any auto-seeded
 * routines that still target the retired skills (don't delete — the
 * user may have customized them and we want their edits to come back
 * if they re-enable). Then sweep stale JSON files those routines wrote.
 *
 * Idempotent: second run sees `enabled: false` on the routines and
 * the JSON files already gone, so it does nothing.
 */
function migrateRetiredInboxSkills(
  jarvisRoot: string,
  routines: RoutineStore,
  activity: ActivityStore,
): void {
  for (const r of routines.list()) {
    if (!r.skillId) continue;
    if (!RETIRED_INBOX_SKILLS.has(r.skillId)) continue;
    // Auto-seeded routines (id prefix `auto-inbox-`) are entirely
    // owned by Jarvis — delete them outright so the Routines page
    // stops showing dead rows. Direct-JS inbox sources have replaced
    // them; there's nothing left to manage.
    //
    // User-authored routines that happen to target a retired skill
    // stay around as disabled — the user wrote them by hand and
    // might want them back if they ever invoke /<skill> manually.
    if (r.id.startsWith('auto-inbox-')) {
      routines.remove(r.id);
      activity.record({
        kind: 'routine.auto-disabled',
        label: `Auto-seeded routine removed · ${r.skillId} replaced by direct-JS inbox source`,
        detail: { routineId: r.id, skillId: r.skillId, removed: true },
      });
      continue;
    }
    if (r.enabled === false) continue;
    routines.save({ ...r, enabled: false });
    activity.record({
      kind: 'routine.auto-disabled',
      label: `Routine disabled · ${r.skillId} replaced by direct-JS inbox source`,
      detail: { routineId: r.id, skillId: r.skillId, removed: false },
    });
  }
  const inboxDir = path.join(jarvisRoot, 'inbox');
  for (const filename of RETIRED_INBOX_JSON_FILES) {
    const filePath = path.join(inboxDir, filename);
    if (!existsSync(filePath)) continue;
    try {
      unlinkSync(filePath);
      activity.record({
        kind: 'inbox.json-migrated',
        label: `Stale inbox JSON removed · ${filename}`,
        detail: { filename, path: filePath },
      });
    } catch (err) {
      console.warn(`[migrate-inbox] failed to remove ${filePath}:`, err);
    }
  }
}
