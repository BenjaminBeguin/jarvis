import {
  app,
  globalShortcut,
  ipcMain,
  nativeImage,
  powerSaveBlocker,
  shell,
} from 'electron';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Surface any uncaught errors so silent native crashes (ONNX
// Runtime / transformers.js segfaults, …) show up in the dev
// console instead of just exiting the process. macOS will still
// fire on SIGSEGV — these handlers only catch JS-level throws —
// but at least we get something visible when the JS layer is the
// one going down.
process.on('uncaughtException', (err) => {
  console.error('[main:uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main:unhandledRejection]', reason);
});
process.on('exit', (code) => {
  console.error(`[main:exit] code=${code}`);
});

import { IpcChannels } from '@shared/ipc';
import type {
  AppStatus,
  Goal,
  InboxItem,
  Reminder,
  TaskEvent,
  TaskSummary,
  WorkflowRun,
} from '@shared/types';

import {
  detectClaudeBinary,
  loadAfkMode,
  loadAppMode,
  loadAuthMode,
  loadCostPrefs,
  loadModuleSettings,
  loadNotificationPrefs,
  loadPaused,
  loadWorkingHours,
  saveAfkMode,
  saveAppMode,
  savePaused,
} from './auth.js';
import {
  artifactIdFromVscodeUrl,
  backfillArtifacts,
  startArtifactWatchers,
  stopArtifactWatchers,
  upsertArtifact,
} from './artifacts/index.js';
import { awaitTurnResult } from './await-turn.js';
import { recordBrowserActivity } from './browser-activity.js';
import { warmUpEmbeddings } from './embeddings/embed-worker-host.js';
import { notifier } from './notifier.js';
import { routePrompt } from './route-prompt.js';
import { BriefingsStore } from './briefings.js';
import {
  closeDatabase,
  getCostBreakdown,
  getCostSummary,
  initDatabase,
  reapZombieRunningTasks,
  listRecentTasks,
  pruneWorkflowRuns,
} from './db.js';
import { startHttpServer, type HttpServerHandle } from './http-server.js';
import { initPush, pushToAll } from './push.js';
import { ActivityStore } from './activity-store.js';
import { DraftsStore } from './drafts-store.js';
import { IntegrationsStore } from './integrations-store.js';
import { IntentClassifier } from './intent-classifier.js';
import { createJarvisMcp } from './jarvis-mcp.js';
import { GoalStore } from './goals.js';
import { InboxStore } from './inbox.js';
import { ConnectorRegistry } from './oauth/connector-registry.js';
import { OAuthOrchestrator } from './oauth/orchestrator.js';
import { TokenRefresher } from './oauth/refresher.js';
import { githubConnector } from './oauth/connectors/github.js';
import { googleConnector } from './oauth/connectors/google.js';
import { linearConnector } from './oauth/connectors/linear.js';
import { notionConnector } from './oauth/connectors/notion.js';
import { slackConnector } from './oauth/connectors/slack.js';
import { testEchoConnector } from './oauth/connectors/test-echo.js';
import type {
  ConnectorHooks,
  ConnectorTokenPayload,
} from './oauth/types.js';
import {
  clearConnectorToken,
  getConnectorToken,
  setConnectorToken,
} from './secrets.js';
import { InboxEventBridge } from './autopilot/inbox-event-bridge.js';
import { approvalBridge } from './autopilot/approval-bridge.js';
import { InboxProximityWatcher } from './inbox-proximity.js';
import { MeetingActivityWatcher } from './meeting-activity-watcher.js';
import { BUILTIN_BRIEFING_KINDS } from './seeds/briefing-kinds.js';
import { BUILTIN_WORKFLOWS } from './seeds/workflows/index.js';
import {
  failedRoutinesInboxSource,
  goalsInboxSource,
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
import { askModule } from './modules/ask.js';
import { browserModule } from './modules/browser.js';
import { calendarModule } from './modules/calendar.js';
import { claudeCodeWatchModule } from './modules/claude-code-watch.js';
import { dailyLearnModule } from './modules/daily-learn.js';
import { goalsModule } from './modules/goals.js';
import { jarvisSelfGradeModule } from './modules/jarvis-self-grade.js';
import { morningBriefModule } from './modules/morning-brief.js';
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
import { workAwarenessModule } from './modules/work-awareness.js';
import { workflowsModule } from './modules/workflows.js';
import { parseIntent } from './intent-router.js';
import { ProjectMemoryStore } from './project-memory.js';
import { ProjectStore } from './projects.js';
import { WorkspaceStore } from './workspaces.js';
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
import { asTaskOrigin, lastAssistantText, TaskRunner } from './task-runner.js';
import { setProgressEmitter } from './modules/voice/transcribe.js';
import { speechEvents, stopSpeaking } from './modules/voice/speech.js';
import { voiceModule } from './modules/voice/index.js';
import {
  activeProjectProfileProvider,
  activeProjectProvider,
  browserActivityProvider,
  eagerRagProvider,
  inboxHighlightsProvider,
  projectsProvider,
  recentArtifactsProvider,
  recentTaskProvider,
  runtimeProvider,
  timeProvider,
  UserContextStore,
} from './user-context.js';
import {
  getTrayMenuState,
  initTray,
  refreshTrayMenu,
  setAbortAllHandler,
  setAwaitingRepliesCount,
  setMeetingRecording,
  setPendingRemindersCount,
  setRunningTasksCount,
  setTodaySpend,
} from './tray.js';
import {
  broadcast,
  getObservatoryWindow,
  hideVoiceOrb,
  openObservatory,
  openPalette,
  sendWhenReady,
  setAppQuitting,
  showVoiceOrb,
  surfaceConversation,
} from './windows.js';

// The Agent SDK attaches a `process.on('exit', …)` cleanup hook per
// query() invocation. Each Task = one query(), so with a dozen
// concurrent tasks we trip Node's default cap of 10 and log a
// MaxListenersExceededWarning. Raise the ceiling once at startup —
// 50 leaves clear headroom while still catching a genuine leak that
// would push past that.
process.setMaxListeners(50);

// ─── stores (Electron-free; pure domain logic) ───────────────────────────────

const skills = new SkillStore();
const mcp = new McpConfigStore();
const workspaces = new WorkspaceStore();
const projects = new ProjectStore();
const runner = new TaskRunner();
const routines = new RoutineStore();
const reminders = new ReminderStore();
const goals = new GoalStore();
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
const connectorRegistry = new ConnectorRegistry();
const integrationsStore = new IntegrationsStore(
  join(homedir(), '.jarvis', 'integrations.json'),
  connectorRegistry,
);
const oauthOrchestrator = new OAuthOrchestrator(connectorRegistry, {
  upsertAccount: (account) => integrationsStore.upsert(account),
});
const tokenRefresher = new TokenRefresher(connectorRegistry, integrationsStore);
const inbox = new InboxStore();
const drafts = new DraftsStore();
const activity = new ActivityStore();
const briefings = new BriefingsStore(BUILTIN_BRIEFING_KINDS);
const workflows = new WorkflowStore();
const workflowRunner = new WorkflowRunner();
const workflowScheduler = new WorkflowScheduler(workflows, workflowRunner, {
  isPaused: () => loadPaused(),
  isAutopilot: () => loadAppMode() === 'autopilot',
  workingHours: () => loadWorkingHours(),
});
// Dispatches autopilot/`when: 'inbox-changed'` workflows on InboxStore
// emissions. Started + stopped alongside other scheduler-style
// services in app lifecycle hooks below.
const inboxEventBridge = new InboxEventBridge({
  inbox,
  workflows,
  runner: workflowRunner,
  isAutopilot: () => loadAppMode() === 'autopilot',
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
  // Imminent meeting prompt — calendar item is about to start, ask
  // the user if they want to record it. Routes through the same
  // settle window as the audio + extension paths so any "meeting
  // cancelled / user already left / I'm not actually going to it"
  // signal in the next few seconds can intercept. Keyed by the
  // calendar item id so a re-fire from the proximity watcher
  // doesn't stack timers.
  (item, _minutesUntil) => {
    scheduleMeetingHeadsUp(item, `calendar:${item.id}`);
  },
);

// Wire the renderer's "Skip" button so we don't re-prompt for the same
// item every minute when the user dismissed it.
// Ad-hoc meeting detection: when macOS reports the system mic or
// camera went active and no calendar prompt is in flight, fire the
// same "want to record this?" toast. Catches Google Meet, Zoom,
// Discord, FaceTime, etc. — anything that touches Core Audio / CMIO.
// macOS-only; no-op on other platforms.
/**
 * "Quiet for the next N ms" — set by the renderer when the user
 * clicks Snooze on a heads-up. RAM-only on purpose: snooze is a
 * "leave me alone for the rest of this work session" intent, not a
 * persisted preference. App restart clears it.
 */
let meetingHeadsUpSnoozedUntil = 0;

/**
 * Surface a "record this meeting?" heads-up. Used both by the macOS
 * Core Audio watcher (mic/cam went hot at the OS level) AND by the
 * HTTP endpoint that the Chrome extension hits when it detects a
 * meeting in a Meet/Zoom/Teams tab. Single funnel so the renderer's
 * MeetingPrompt component only has one channel to listen on.
 *
 * Fires THREE surfaces in parallel:
 *   - The Jarvis window toast (MeetingPrompt component) — primary
 *     interaction surface with [Record] / [Join] / [Skip] buttons.
 *   - macOS Notification Center via notifier.post() — so the user
 *     sees it even when their browser/Meet tab is in front on
 *     another space.
 *   - Web Push to the paired phone (the notifier subscription auto-
 *     fans every event out via push.ts).
 *
 * The notifier respects global pause; if Jarvis is paused, the OS
 * notification + push are suppressed but the in-app toast still
 * fires (pause is about unattended work, not silencing user-visible
 * UI in the foreground window).
 */
/**
 * Pending "record this meeting?" prompts. Each entry is keyed by a
 * detection-source id (vendor for the Chrome extension, "audio" for
 * the mic watcher, the calendar event id for proximity fires) so
 * incoming cancellation signals — meeting-ended, the user clicking
 * Dismiss on a sibling prompt, etc. — can find and abort the right
 * pending fire. Empty when no prompts are queued.
 */
const pendingMeetingPrompts = new Map<string, NodeJS.Timeout>();

/** Settle window before a meeting prompt actually fires. Short
 *  enough to feel responsive when the user did join a real meeting
 *  ("a couple seconds before the toast appears"), long enough to
 *  catch the common race where Chrome's content script detects join
 *  and then immediately detects leave (e.g. the user clicks Leave a
 *  beat after Join, or the join lobby never actually crosses into
 *  the call). */
const MEETING_PROMPT_SETTLE_MS = 4_000;

/**
 * Queue a meeting heads-up for `MEETING_PROMPT_SETTLE_MS` from now.
 * The settle window gives any subsequent cancellation signal
 * (Chrome extension reports the meeting ended, the user toggles
 * AFK off, the duplicate-detection bucket catches up) a chance to
 * intercept BEFORE the user sees the prompt. Calling this with the
 * same key while a prompt is already pending replaces the prior
 * timer — newer detection wins.
 */
function scheduleMeetingHeadsUp(item: InboxItem, key: string): void {
  const existing = pendingMeetingPrompts.get(key);
  if (existing) clearTimeout(existing);
  console.log(
    `[meeting-heads-up] scheduled prompt key=${key} settle=${MEETING_PROMPT_SETTLE_MS}ms`,
  );
  const timer = setTimeout(() => {
    pendingMeetingPrompts.delete(key);
    fireMeetingHeadsUp(item);
  }, MEETING_PROMPT_SETTLE_MS);
  pendingMeetingPrompts.set(key, timer);
}

/**
 * Cancel any pending meeting heads-up prompts. Called when an
 * authoritative "you're not in a meeting anymore" signal arrives in
 * the settle window — most commonly the Chrome extension reporting
 * the user closed the tab / left the call seconds after joining.
 * Passing a key cancels just that one prompt; no key cancels all.
 */
function cancelPendingMeetingPrompts(key?: string): void {
  if (key) {
    const t = pendingMeetingPrompts.get(key);
    if (t) {
      clearTimeout(t);
      pendingMeetingPrompts.delete(key);
      console.log(`[meeting-heads-up] cancelled pending prompt key=${key}`);
    }
    return;
  }
  if (pendingMeetingPrompts.size === 0) return;
  console.log(
    `[meeting-heads-up] cancelled ${pendingMeetingPrompts.size} pending prompt(s)`,
  );
  for (const t of pendingMeetingPrompts.values()) clearTimeout(t);
  pendingMeetingPrompts.clear();
}

function fireMeetingHeadsUp(item: InboxItem): void {
  if (Date.now() < meetingHeadsUpSnoozedUntil) {
    console.log(
      `[meeting-heads-up] snoozed (${Math.round((meetingHeadsUpSnoozedUntil - Date.now()) / 60_000)} min left); dropping prompt`,
    );
    return;
  }
  // Already-recording guard. The Chrome extension and the audio
  // watcher both fire detection signals while a meeting is in
  // progress — if the user has already hit Record on this (or any)
  // session, the heads-up prompt would just be asking "record this
  // meeting you're already recording?" which is confusing. Suppress.
  // Cancelling / finishing the active recording clears the gate;
  // a subsequent detection then fires normally.
  if (currentMeetingState.active) {
    console.log(
      '[meeting-heads-up] dropping prompt — recording already in progress',
    );
    return;
  }
  // Freshness check: for items that came from the inbox (calendar
  // proximity, mostly), re-verify the underlying item still exists.
  // Calendar workflow runs every 15 min; if the user cancelled the
  // event since the last refresh, the item is gone from the live
  // store — fire would point at a meeting that no longer exists.
  // Ad-hoc detections (audio / extension with `ad-hoc-*` ids) skip
  // this check — they don't live in the inbox store, they're
  // ephemeral one-shot items minted at detection time.
  const isInboxItem = !item.id.startsWith('ad-hoc-');
  if (isInboxItem) {
    // inbox.list() already filters out dismissed/snoozed items, so
    // one lookup covers both cases: cancelled meeting AND user hit
    // ✓ Done / 💤 snoozed during the settle window.
    const current = inbox.list().find((it) => it.id === item.id);
    if (!current) {
      console.log(
        `[meeting-heads-up] item ${item.id} no longer in inbox (cancelled or dismissed); dropping prompt`,
      );
      return;
    }
    // Use the freshest copy — calendar workflow may have updated
    // title / url / fireAt since the proximity watcher captured
    // the original snapshot.
    item = current;
  }
  try {
    const win = openObservatory();
    win.focus();
    sendWhenReady(win, IpcChannels.meetingImminent, { item, minutesUntil: 0 });
  } catch (err) {
    console.warn('Meeting heads-up broadcast failed:', err);
  }
  // Mirror to macOS Notification Center + Web Push so the user sees
  // it when the Jarvis window isn't visible. Clicking the OS
  // notification brings Jarvis forward + jumps to the Inbox where
  // the heads-up item lives.
  try {
    notifier.post({
      source: 'meeting-heads-up',
      title: item.title,
      body: item.subtitle ?? 'Tap to record',
      // skipOsNotification stays false (the default) so this fires
      // the native OS notification AND fans out to subscribers
      // (Telegram bot, mobile PWA via Web Push).
      onClick: () => {
        const w = openObservatory();
        w.focus();
        sendWhenReady(w, IpcChannels.shellNavigate, { tab: 'inbox' });
      },
    });
  } catch (err) {
    console.warn('Meeting heads-up notifier post failed:', err);
  }
}

/** Read the meeting-recorder module's detection-source setting.
 *  Returns the normalized value with safe defaults — unknown values
 *  fall back to 'both' so a corrupted config never silently disables
 *  detection. */
function meetingDetectionSource(): 'audio' | 'extension' | 'both' | 'off' {
  const cfg = loadModuleSettings('meeting-recorder');
  const v = cfg.detectionSource;
  if (v === 'audio' || v === 'extension' || v === 'both' || v === 'off') {
    return v;
  }
  return 'both';
}

const meetingActivity = new MeetingActivityWatcher((item) => {
  // Audio-watcher path gates on the user's choice. When the user
  // has set "extension only" they don't want the mic-activity
  // heuristic to fire — it false-positives on dictation + voice
  // notes. The watcher still RUNS (selfMicStart/Stop bookkeeping
  // matters elsewhere), it just doesn't prompt.
  const source = meetingDetectionSource();
  if (source !== 'audio' && source !== 'both') return;
  // Use the settle window so any near-simultaneous "meeting ended"
  // signal from the Chrome extension can intercept the prompt.
  scheduleMeetingHeadsUp(item, 'audio');
});

/**
 * Forward a remote-control command (`pause` / `resume` / `cancel` /
 * `finish`) from the phone PWA to the renderer's MeetingRecorder.
 * Returns true when there's any open window to receive it. Renderer
 * subscribes to IpcChannels.meetingControlRemote and dispatches to
 * the MeetingRecorder singleton.
 */
function onMeetingControlFromHttp(
  action: 'pause' | 'resume' | 'cancel' | 'finish',
): boolean {
  if (!currentMeetingState.active && action !== 'finish') {
    // No active recording — pause/resume/cancel are no-ops. We still
    // let 'finish' through in case the renderer is in the
    // post-Finish transcribing state where active=false but the
    // chain is still running (it's idempotent there).
    return false;
  }
  try {
    broadcast(IpcChannels.meetingControlRemote, { action });
    return true;
  } catch (err) {
    console.warn('[meeting] broadcast control failed:', err);
    return false;
  }
}

/** Wall-clock of the last /v1/meeting/detected we got from the
 *  Chrome extension. Used to know whether the current recording was
 *  triggered by the extension — onMeetingEnded only auto-finishes
 *  recordings that started with extension signal, to avoid stopping
 *  an unrelated in-person follow-up the user manually kicked off. */
let lastExtensionDetectedAt = 0;

/**
 * Handle a /v1/meeting/detected POST from the Chrome extension (or
 * any external caller). Build an InboxItem-shaped payload and route
 * it through the same heads-up flow as the OS-level watcher.
 */
function onExternalMeetingDetected(payload: {
  source: string;
  title?: string;
  url?: string;
  vendor?: string;
}): void {
  if (payload.source === 'extension') {
    lastExtensionDetectedAt = Date.now();
  }
  // Detection-source gate. When the user has set "audio only" or
  // "off", swallow the extension ping — we still record the
  // lastExtensionDetectedAt above so the user can verify the
  // extension is wired by toggling the setting on later.
  const source = meetingDetectionSource();
  if (source !== 'extension' && source !== 'both') return;

  const vendorLabel = payload.vendor
    ? payload.vendor.charAt(0).toUpperCase() + payload.vendor.slice(1)
    : 'Browser';
  // Bucket by minute so a single tab pinging twice in quick
  // succession doesn't double-prompt. Different from the audio
  // watcher's cooldown but achieves the same outcome via id dedupe
  // in the renderer.
  const id = `ad-hoc-ext-${payload.vendor ?? 'unknown'}-${Math.floor(Date.now() / 60_000)}`;
  const item: InboxItem = {
    id,
    source: 'meeting-activity',
    title: payload.title
      ? `${payload.title} — record this?`
      : `${vendorLabel} meeting detected — record this?`,
    subtitle: `Detected via ${payload.source}${payload.vendor ? ` · ${payload.vendor}` : ''}`,
    ...(payload.url ? { url: payload.url } : {}),
    createdAt: Date.now(),
  };
  // Queue with a settle window. The most common race we want to
  // catch here is "Chrome content script detected join, user closed
  // the tab a beat later" — the extension's tabs.onRemoved fires
  // meeting-ended within ~1s and we want THAT to win over the
  // prompt fire. Key by vendor so the same vendor pinging twice
  // collapses to one pending prompt instead of stacking.
  scheduleMeetingHeadsUp(item, `extension:${payload.vendor ?? 'unknown'}`);
}

/**
 * Chrome extension reported the browser meeting ended. If a Jarvis
 * recording is active AND the meeting-recorder module has
 * `autoStopOnExtensionEnd` on (default true), forward a 'finish'
 * control action — same path the PWA's Finish button uses.
 */
function onExternalMeetingEnded(_payload: { vendor?: string; url?: string }): void {
  // First: cancel any pending heads-up prompt for this vendor (or
  // the audio path), since the user already left. This is the
  // primary "make sure the meeting still exists" guarantee — the
  // settle window in scheduleMeetingHeadsUp paired with this
  // cancellation means a quick join → leave never produces a stale
  // prompt. We cancel BOTH the extension-keyed prompt for this
  // vendor AND the audio-keyed one in case the mic watcher fired
  // for the same call.
  cancelPendingMeetingPrompts(
    `extension:${_payload.vendor ?? 'unknown'}`,
  );
  cancelPendingMeetingPrompts('audio');

  if (!currentMeetingState.active) return;
  const settings = loadModuleSettings('meeting-recorder');
  // Default true. Explicit `false` opts out.
  if (settings.autoStopOnExtensionEnd === false) return;
  // Only auto-stop if the CURRENT recording was likely triggered by
  // the extension. Heuristic: an extension /v1/meeting/detected ping
  // landed within the 3h window covering this meeting. If the user
  // started an unrelated in-person meeting via /meeting and the
  // extension fires "meeting ended" from a stale tab, we don't want
  // to cut their recording.
  const recencyMs = Date.now() - lastExtensionDetectedAt;
  if (lastExtensionDetectedAt === 0 || recencyMs > 3 * 60 * 60_000) {
    console.log(
      '[meeting] ignoring extension meeting-ended — no recent extension detection on file',
    );
    return;
  }
  console.log(
    '[meeting] chrome extension reported meeting ended — auto-finishing recording',
  );
  try {
    broadcast(IpcChannels.meetingControlRemote, { action: 'finish' });
    activity.record({
      kind: 'meeting.auto-finished',
      label: 'Meeting auto-finished · browser meeting ended',
      detail: {},
    });
  } catch (err) {
    console.warn('[meeting] auto-finish broadcast failed:', err);
  }
}

ipcMain.handle(IpcChannels.suppressMeetingPrompt, (_e, id: string) => {
  if (typeof id !== 'string') return;
  // Route to whichever watcher owns this id. Ad-hoc ids carry the
  // 'ad-hoc-' prefix; everything else is a calendar item id.
  if (id.startsWith('ad-hoc-')) meetingActivity.suppress(id);
  else inboxProximity.suppressMeetingPrompt(id);
});

/** Snooze ALL meeting heads-up prompts for the next `ms`. Used by the
 *  Snooze button in MeetingPrompt.tsx — "leave me alone for the next
 *  hour while I focus." RAM-only; restart clears. */
ipcMain.handle(IpcChannels.snoozeMeetingHeadsUp, (_e, ms: number) => {
  const dur = typeof ms === 'number' && ms > 0 ? Math.min(ms, 8 * 60 * 60_000) : 60 * 60_000;
  meetingHeadsUpSnoozedUntil = Date.now() + dur;
  // Also kill anything in the settle window — if the user just
  // snoozed, they don't want a pending prompt to fire in 3 seconds.
  cancelPendingMeetingPrompts();
  console.log(
    `[meeting-heads-up] snoozed for ${Math.round(dur / 60_000)} min`,
  );
  return { until: meetingHeadsUpSnoozedUntil };
});

/**
 * Mirror MeetingRecorder state from the renderer into:
 *   - the tray: 🔴/⏸ prefix + tooltip mentions the live meeting
 *     so the user knows the mic is hot even with the window closed.
 *   - the OS power-save blocker: prevents the display from sleeping
 *     while a recording is active. Released on stop/cancel/abort.
 *   - module-level `currentMeetingState` slot the HTTP server reads
 *     to expose recording state over SSE to the phone PWA.
 *
 * The renderer is the source of truth for recording state (the
 * AudioCapture lives there); main just reflects it.
 */
let powerSaveBlockerId: number | null = null;
interface MirroredRecordingState {
  active: boolean;
  paused: boolean;
  title: string | null;
  /** Wall-clock ms when the recording started, OR null when no
   *  active recording. The phone derives elapsed display from
   *  this — main doesn't need to push every second. */
  startedAt: number | null;
}
let currentMeetingState: MirroredRecordingState = {
  active: false,
  paused: false,
  title: null,
  startedAt: null,
};
type MeetingStateListener = (s: MirroredRecordingState) => void;
const meetingStateListeners = new Set<MeetingStateListener>();
function subscribeMeetingState(l: MeetingStateListener): () => void {
  meetingStateListeners.add(l);
  return () => meetingStateListeners.delete(l);
}
ipcMain.handle(
  IpcChannels.meetingRecorderState,
  (_e, state: { active: boolean; paused: boolean; title: string | null }) => {
    setMeetingRecording(state);
    // Persist + fan-out. We only stamp startedAt on the active=true
    // transition so a pause/resume cycle keeps the same anchor.
    const wasActive = currentMeetingState.active;
    currentMeetingState = {
      active: state.active,
      paused: state.paused,
      title: state.title,
      startedAt: state.active
        ? wasActive
          ? currentMeetingState.startedAt
          : Date.now()
        : null,
    };
    for (const l of meetingStateListeners) {
      try {
        l(currentMeetingState);
      } catch (err) {
        console.warn('[meeting] state listener threw:', err);
      }
    }
    if (state.active && !state.paused) {
      if (powerSaveBlockerId === null) {
        try {
          // 'prevent-display-sleep' is the strictest mode — it also
          // implies 'prevent-app-suspension'. Without this, a long
          // call would let macOS dim/sleep + the renderer audio loop
          // would stall when the lid stays open but the system idles.
          powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
        } catch (err) {
          console.warn('[meeting] powerSaveBlocker start failed:', err);
        }
      }
    } else if (powerSaveBlockerId !== null) {
      // Released on stop, cancel, AND pause — paused recordings
      // aren't capturing samples, so there's no need to keep the
      // display awake. resume re-arms.
      try {
        powerSaveBlocker.stop(powerSaveBlockerId);
      } catch {
        /* already gone */
      }
      powerSaveBlockerId = null;
    }
  },
);

// Renderer can pull the current watcher state on demand (e.g. when
// the Now view mounts and wants to show "auto-detect quiet → record
// manually" instead of pretending it's working).
ipcMain.handle(IpcChannels.meetingDetectionStatus, () => meetingActivity.status());

// Self-mic suppression — palette voice + composer mic flip this on
// during their capture so the meeting auto-detect doesn't prompt
// the user to record their own ⌘⇧Space.
ipcMain.handle(IpcChannels.noteSelfMicStart, () => {
  meetingActivity.noteSelfMicStart();
});
ipcMain.handle(IpcChannels.noteSelfMicStop, () => {
  meetingActivity.noteSelfMicStop();
});

// Voice orb: lets the orb's React component dismiss its own
// window after dispatching the transcribed prompt or after the
// user hits Escape.
ipcMain.handle(IpcChannels.voiceOrbHide, () => {
  hideVoiceOrb();
});
// Broadcast on every status change so a permanently-mounted status
// pill in the Shell can react without polling.
meetingActivity.on('status', (status) => {
  broadcast(IpcChannels.meetingDetectionChanged, status);
});
// Built-in context providers — ambient signal injected into every Claude
// turn so the agent answers daily questions ("what's my plan today?",
// "who's waiting on me?", "are you paused?") from cached context instead
// of round-tripping through tools.
//
// Order matters — first registered is first in the prepended block, which
// also fixes the prompt-cache prefix shape. Module-owned providers (e.g.
// calendar, reminders) register themselves in their module's onLoad, so
// they land AFTER these core ones in the final block — see
// modules/calendar.ts and modules/reminders.ts for the reference pattern.
userContext.register(timeProvider);
userContext.register(runtimeProvider(() => getTrayMenuState()));
userContext.register(activeProjectProvider(userContext));
userContext.register(activeProjectProfileProvider(userContext, projects));
userContext.register(projectsProvider(projects));
userContext.register(inboxHighlightsProvider(inbox));
userContext.register(recentTaskProvider(runner));
userContext.register(browserActivityProvider);
userContext.register(recentArtifactsProvider);
userContext.register(eagerRagProvider(userContext));

// Built-in inbox sources — all direct JS, no agent fires.
//   - reminders / failed-routines: local stores
//   - PR queues: gh CLI via execFile (pattern from inbox-sources/gh.ts)
//   - linear / slack / calendar: replaced the cron-fired *-inbox skills
//     with direct API/AppleScript calls. Tokens come from ~/.jarvis/mcp.json
//     (the same ones the MCP servers already use). No-op gracefully when
//     tokens are missing or the platform doesn't support them.
inbox.register(remindersInboxSource(reminders));
inbox.register(goalsInboxSource(goals));
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
// Each classifier turn spawns a fresh Claude session that
// claude-code-watch would otherwise mirror as an external "jarvis ·
// session XXX" row. Have the classifier register each session id with
// the runner so the watcher's existing isOwnedSessionId() filter
// catches them.
intentClassifier.setSessionTracker((id) => runner.registerInternalSessionId(id));
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
    inbox,
    drafts,
    mcp,
    routines,
    runner,
    goals,
    setAppMode: (mode) => {
      const prev = loadAppMode();
      if (prev === mode) return;
      saveAppMode(mode);
      // Mirror the auth IPC handler: both event broadcasts + tray
      // refresh + activity record. Lets the tray menu's checkmarks
      // re-render without waiting for the next user-initiated toggle.
      broadcast(IpcChannels.appModeChanged, mode);
      broadcast(IpcChannels.pausedChanged, mode === 'paused');
      refreshTrayMenu();
      activity.record({
        kind: 'mode.changed',
        label: `Jarvis ${prev} → ${mode} (via agent tool)`,
        detail: { from: prev, to: mode, source: 'mcp' },
      });
    },
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
/**
 * "Surface this task in the UI." Used by:
 *   - the launch HUD bridge (palette + Inbox + module dispatches),
 *   - the meeting recorder when auto-debrief opens,
 *   - anywhere main wants to push a task into view.
 *
 * Routing is unified through surfaceConversation: focused main
 * window → sidebar tab; otherwise → floating chat-popup so we
 * don't steal focus from whatever the user is currently using.
 *
 * The 'silent' notification preference suppresses the surface
 * entirely — task still runs, but the UI doesn't pop.
 */
function pushTaskToHud(taskId: string): void {
  const launchLevel = loadNotificationPrefs().onLaunch;
  if (launchLevel === 'silent') return;
  surfaceConversation(taskId);
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

/**
 * Mirror notifier.post() to every registered Web Push subscription
 * (the mobile PWA, once the user has paired + granted notifications).
 * Pause already short-circuits AUTO_SOURCES inside notifier.post itself,
 * so by the time we get here a paused Jarvis won't be sending pushes
 * for cron-fired stuff. Task lifecycle events still come through —
 * that matches the desktop behaviour and is what the user wants on
 * the phone too. The fan-out is fire-and-forget; failures (stale
 * endpoints, network) are handled inside pushToAll.
 */
notifier.subscribe((e) => {
  const payload = {
    title: e.title,
    body: e.body,
    source: e.source,
    ...(e.taskId ? { taskId: e.taskId } : {}),
    ...(e.reminderId ? { reminderId: e.reminderId } : {}),
    ts: Date.now(),
  };
  void pushToAll(payload).catch((err) => {
    console.warn('[push] fan-out failed:', err);
  });
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
        // Body is the agent's actual question, not the user's original
        // prompt. Echoing the prompt back was not actionable — the user
        // would see "Walk me through calibrating…" (what they sent) and
        // have nothing to Approve/Edit/Cancel against. Falling back to
        // the title only covers the no-assistant-text case.
        const agentText = lastAssistantText(runner.getEvents(summary.id));
        const rawBody = agentText ?? summary.title;
        const preview =
          rawBody.length > 280 ? `${rawBody.slice(0, 280)}…` : rawBody;
        if (askLevel !== 'silent') {
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
  // Voice trigger — pops the Jarvis-style listening orb (a small
  // floating BrowserWindow with a pulsing cyan circle) instead of
  // the full palette UI. Tap once to start listening, again to
  // stop + transcribe + dispatch via routePrompt. Esc inside the
  // orb cancels without dispatching.
  const voiceAccel = 'CommandOrControl+Shift+Space';
  const voiceOk = globalShortcut.register(voiceAccel, () => {
    const win = showVoiceOrb();
    sendWhenReady(win, IpcChannels.voiceOrbToggle, undefined);
  });
  if (!voiceOk) {
    console.warn(`failed to register global shortcut ${voiceAccel}`);
  }
  // Quick "shut up" shortcut — cancels any in-flight TTS without
  // requiring the user to find the palette or click a button. ⌘⇧.
  // sits next to ⌘⇧J + ⌘⇧Space so the trio of voice shortcuts share
  // a finger pattern.
  const shushAccel = 'CommandOrControl+Shift+.';
  const shushOk = globalShortcut.register(shushAccel, () => {
    stopSpeaking();
  });
  if (!shushOk) {
    console.warn(`failed to register global shortcut ${shushAccel}`);
  }
}

/**
 * Call connector.init() for every registered connector that
 * implements it. Used at boot to warm caches (GitHub's stdio MCP
 * needs the PAT in main-process memory because mcpEntries is sync).
 * Connectors without init() are skipped — most don't need it.
 */
/**
 * One-shot migration on first launch with workspaces enabled. Any
 * project that doesn't carry a `workspaceId` gets the default
 * workspace stamped on it. Idempotent — a second launch finds every
 * project already tagged and no-ops, so we can leave this on every
 * boot without worrying.
 *
 * Same pattern we'd use for routines / workflows / reminders if we
 * ever start gating those by workspace too — call this from boot,
 * skip the work when nothing's stale.
 */
function backfillProjectWorkspaces(): void {
  const defaultId = workspaces.getDefault().id;
  const stale = projects.list().filter((p) => !p.workspaceId);
  if (stale.length === 0) return;
  console.info(
    `[workspaces] backfilling ${stale.length} project(s) with default workspace "${defaultId}"`,
  );
  for (const p of stale) {
    try {
      projects.update(p.name, { name: p.name, workspaceId: defaultId });
    } catch (err) {
      console.warn(`[workspaces] backfill failed for ${p.name}:`, err);
    }
  }
}

async function warmConnectorCaches(): Promise<void> {
  for (const connector of connectorRegistry.list()) {
    if (!connector.init) continue;
    const accounts = integrationsStore
      .list()
      .filter((a) => a.connectorId === connector.id);
    if (accounts.length === 0) continue;
    const hooks = makeConnectorHooks(connector.id);
    try {
      await connector.init(accounts, hooks);
    } catch (err) {
      console.warn(
        `[connectors] ${connector.id}.init() threw:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

function makeConnectorHooks(connectorId: string): ConnectorHooks {
  return {
    async getToken(accountId): Promise<ConnectorTokenPayload | null> {
      const raw = await getConnectorToken(connectorId, accountId);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as ConnectorTokenPayload;
      } catch {
        return null;
      }
    },
    async setToken(accountId, payload): Promise<void> {
      await setConnectorToken(connectorId, accountId, JSON.stringify(payload));
    },
    async clearToken(accountId): Promise<void> {
      await clearConnectorToken(connectorId, accountId);
    },
  };
}

// ─── bootstrap ───────────────────────────────────────────────────────────────

/**
 * Augment process.env.PATH with the user-binary directories macOS apps
 * launched from Finder / Dock / ⌘Tab don't inherit by default. Without
 * this, every workflow shell node (`gh`, `git`, `jq`) and MCP server
 * spawn fails with `spawn <cmd> ENOENT` in the packaged build even
 * though `pnpm dev` works fine (the dev binary inherits the user's
 * interactive shell PATH).
 *
 * We hardcode the common locations rather than spawning a login shell
 * to grab the live PATH — login-shell probing is ~150ms slower at
 * boot and brittle when the user's profile rc files do exotic things.
 * The hardcoded list covers ~99% of Mac dev setups: Homebrew (M-series
 * + Intel), pyenv / pipx / cargo user installs, ~/bin convention.
 *
 * Runs SYNCHRONOUSLY before any module that might spawn subprocesses
 * (workflows, MCP, claude CLI), so its effect propagates everywhere
 * via process.env inheritance.
 */
function augmentPathForGuiLaunch(): void {
  if (process.platform !== 'darwin') return;
  const home = homedir();
  // Order: Homebrew first (most common), then user-scoped tool managers.
  const candidates = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    `${home}/.local/bin`,
    `${home}/.cargo/bin`,
    `${home}/.volta/bin`,
    `${home}/.fnm/aliases/default/bin`,
    `${home}/.bun/bin`,
    `${home}/bin`,
  ];
  const current = (process.env['PATH'] ?? '').split(':').filter(Boolean);
  const seen = new Set(current);
  const toPrepend: string[] = [];
  for (const c of candidates) {
    if (seen.has(c)) continue;
    if (!existsSync(c)) continue;
    toPrepend.push(c);
    seen.add(c);
  }
  if (toPrepend.length === 0) return;
  process.env['PATH'] = [...toPrepend, ...current].join(':');
  console.info(`[boot] augmented PATH: prepended ${toPrepend.join(':')}`);
}
augmentPathForGuiLaunch();

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
  if (process.platform === 'darwin' && app.dock) {
    // In production the .app bundle's Info.plist + .icns supply the dock
    // icon. In dev (`pnpm dev`) the binary is Electron itself, so the
    // generic Electron logo would show up in Cmd+Tab — set our PNG
    // imperatively so dev matches production at a glance. The icns
    // wins automatically once the app is packaged.
    const iconPath = path.join(__dirname, '../../resources/icons/icon.png');
    if (existsSync(iconPath)) {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) app.dock.setIcon(img);
    }
    void app.dock.show();
  }

  initDatabase();
  // Boot-time zombie reap: any task row stuck on status='running' from
  // a previous process can't possibly still be live — the runner just
  // started fresh and has nothing in memory. Mark them errored so the
  // AI Agent UI doesn't show ghost "live" cards forever.
  const zombies = reapZombieRunningTasks();
  if (zombies > 0) {
    console.info(`[boot] reaped ${zombies} zombie running task(s) from previous session`);
  }
  await refreshAuth();
  seedDefaultsIfEmpty();
  skills.init();
  // Integrations store + connector registry come up before mcp so the
  // managed-source overlay is ready by the first resolve() call.
  // Phase 2 = Google; phase 3 = Slack; phase 4 = Notion; phase 5 = Linear.
  connectorRegistry.register(testEchoConnector);
  connectorRegistry.register(googleConnector);
  connectorRegistry.register(slackConnector);
  connectorRegistry.register(notionConnector);
  connectorRegistry.register(linearConnector);
  connectorRegistry.register(githubConnector);
  // Slack reads sendAs from the live account record on every tool
  // call — wire the reader so the user's toggle in Settings takes
  // effect without rebuilding the MCP instance.
  slackConnector.setAccountReader((accountId) =>
    integrationsStore.get(accountId),
  );
  integrationsStore.init();
  mcp.setManagedSource(integrationsStore);
  mcp.init();
  // Warm any connector caches (stdio-MCP connectors like GitHub need
  // the token in memory at spawn time because mcpEntries is sync).
  await warmConnectorCaches();
  // Start the refresher AFTER the integrations store init so the
  // first tick sees the actually-restored accounts.
  tokenRefresher.start();
  // Workspaces come up BEFORE projects so the project store's
  // backfill (any project missing a workspaceId gets the default)
  // has a valid id to point at.
  workspaces.init();
  projects.init();
  // One-shot migration: any project without a workspaceId on disk
  // gets the default workspace stamped onto it. Idempotent — second
  // launch finds them already tagged and no-ops.
  backfillProjectWorkspaces();
  preferences.init();
  dashboard.init();
  briefings.init();
  routines.init();
  // Workflow context must be set before init — running workflows
  // need the shared services (mcp/inbox/notifier/runner). Then the
  // scheduler wires cron jobs from whatever's already on disk.
  workflowRunner.setNodeContext({
    mcp,
    integrations: integrationsStore,
    inbox,
    drafts,
    notifier,
    runner,
    jarvisRoot: join(homedir(), '.jarvis'),
  });
  // Activity feed entries for workflow lifecycle. Fires once per run on
  // transition to a terminal state — we don't want a feed row for every
  // step transition, just the run's outcome. The `run-changed` event
  // emits for every transition; track last-seen status per run id to
  // dedupe to "the first time we saw terminal."
  const workflowTerminalLogged = new Set<string>();
  workflowRunner.on('run-changed', (run: WorkflowRun) => {
    if (
      run.status !== 'completed' &&
      run.status !== 'errored' &&
      run.status !== 'aborted'
    ) {
      return;
    }
    if (workflowTerminalLogged.has(run.id)) return;
    workflowTerminalLogged.add(run.id);
    const w = workflows.list().find((x) => x.id === run.workflowId);
    const name = w?.name ?? run.workflowId;
    const tookMs =
      run.endedAt && run.startedAt ? run.endedAt - run.startedAt : 0;
    activity.record({
      kind: `workflow.${run.status}`,
      label:
        run.status === 'completed'
          ? `Workflow ran · ${name} (${Math.round(tookMs / 100) / 10}s)`
          : run.status === 'errored'
            ? `Workflow errored · ${name} · ${run.error ?? 'unknown'}`
            : `Workflow aborted · ${name}`,
      detail: {
        runId: run.id,
        workflowId: run.workflowId,
        trigger: run.trigger,
        status: run.status,
        durationMs: tookMs,
        ...(run.error ? { error: run.error } : {}),
      },
    });
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
  goals.init();
  skillSuggestions.init();

  // Artifact substrate: backfill existing markdown / SQLite artifacts
  // into the catalog, start watchers for out-of-band edits, warm up
  // the embedding worker so the first semantic query doesn't pay
  // the cold-start tax. Backfill runs in the background; the rest of
  // boot doesn't wait on it.
  startArtifactWatchers();
  setTimeout(() => {
    void backfillArtifacts().catch((err) => {
      console.warn('[artifacts] backfill failed:', err);
    });
    void warmUpEmbeddings();
  }, 3_000);

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
    unregisterContextProvider: (name) => userContext.unregister(name),
    logActivity: (event) => activity.record(event),
    registerArtifact: (input) => {
      void upsertArtifact(input).catch((err) => {
        console.warn(
          `[artifacts] registerArtifact failed for ${input.id}:`,
          err,
        );
      });
    },
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
    listInboxItems: () => inbox.list(),
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
    listGoals: () => goals.list(),
    listActiveGoals: () => goals.listActive(),
    createGoal: (input) => {
      const g = goals.create(input);
      activity.record({
        kind: 'goal.created',
        label: `Goal · ${g.title.slice(0, 80)}${g.title.length > 80 ? '…' : ''}`,
        detail: {
          id: g.id,
          title: g.title,
          deadline: g.deadline,
          project: g.project ?? null,
        },
      });
      return g;
    },
    appendGoalProgress: (id, entry) => goals.appendProgress(id, entry),
    setGoalStatus: (id, status) => {
      const before = goals.get(id);
      const next = goals.setStatus(id, status);
      if (next && before && before.status !== status) {
        activity.record({
          kind: status === 'done' ? 'goal.done' : 'goal.status',
          label:
            status === 'done'
              ? `Goal done · ${next.title.slice(0, 80)}`
              : `Goal ${status} · ${next.title.slice(0, 80)}`,
          detail: { id, title: next.title, status },
        });
      }
      return next;
    },
    removeGoal: (id) => goals.remove(id),
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
  await modules.register(goalsModule);
  await modules.register(shellNavModule);
  await modules.register(shellModule);
  await modules.register(workflowsModule);
  await modules.register(workAwarenessModule);
  await modules.register(dailyLearnModule);
  await modules.register(jarvisSelfGradeModule);
  await modules.register(morningBriefModule);
  await modules.register(askModule);
  await modules.register(browserModule);
  await modules.register(telegramBotModule);
  await modules.register(voiceModule);

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

  // Convert legacy http-fetch auth (auth.mcp + auth.var, expecting
  // env vars on a stdio mcp.json entry) to the new connector form
  // (auth.connector, pulls from Keychain). Old seeded workflows hit
  // "MCP server 'linear' not found or not stdio" against the OAuth-
  // managed registry; this rewrite makes them work without forcing
  // the user to re-seed.
  migrateLegacyHttpFetchAuth(workflows, activity);
  // Rewrite the calendar-today workflow's osascript if it still
  // carries the `«class isot»` token — newer macOS rejects it with
  // -2741 "Expected ',' but found class name." The replacement
  // emits ISO 8601 by hand and is portable.
  migrateLegacyCalendarOsascript(workflows, activity);
  // Rename shell-node `command` → `cmd` on any workflow that
  // carries the wrong key (the shell node accepts `cmd`; some
  // autopilot seed scenarios shipped with `command` and need
  // rewriting in place). Idempotent — second run finds no
  // `command` keys left.
  migrateShellCommandKey(workflows, activity);
  // Drop `reviewDecision` from the gh-search-prs --json field list
  // on the autopilot-pr-comments seed. The field isn't returned by
  // `gh search prs` (only `gh pr list`), so the original seed
  // errored at runtime. Strip + simplify the filter.
  migrateGhSearchPrsFields(workflows, activity);
  // Rewrite the three autopilot seed scenarios from the single-item
  // prompt-output shape to the new batch-prompt-output shape.
  // Detects "still on the old shape" by id + terminal step type.
  // Idempotent — re-runs find batch-prompt-output and skip.
  migrateAutopilotToBatchOutput(workflows, activity);

  // ─── change → broadcast event fan-out ──────────────────────────────────────

  skills.on('changed', (list) => broadcast(IpcChannels.listSkills, list));
  mcp.on('changed', (list) => broadcast(IpcChannels.listMcpServers, list));
  // Re-publish the integrations summary every time accounts change so
  // the renderer's Integrations panel reflects connect/disconnect/flip
  // events without polling. Payload is intentionally empty — the
  // renderer fetches via `listIntegrations` to get the full summary.
  integrationsStore.on('changed', () =>
    broadcast(IpcChannels.integrationsChanged, undefined),
  );
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

  // Goals: every mutation broadcasts to the renderer + nudges the inbox
  // to refresh so the surface stays in sync without a full poll cycle.
  goals.on('changed', (list: Goal[]) => {
    broadcast(IpcChannels.goalsChanged, list);
    void inbox.refresh().catch(() => {});
    // Mirror every goal into the artifact substrate so the agent can
    // search "what goals mention X?". Active + done goals both
    // register; abandoned ones too — historical context matters.
    for (const g of list) {
      void upsertArtifact({
        id: `goal:${g.id}`,
        kind: 'goal',
        title: g.title,
        project: g.project ?? null,
        path: null,
        url: null,
        frontmatter: {
          status: g.status,
          deadline: g.deadline,
          relatedKeywords: g.relatedKeywords,
        },
        content:
          g.body +
          (g.progressLog.length > 0
            ? '\n\n## Progress\n' +
              g.progressLog
                .map(
                  (p) =>
                    `- ${new Date(p.at).toISOString().slice(0, 10)}: ${p.note}`,
                )
                .join('\n')
            : ''),
        createdAt: g.createdAt,
      }).catch(() => {});
    }
  });

  // Reminders: register each as an artifact too. Reminders are tiny
  // but they're often the cross-link target (meeting → spawned
  // → reminder) so having them in the catalog is what makes
  // walk_artifact_graph work end-to-end.
  reminders.on('changed', (list: Reminder[]) => {
    for (const r of list) {
      if (r.status === 'cancelled') continue;
      void upsertArtifact({
        id: `reminder:${r.id}`,
        kind: 'reminder',
        title: r.body.slice(0, 200),
        project: null,
        path: null,
        url: r.sourceUrl ?? null,
        frontmatter: {
          mode: r.mode,
          fireAt: r.fireAt,
          status: r.status,
          cron: r.cron ?? null,
          sourceLabel: r.sourceLabel ?? null,
        },
        content: r.body,
        createdAt: r.createdAt,
        // If this reminder was spawned from a meeting (via meeting-
        // actions), record the back-link so the agent can walk
        // reminder → sourced-from → meeting.
        links: r.sourceUrl
          ? [
              {
                to: artifactIdFromVscodeUrl(r.sourceUrl) ?? 'unknown',
                kind: 'sourced-from',
              },
            ]
          : [],
      }).catch(() => {});
    }
  });

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
  // Autopilot inbox-event bridge — dispatches workflows whose trigger
  // is `{ kind: 'autopilot', when: 'inbox-changed' }` on new inbox
  // items. No-op when appMode !== 'autopilot'.
  inboxEventBridge.start();
  // Ad-hoc meeting detection via macOS Core Audio / CMIO log stream.
  meetingActivity.start();
  // Reap tasks whose terminal SDK event got dropped. Without this,
  // status='running' rows accumulate forever between restarts (the
  // isLive display fix masks them but the records leak). 5-min cadence
  // is fast enough that the user notices a stuck task within a tick,
  // slow enough that a legit long task isn't pre-empted (sweepOrphans
  // uses a 30-min idle threshold).
  setInterval(() => {
    try {
      const n = runner.sweepOrphans();
      if (n > 0) {
        console.log(`[task-runner] swept ${n} orphan task(s)`);
        activity.record({
          kind: 'housekeeping.task-orphans-swept',
          label: `Swept ${n} stuck task${n === 1 ? '' : 's'} (>30m idle, status still 'running')`,
          detail: { count: n },
        });
      }
    } catch (err) {
      console.warn('[task-runner] orphan sweep failed:', err);
    }
  }, 5 * 60 * 1000);
  // Cap persisted workflow run history: at most 200 runs per workflow
  // + nothing older than 30 days. Runs every hour. The Workflows page
  // only ever asks for the latest 200, so anything older is dead
  // weight in SQLite. First pass also fires on boot so a long-running
  // install doesn't carry years of rows.
  const pruneRuns = (): void => {
    try {
      const n = pruneWorkflowRuns({
        perWorkflowCap: 200,
        maxAgeMs: 30 * 24 * 60 * 60 * 1000,
      });
      if (n > 0) {
        console.log(`[workflow-runner] pruned ${n} run row(s)`);
        activity.record({
          kind: 'housekeeping.workflow-runs-pruned',
          label: `Pruned ${n} workflow run row${n === 1 ? '' : 's'} (cap 200/workflow, 30-day age limit)`,
          detail: { count: n },
        });
      }
    } catch (err) {
      console.warn('[workflow-runner] run history prune failed:', err);
    }
  };
  pruneRuns();
  setInterval(pruneRuns, 60 * 60 * 1000);

  // Web Push: load/generate the VAPID keypair before the HTTP
  // server comes up so /v1/push/key has something to return on the
  // first phone reconnect after a fresh boot.
  try {
    await initPush();
  } catch (err) {
    console.warn('[push] init failed:', err);
  }

  // AI Drafts housekeeping: drop sent/discarded drafts older than 30 days
  // so the table doesn't grow unbounded. Pending/sending/failed rows are
  // never auto-pruned — those need user attention.
  const pruneDrafts = (): void => {
    try {
      const n = drafts.prune({ olderThanMs: 30 * 24 * 60 * 60 * 1000 });
      if (n > 0) {
        console.log(`[drafts-store] pruned ${n} draft row(s)`);
      }
    } catch (err) {
      console.warn('[drafts-store] prune failed:', err);
    }
  };
  pruneDrafts();
  setInterval(pruneDrafts, 60 * 60 * 1000);

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
      oauth: oauthOrchestrator,
      notifier,
      getStatus: () => getTrayMenuState(),
      onMeetingDetected: onExternalMeetingDetected,
      onMeetingEnded: onExternalMeetingEnded,
      onBrowserActivity: (payload) => {
        // Second-wall privacy gate — the extension also reads its
        // local activityTracking flag and stops sending when off,
        // but if the user toggled this OFF here and the extension
        // hasn't refreshed yet, we silently drop incoming events
        // until the extension catches up via /v1/browser/settings.
        const cfg = loadModuleSettings('browser');
        if (cfg.activityTracking !== true) return;
        recordBrowserActivity(payload);
      },
      getBrowserSettings: () => {
        const cfg = loadModuleSettings('browser');
        const excludesRaw =
          typeof cfg.activityExcludes === 'string' ? cfg.activityExcludes : '';
        const activityExcludes = excludesRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        return {
          activityTracking: cfg.activityTracking === true,
          activityExcludes,
        };
      },
      getMeetingState: () => currentMeetingState,
      subscribeMeetingState: subscribeMeetingState,
      onMeetingControl: onMeetingControlFromHttp,
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
        oauth: oauthOrchestrator,
        notifier,
        getStatus: () => getTrayMenuState(),
        onMeetingDetected: onExternalMeetingDetected,
      onMeetingEnded: onExternalMeetingEnded,
      onBrowserActivity: (payload) => {
        // Second-wall privacy gate — the extension also reads its
        // local activityTracking flag and stops sending when off,
        // but if the user toggled this OFF here and the extension
        // hasn't refreshed yet, we silently drop incoming events
        // until the extension catches up via /v1/browser/settings.
        const cfg = loadModuleSettings('browser');
        if (cfg.activityTracking !== true) return;
        recordBrowserActivity(payload);
      },
      getBrowserSettings: () => {
        const cfg = loadModuleSettings('browser');
        const excludesRaw =
          typeof cfg.activityExcludes === 'string' ? cfg.activityExcludes : '';
        const activityExcludes = excludesRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        return {
          activityTracking: cfg.activityTracking === true,
          activityExcludes,
        };
      },
      getMeetingState: () => currentMeetingState,
      subscribeMeetingState: subscribeMeetingState,
      onMeetingControl: onMeetingControlFromHttp,
        token: fresh,
        version: app.getVersion(),
      });
    }
    return { token: fresh, url: httpServer?.url ?? null };
  });

  setProgressEmitter((event) =>
    broadcast(IpcChannels.transcribeProgress, event),
  );
  // Whisper warm-up now lives in the voice module's onLoad — see
  // modules/voice/index.ts. The module registry fires onLoad at
  // app boot.

  registerAllIpc({
    skills,
    mcp,
    workspaces,
    projects,
    projectMemory,
    modules,
    runner,
    shellRunner,
    routines,
    reminders,
    goals,
    skillSuggestions,
    userContext,
    preferences,
    inbox,
    drafts,
    activity,
    briefings,
    dashboard,
    workflows,
    workflowRunner,
    workflowScheduler,
    integrations: integrationsStore,
    connectorRegistry,
    oauth: oauthOrchestrator,
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

  // Mirror TTS lifecycle to every renderer so the floating "STOP
  // SPEAKING" pill can show / hide without polling. The
  // `stopSpeaking` IPC handler already lives in ipc/media.ts.
  speechEvents.on('start', () => broadcast(IpcChannels.speechActive, true));
  speechEvents.on('stop', () => broadcast(IpcChannels.speechActive, false));

  // Tray-menu meeting controls. Routes through the same broadcast
  // path the PWA + Chrome extension use so the renderer's
  // MeetingRecorder doesn't need to distinguish sources.
  ipcMain.handle(
    IpcChannels.meetingControlInvoke,
    (_e, action: 'pause' | 'resume' | 'cancel' | 'finish') => {
      if (
        action !== 'pause' &&
        action !== 'resume' &&
        action !== 'cancel' &&
        action !== 'finish'
      ) {
        return { ok: false, error: 'invalid action' };
      }
      const ok = onMeetingControlFromHttp(action);
      return { ok };
    },
  );

  // Open observatory on first launch.
  openObservatory();
});

app.on('window-all-closed', () => {
  // Stay alive in tray.
});

app.on('activate', () => {
  // macOS fires this on dock-icon click, ⌘Tab selection, Spotlight
  // launch, etc. — anything that means "the user is trying to focus
  // Jarvis." If the Observatory was closed (we still run in the tray),
  // there's no visible window and ⌘Tab won't even list us. Reopen so
  // the app behaves like every other native macOS app: front-and-
  // center on activation, available in ⌘Tab as long as it's running.
  if (process.platform === 'darwin' && app.dock) {
    void app.dock.show();
  }
  const obs = getObservatoryWindow();
  if (!obs || obs.isDestroyed()) {
    openObservatory();
  } else {
    if (obs.isMinimized()) obs.restore();
    obs.show();
    obs.focus();
  }
});

app.on('before-quit', () => {
  // Tell the Observatory close-interceptor to actually let the window
  // go on this pass — otherwise the hide-on-close behaviour would
  // veto shutdown.
  setAppQuitting(true);
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
  workspaces.close();
  preferences.close();
  inbox.stopAutoRefresh();
  inboxProximity.stop();
  inboxEventBridge.close();
  approvalBridge.closeAll('app shutdown');
  tokenRefresher.stop();
  meetingActivity.stop();
  stopArtifactWatchers();
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

/**
 * Legacy catalog ids for Gmail / Calendar that wrapped per-account
 * stdio MCP packages with hand-managed OAuth files. Replaced by the
 * unified Google connector under "Connected accounts" — one OAuth
 * grant covers Gmail + Calendar in one shot, tokens live in Keychain.
 * We remove these from ~/.jarvis/mcp.json on first launch so the
 * Installed list isn't carrying ghosts.
 */
const RETIRED_LEGACY_GOOGLE_MCPS = [
  'gmail-personal',
  'gmail-work',
  'calendar-personal',
  'calendar-work',
];

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
  // Same shape, different target: strip legacy Gmail / Calendar MCP
  // entries from ~/.jarvis/mcp.json so the Integrations page isn't
  // stuck showing the four old catalog cards. The unified Google
  // connector under "Connected accounts" replaces them.
  migrateRetiredLegacyGoogleMcps(mcp, activity);

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
/**
 * One-shot rewrite: convert workflows whose http-fetch nodes still
 * carry the legacy { auth: { mcp, var } } shape (expecting a stdio
 * env var) to the new { auth: { connector } } shape (Keychain via
 * OAuth integration). Only touches connectors we own (linear /
 * slack / google / notion); leaves stdio entries (e.g. github when
 * a token's still in mcp.json) untouched.
 *
 * Idempotent — second run sees no auth.mcp left and no-ops. Adds
 * `workflow.migrated` activity rows so the user can see what
 * changed under the hood after upgrading.
 */
const CONNECTOR_AUTH_DEFAULTS: Record<
  string,
  { connector: string; field?: string; scheme?: 'raw' | 'bearer' | 'auto' }
> = {
  linear: { connector: 'linear', scheme: 'auto' },
  slack: { connector: 'slack', field: 'userAccessToken', scheme: 'bearer' },
  google: { connector: 'google', scheme: 'bearer' },
  notion: { connector: 'notion', scheme: 'bearer' },
  gmail: { connector: 'google', scheme: 'bearer' },
  calendar: { connector: 'google', scheme: 'bearer' },
};

function migrateLegacyHttpFetchAuth(
  workflows: WorkflowStore,
  activity: ActivityStore,
): void {
  for (const wf of workflows.list()) {
    let touched = false;
    const nextPipeline = wf.pipeline.map((step) => {
      if (step.type !== 'http-fetch') return step;
      const params = step.params as Record<string, unknown> | undefined;
      const auth = params?.['auth'] as
        | Record<string, unknown>
        | undefined;
      if (!auth || typeof auth['mcp'] !== 'string') return step;
      const replacement = CONNECTOR_AUTH_DEFAULTS[auth['mcp']];
      if (!replacement) return step;
      touched = true;
      return {
        ...step,
        params: { ...params, auth: { ...replacement } },
      };
    });
    if (!touched) continue;
    workflows.save({ ...wf, pipeline: nextPipeline });
    activity.record({
      kind: 'workflow.migrated',
      label: `Workflow auth rewritten · ${wf.id} → OAuth connector`,
      detail: { workflowId: wf.id },
    });
  }
}

/**
 * Detection signature for "this osascript is broken with -2741."
 * Fires on:
 *   - the original `«class isot»` form (pre-fix), AND
 *   - the broken first-fix `pad2(month of d as integer)` form, which
 *     hits the same -2741 because `as` binds loose enough inside a
 *     function-call arg to parse as `month of (d as integer)`.
 * The current good script pre-computes `mo` as a local, so neither
 * substring appears — migration is a no-op on healthy workflows.
 */
function isBrokenCalendarScript(script: string): boolean {
  if (script.includes('«class isot»')) return true;
  if (script.includes('pad2(month of d as integer)')) return true;
  return false;
}

/**
 * Strip `reviewDecision` (and the matching `state` filter that
 * depended on it) from shell-node args of any workflow that
 * shipped with the gh-search-prs invocation referencing it. The
 * field isn't supported by `gh search prs` so the call errored
 * with "Unknown JSON field: reviewDecision". Idempotent.
 */
/**
 * Replace the three autopilot seed scenarios with the current
 * batch-prompt-output shape whenever the on-disk pipeline still
 * ends in single-item `prompt-output`. Sweeping rewrite (the agent
 * prompts, the transforms, and the terminal node all changed at
 * once), so we overwrite the whole pipeline + description from the
 * seed catalog rather than surgical patching. Idempotent — the
 * check fires only when the terminal node is still prompt-output.
 *
 * User customizations to these workflows that already moved past
 * the old shape (terminal != 'prompt-output') are preserved.
 */
function migrateAutopilotToBatchOutput(
  workflows: WorkflowStore,
  activity: ActivityStore,
): void {
  const AUTOPILOT_IDS = new Set([
    'autopilot-slack-dm-ack',
    'autopilot-pr-review-non-team',
    'autopilot-pr-comments-on-mine',
  ]);
  const seedById = new Map(
    BUILTIN_WORKFLOWS.filter((w) => AUTOPILOT_IDS.has(w.id)).map(
      (w) => [w.id, w] as const,
    ),
  );
  for (const wf of workflows.list()) {
    if (!AUTOPILOT_IDS.has(wf.id)) continue;
    const last = wf.pipeline[wf.pipeline.length - 1];
    if (!last || last.type !== 'prompt-output') continue;
    const seed = seedById.get(wf.id);
    if (!seed) continue;
    workflows.save({
      ...wf,
      description: seed.description,
      pipeline: seed.pipeline,
    });
    activity.record({
      kind: 'workflow.migrated',
      label: `Autopilot scenario rewritten · ${wf.id} (batch HUD)`,
      detail: { workflowId: wf.id },
    });
  }
}

function migrateGhSearchPrsFields(
  workflows: WorkflowStore,
  activity: ActivityStore,
): void {
  for (const wf of workflows.list()) {
    let touched = false;
    const nextPipeline = wf.pipeline.map((step) => {
      if (step.type !== 'shell') return step;
      const params = step.params as Record<string, unknown> | undefined;
      const args = params?.['args'];
      if (!Array.isArray(args)) return step;
      const jsonIdx = args.indexOf('--json');
      if (jsonIdx === -1 || jsonIdx + 1 >= args.length) return step;
      const fields = args[jsonIdx + 1];
      if (typeof fields !== 'string') return step;
      if (!/reviewDecision/.test(fields)) return step;
      // Sanitize: split on comma, drop reviewDecision, rejoin.
      const cleaned = fields
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s && s !== 'reviewDecision')
        .join(',');
      const nextArgs = args.slice();
      nextArgs[jsonIdx + 1] = cleaned;
      touched = true;
      return {
        ...step,
        params: { ...(params ?? {}), args: nextArgs },
      };
    });
    if (!touched) continue;
    workflows.save({ ...wf, pipeline: nextPipeline });
    activity.record({
      kind: 'workflow.migrated',
      label: `Workflow shell args fixed · ${wf.id} (gh search prs reviewDecision dropped)`,
      detail: { workflowId: wf.id },
    });
  }
}

/**
 * Rename `params.command` → `params.cmd` on any `shell` node still
 * carrying the wrong key. Shipped on first cut of the autopilot
 * seed scenarios; runtime rejects it with "shell: params.cmd is
 * required." Idempotent on the corrected shape.
 */
function migrateShellCommandKey(
  workflows: WorkflowStore,
  activity: ActivityStore,
): void {
  for (const wf of workflows.list()) {
    let touched = false;
    const nextPipeline = wf.pipeline.map((step) => {
      if (step.type !== 'shell') return step;
      const params = step.params as Record<string, unknown> | undefined;
      if (!params || typeof params['command'] !== 'string') return step;
      if (typeof params['cmd'] === 'string') return step; // already has cmd
      touched = true;
      const { command, ...rest } = params as { command: string } & Record<string, unknown>;
      return { ...step, params: { cmd: command, ...rest } };
    });
    if (!touched) continue;
    workflows.save({ ...wf, pipeline: nextPipeline });
    activity.record({
      kind: 'workflow.migrated',
      label: `Workflow shell node param fixed · ${wf.id} (command → cmd)`,
      detail: { workflowId: wf.id },
    });
  }
}

function migrateLegacyCalendarOsascript(
  workflows: WorkflowStore,
  activity: ActivityStore,
): void {
  for (const wf of workflows.list()) {
    let touched = false;
    const nextPipeline = wf.pipeline.map((step) => {
      if (step.type !== 'osascript') return step;
      const params = step.params as Record<string, unknown> | undefined;
      const script = params?.['script'];
      if (typeof script !== 'string') return step;
      if (!isBrokenCalendarScript(script)) return step;
      touched = true;
      return {
        ...step,
        params: { ...params, script: CALENDAR_ISO_SCRIPT },
      };
    });
    if (!touched) continue;
    workflows.save({ ...wf, pipeline: nextPipeline });
    activity.record({
      kind: 'workflow.migrated',
      label: `Workflow osascript rewritten · ${wf.id} (portable ISO format)`,
      detail: { workflowId: wf.id },
    });
  }
}

/** Verbatim duplicate of CAL_SCRIPT in seeds/workflows/calendar-today.ts.
 *  Inline so the migration's source-of-truth doesn't drift if the seed
 *  evolves — the detector only fires when a known-broken form is on
 *  disk, never on user edits. */
const CALENDAR_ISO_SCRIPT = `
on pad2(n)
  set s to n as text
  if (length of s) < 2 then return "0" & s
  return s
end pad2

on isoStr(d)
  set y to year of d
  set mo to (month of d) as integer
  set da to day of d
  set hh to hours of d
  set mn to minutes of d
  set ss to seconds of d
  return (y as text) & "-" & pad2(mo) & "-" & pad2(da) & "T" & pad2(hh) & ":" & pad2(mn) & ":" & pad2(ss)
end isoStr

set theStart to current date
set theEnd to theStart + 12 * hours
set TAB to (ASCII character 9)
set out to ""
tell application "Calendar"
  repeat with cal in calendars
    repeat with evt in (events of cal whose start date is greater than or equal to theStart and start date is less than theEnd)
      try
        set evtLoc to location of evt
      on error
        set evtLoc to ""
      end try
      try
        set evtDesc to description of evt
      on error
        set evtDesc to ""
      end try
      try
        set evtAllDay to allday event of evt
      on error
        set evtAllDay to false
      end try
      set startIso to my isoStr(start date of evt)
      set endIso to my isoStr(end date of evt)
      set out to out & (uid of evt) & TAB & (summary of evt) & TAB & startIso & TAB & endIso & TAB & (name of cal) & TAB & evtLoc & TAB & evtDesc & TAB & evtAllDay & linefeed
    end repeat
  end repeat
end tell
return out
`;

function migrateRetiredLegacyGoogleMcps(
  mcp: McpConfigStore,
  activity: ActivityStore,
): void {
  for (const id of RETIRED_LEGACY_GOOGLE_MCPS) {
    if (!mcp.list().some((s) => s.id === id)) continue;
    const removed = mcp.remove(id);
    if (!removed) continue;
    activity.record({
      kind: 'mcp.migrated',
      label: `Legacy MCP removed · ${id} replaced by the Google connector`,
      detail: { id, replacedBy: 'google-connector' },
    });
  }
  // We intentionally leave ~/.jarvis/secrets/google-{personal,work}/
  // alone — those OAuth credential files might be useful if the user
  // ever wants to re-run the legacy MCPs manually. They're not
  // referenced anywhere now; harmless on disk.
}

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
