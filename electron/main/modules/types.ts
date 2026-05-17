import type {
  ActivityEventInput,
  CostBreakdown,
  LaunchTaskRequest,
  ModuleSettingsSpec,
  ProjectDef,
  Reminder,
  ReminderMode,
  RoutePromptResult,
  SessionConfig,
  SkillSummary,
  TaskOrigin,
  TaskStatus,
  TaskSummary,
} from '@shared/types';

import type { TurnResult } from '../await-turn.js';
import type { ClassifyResult } from '../intent-classifier.js';
import type { UserContextProvider } from '../user-context.js';

export type ParsedFreeTextIntent =
  | { kind: 'task'; body: string }
  | {
      kind: 'reminder';
      mode: ReminderMode;
      body: string;
      fireAt: number;
      /** Set when the input was recurring ("every Monday at 9am …").
       *  Handlers should pass this to ctx.createReminder so the store
       *  reschedules on each fire. */
      cron?: string;
    };

/**
 * What a module receives at load time. Stays stable across the module's
 * lifetime. New capabilities should land here so modules don't have to import
 * from random main-process files.
 */
export interface ModuleContext {
  /** ~/.jarvis on disk — modules should put their data under a subdir. */
  readonly jarvisRoot: string;
  /** Native macOS notification. Click jumps to the observatory. */
  notify(title: string, body: string): void;
  /** Fire a Task into the runner. Useful when a module wants to chain into Claude. */
  launchTask(req: LaunchTaskRequest): TaskSummary;
  /** Pop the answer HUD with a freshly-launched task so the user can watch it. */
  showHud(taskId: string): void;
  /**
   * Run a raw shell command, streaming output to the HUD as a task — no
   * Claude in the loop. Same shell environment Jarvis tasks have.
   */
  runShell(cmd: string): TaskSummary;
  /** Recent task summaries (newest first). Used by skill-suggester to feed Claude. */
  listRecentTasks(limit?: number): TaskSummary[];
  /** Run the palette intent parser on free text. Returns a 'reminder' kind when the text has a time phrase. */
  parseFreeTextIntent(input: string): ParsedFreeTextIntent;
  /** Schedule a reminder / scheduled action. Same store the palette uses. */
  createReminder(input: {
    body: string;
    mode: ReminderMode;
    fireAt: number;
    /** Optional cron — when set, the reminder is recurring (rescheduled
     *  on each fire). Omit for one-shot. */
    cron?: string;
  }): Reminder;
  /** Fuzzy-match a free-text query against ~/.jarvis/projects.json (name/aliases/description). */
  resolveProject(query: string): ProjectDef | null;
  /**
   * Per-project memory at ~/.jarvis/projects/<name>/memory/. Agents read
   * this at start of a task (so they don't relearn the codebase every
   * time) and append findings at the end.
   */
  memoryRead(project: string, file?: string): string;
  memoryAppend(project: string, file: string, content: string): void;
  /** Publish an observable entry the module is watching (not running). */
  registerExternalTask(summary: TaskSummary): void;
  /** Push a streamed event for a previously-registered external entry. */
  recordExternalEvent(taskId: string, msg: unknown): void;
  /** Update the running/idle/completed state of an external entry. */
  updateExternalTaskStatus(
    taskId: string,
    status: TaskStatus,
    endedAt: number | null,
  ): void;
  /** Patch arbitrary fields on an external entry (e.g. awaitingInput). */
  updateExternalTaskMeta(taskId: string, patch: Partial<TaskSummary>): void;
  /** True if Jarvis already has an external entry with that id. */
  hasExternalTask(id: string): boolean;
  /** True if any Jarvis-owned task is bound to this claude session id. */
  isOwnedSessionId(sessionId: string): boolean;
  /** Drop an external entry (used to dedupe mirrors of owned sessions). */
  removeExternalTask(taskId: string): void;
  /**
   * Broadcast a custom event channel to every renderer window. Use sparingly
   * — most modules should communicate via stores / IPC channels owned by
   * the runtime. Useful for modules that need to coordinate with renderer-
   * side state (the meeting recorder kicks off audio capture this way).
   */
  broadcast(channel: string, payload?: unknown): void;
  /**
   * Add a provider to the ambient user-context block that's prepended to
   * every task's system prompt. Examples: calendar event in progress,
   * currently-open app, weather. Provider's `build()` is called on every
   * task launch, so keep it cheap (cache where possible). Re-registering
   * by the same `name` replaces the previous instance.
   */
  registerContextProvider(provider: UserContextProvider): void;
  /**
   * Record a non-agent side-effect for the Activity tab — meeting
   * started, note archived, MCP disabled, etc. Cheap; fire-and-forget.
   * Renderer merges these with task-derived /send rows.
   */
  logActivity(event: ActivityEventInput): void;
  /**
   * Dispatch raw free-text through the same logic as the palette: verbal-
   * intent match → module dispatch → reminder/scheduled parse → task
   * launch. Used by remote-control modules (the Telegram bot) so messages
   * from phone go through exactly the same routing the palette does.
   */
  routePrompt(
    input: string,
    opts?: {
      origin?: TaskOrigin;
      sessionConfig?: SessionConfig;
      projectName?: string | null;
    },
  ): Promise<RoutePromptResult>;
  /**
   * Wait for the current SDK turn of a running task to produce a result
   * event, then resolve with its final assistant text + awaitingInput
   * flag. See await-turn.ts for the precise semantics — this is NOT the
   * same as waiting for status='completed'; multi-turn tasks stay in
   * 'running + awaitingInput=true' between turns.
   */
  awaitTurnResult(taskId: string, opts?: { timeoutMs?: number }): Promise<TurnResult>;
  /**
   * Continue a multi-turn task with a follow-up user message. Wraps
   * runner.sendMessage; throws if the task is unknown / external / not
   * accepting input (e.g. user replied after the task self-closed).
   */
  sendMessageToTask(taskId: string, text: string): Promise<void>;
  /** Abort a running task. Throws if not running. */
  abortTask(taskId: string): Promise<void>;
  /** True when the user has flipped AFK mode on. Cross-cutting state. */
  isAfk(): boolean;
  /** Flip AFK mode. Broadcasts the new value so tray + Shell update. */
  setAfk(value: boolean): void;
  /** True when Jarvis is globally paused — routines + scheduled-action
   *  reminders skip firing. Modules that auto-spawn work should consult
   *  this before doing so. */
  isPaused(): boolean;
  /** Flip the global pause flag. Broadcasts; tray + UI react. */
  setPaused(value: boolean): void;
  /** Snapshot of all reminders, newest pending first (same ordering as
   *  the Reminders page). Used by the Telegram bot for /reminders list
   *  and for snooze button context. */
  listReminders(): Reminder[];
  markReminderDone(id: string): boolean;
  /** Re-arm a reminder to fire `msFromNow` from now. Wraps reminders.snooze. */
  snoozeReminder(id: string, msFromNow: number): Reminder | null;
  /** Skills available to launch. Used by the Telegram bot for /skills. */
  listSkills(): SkillSummary[];
  /** Snapshot of Jarvis spend over the last `windowDays` (1-90). Used
   *  by modules that surface budget info externally — Telegram bot
   *  /spend command, future module-level digests. */
  getCostBreakdown(windowDays: number): CostBreakdown;
  /** Decide whether `message` (the last assistant text in a chat) is
   *  asking the user for a reply. Resolves to null if the classifier
   *  is unavailable (offline, auth error, timeout); callers should
   *  fall back to their existing heuristic in that case. */
  classifyIntent(message: string): Promise<ClassifyResult | null>;
}

/**
 * A palette intent. The palette routes `<prefix> <input>` to `handler(input)`.
 * Prefix must start with `/` and be a single token (no spaces).
 *
 * Handlers may return a short string that's surfaced to the user as a "what
 * just happened" message (palette success badge, notification body).
 */
export interface PaletteIntent {
  id: string;
  prefix: string;
  label: string;
  description?: string;
  placeholder?: string;
  /**
   * Multi-word phrases that, when typed as free text in the palette,
   * route to this intent automatically (without the slash prefix).
   * The MATCH IS LEADING — the prompt must START with the trigger to
   * route, so a trigger like 'record the meeting' won't fire on 'I
   * should record the meeting later'. Long-form natural language
   * stays a regular Claude task.
   */
  verbalTriggers?: string[];
  /**
   * Regex patterns for phrasings that don't fit a leading-prefix
   * match — e.g. "create a hivecore project" where the project name
   * lives in the middle. The FIRST CAPTURE GROUP becomes the input
   * passed to the handler. Patterns should be anchored (^) to avoid
   * loose substring matches deep in a sentence.
   *
   * Tried AFTER verbalTriggers so explicit prefixes still win.
   * Case-insensitive match is up to the pattern (use the /i flag).
   */
  verbalPatterns?: RegExp[];
  handler: (
    input: string,
    ctx: ModuleContext,
  ) => void | string | Promise<void | string>;
}

/**
 * The thing every module exports. Keep it small and code-only; manifests
 * masquerading as data are a footgun once you have many modules.
 */
export interface Module {
  id: string;
  name: string;
  description: string;
  version: string;
  intents?: PaletteIntent[];
  /** Schema for user-tweakable preferences this module exposes.
   *  Renderer auto-draws a panel in Settings → Modules under the
   *  module's row. Values are persisted in config.json. */
  settings?: ModuleSettingsSpec;
  onLoad?(ctx: ModuleContext): void | Promise<void>;
  onUnload?(): void | Promise<void>;
}
