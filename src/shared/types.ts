export type TaskStatus = 'queued' | 'running' | 'completed' | 'aborted' | 'errored';

export type TaskOrigin = 'palette' | 'voice' | 'routine' | 'api' | 'external';

/**
 * How Jarvis grabs your attention when a user-initiated task asks for
 * input. Set per-user in Settings → Notifications.
 *   - 'silent' = do nothing
 *   - 'toast'  = macOS notification + Jarvis in-app toast
 *   - 'open'   = also auto-foreground the Observatory + select the task
 */
export type AskAttention = 'silent' | 'toast' | 'open';

/**
 * How Jarvis signals that a palette/voice command actually started a
 * task. Useful for /review-prs etc. where the HUD overlay is easy to
 * miss. Defaults to 'toast' so you see something landed.
 */
export type LaunchAttention = 'silent' | 'toast';

export interface NotificationPrefs {
  /** What happens when the agent transitions to awaiting input. */
  onAsk: AskAttention;
  /** What happens when a palette/voice command launches a task. */
  onLaunch: LaunchAttention;
}

/**
 * One row in the Settings → Inbox source list. Combines:
 *   - InboxStore-registered built-ins (reminders, pr-review, …)
 *   - User-authored JSON files under ~/.jarvis/inbox/*.json
 * The renderer doesn't care about the distinction at registration
 * time — what it needs is "show this name with this count, and on
 * click do this," so the summary is flat.
 */
export interface InboxSourceSummary {
  /** Internal id — matches InboxItem.source for items from this source. */
  name: string;
  /** Human label shown in the Settings list. */
  label: string;
  /** One-line "what this surfaces". */
  description: string;
  /** Current item count after dedupe/snooze. */
  itemCount: number;
  /** Built-in source vs JSON file under ~/.jarvis/inbox/. */
  kind: 'built-in' | 'file';
  /** Absolute path when kind === 'file'. Used by the Reveal button. */
  filePath?: string;
  /** mtime when kind === 'file'. */
  mtimeMs?: number;
  /** Skill that writes this file (detected by matching basename → skill id). */
  relatedSkillId?: string;
  /**
   * Renderer hint for the "Configure" link:
   *   - 'inbox-scope': jump to Settings → Inbox (PR project scope)
   *   - 'routines':    jump to Routines tab
   *   - 'reminders':   reminders surface in Inbox; jump to Inbox tab
   *   - 'skill':       jump to the related skill (uses relatedSkillId)
   *   - null:          no configure action
   */
  configureHint?: 'inbox-scope' | 'routines' | 'reminders' | 'skill' | null;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  onAsk: 'toast',
  onLaunch: 'toast',
};

/**
 * Per-source visibility for the Inbox. When a source name is in
 * `disabledSources`, items from that source are filtered out of the
 * Inbox tab + the Inbox-in-Dashboard section. They stay readable from
 * other surfaces (Calendar tab reads its own raw data, etc.).
 *
 * Defaults reflect "ambient flow you care about" — calendar starts
 * off because the user already has a dedicated Calendar tab; toggle
 * it on if you want meetings to surface in the triage feed too.
 */
export interface InboxPrefs {
  disabledSources: string[];
  /** How many hours into the future the Inbox shows calendar events.
   *  Items past this window are dropped from the Inbox only (the
   *  Calendar tab + Dashboard Calendar timeline keep showing them). */
  calendarWindowHours: number;
  /** Live strips at the top of the Inbox. Hide them if the noise
   *  outweighs the signal for your workflow. */
  showMeetingStrip?: boolean;
  showAwaitingStrip?: boolean;
}

export const DEFAULT_INBOX_PREFS: InboxPrefs = {
  disabledSources: ['calendar'],
  calendarWindowHours: 24,
  showMeetingStrip: true,
  showAwaitingStrip: true,
};

/**
 * Schema for a module's user-facing settings. Modules declare a
 * `settings.fields` array (typed below); the Settings UI renders a
 * panel automatically. Values are persisted in config.json under
 * `moduleSettings.<moduleId>` and merged with the defaults at read
 * time so a missing key falls back to the schema's default.
 *
 * Used for "module preferences" the user might tweak — auto-dedupe
 * cadence, scan frequency, default channel for sends, etc. NOT for
 * sensitive credentials (those still belong in MCP env + keychain)
 * or for paths (those flow through dedicated config files).
 */
export type ModuleSettingValue = boolean | number | string;

/**
 * `secret` fields don't store their value in moduleSettings — instead the
 * value lives in the macOS Keychain via a module-specific IPC. The settings
 * panel renders a "set token / clear" affordance and consults a `has-token`
 * IPC to know whether one is present. Wiring per module id lives in the
 * SettingsField renderer (renderer-side, keeps the schema declarative).
 */
export type ModuleSettingType =
  | 'boolean'
  | 'number'
  | 'select'
  | 'text'
  | 'secret';

export interface ModuleSettingField {
  /** Persisted key within the module's settings object. */
  key: string;
  /** Human label rendered above the input. */
  label: string;
  /** Optional one-line explanation under the label. */
  hint?: string;
  type: ModuleSettingType;
  /** Value used when the user hasn't touched the field. */
  default: ModuleSettingValue;
  /** For `select` — labelled options the user picks from. */
  options?: Array<{ value: ModuleSettingValue; label: string }>;
  /** For `number` — input min / max / step + an optional unit suffix. */
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

export interface ModuleSettingsSpec {
  /** Fields rendered in the module's settings panel, in this order. */
  fields: ModuleSettingField[];
  /** Optional intro paragraph shown above the fields. */
  description?: string;
}

export type ModuleSettingsValues = Record<string, ModuleSettingValue>;

/**
 * One row in the Activity feed beyond /send (which is task-derived).
 * Persisted in SQLite via `ActivityStore`. Emit sites are scattered:
 * meeting-recorder when a session starts/ends, notes module when a
 * note is created/archived, the MCP config store when a server is
 * disabled, etc. The renderer formats per `kind`.
 *
 *   - `kind`  short dotted id ('meeting.started', 'note.archived',
 *             'mcp.disabled', 'inbox.cleared').
 *   - `label` human one-liner shown in the feed row.
 *   - `detail` optional payload — anything the renderer needs to
 *             format the row (skillId / project name / file path /
 *             link target).
 */
export interface ActivityEvent {
  id: number;
  ts: number;
  kind: string;
  label: string;
  detail?: unknown;
}

/** Shape that emit sites pass to `ActivityStore.record()`. */
export interface ActivityEventInput {
  kind: string;
  label: string;
  detail?: unknown;
  /** Override the auto `Date.now()` — useful when wrapping events
   *  whose real timestamp lives elsewhere (e.g. file mtime). */
  ts?: number;
}

export interface TaskSummary {
  id: string;
  skillId: string | null;
  title: string;
  status: TaskStatus;
  origin: TaskOrigin;
  startedAt: number;
  endedAt: number | null;
  costUsd: number;
  inputPreview: string;
  /**
   * Tasks sharing a groupKey are visually clustered in the constellation
   * (e.g. all Claude Code sessions in the same project).
   */
  groupKey?: string;
  /**
   * The session is paused waiting for user input (for external Claude Code
   * sessions: the JSONL's last event is an assistant message). Lit up in
   * amber on the constellation so it stands out from busy/idle.
   */
  awaitingInput?: boolean;
  /**
   * The Claude Code session id assigned by the spawned `claude` subprocess
   * (subscription mode only — populated after the first SDK `system/init`
   * event). Lets the user `claude --resume <id>` from a terminal, or jump
   * into Claude Code Desktop where the session already lives in Recents.
   * Null in api-key mode since the SDK talks to the API directly with no
   * Claude Code session record on disk.
   */
  sdkSessionId?: string | null;
  /**
   * Working directory the spawned Claude session runs in. Derived from
   * the active project's path (when scoped) or ~ as a fallback. Shown in
   * TaskDetail so the user can see which repo the agent's file operations
   * are actually targeting.
   */
  cwd?: string;
  /**
   * The routine that fired this task, if any. Set on tasks launched
   * by RoutineStore. Lets per-routine views ("recent runs of
   * daily-recap") query directly instead of guessing by skillId +
   * origin='routine'.
   */
  routineId?: string | null;
  /**
   * The reminder that fired this task, if any. Set on scheduled-action
   * reminders that spawn a Claude turn. Lets the Reminders page
   * cross-link "this reminder fired → this task ran."
   */
  reminderId?: string | null;
  /**
   * Active project name at launch time. Captures scope context so a
   * project view can show its agent activity, and so a task months
   * later still knows which project it belonged to even if the user
   * since renamed or removed it.
   */
  projectName?: string | null;
  /** True when this task resumed a pooled SDK session (skipped cold
   *  start). Powers the Spend dashboard's "savings via pooling" stat. */
  pooled?: boolean;
}

export interface TaskEvent {
  seq: number;
  ts: number;
  msg: unknown;
}

/**
 * Per-launch overrides Jarvis surfaces in the palette. Mirror the
 * matching field names on the Agent SDK's Options so we can pass them
 * through without translation. Every field is optional — omitted means
 * "use the runner's default" (e.g. bypassPermissions for mode, active
 * project's path for cwd, skill frontmatter for model).
 */
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan';

export interface SessionConfig {
  /** Permission flow for tool use. 'plan' = read-only / planning;
   * 'acceptEdits' = auto-accept file edits; 'bypassPermissions' = no
   * prompts at all (current Jarvis default); 'default' = ask. */
  permissionMode?: PermissionMode;
  /** Claude model id. e.g. 'claude-sonnet-4-5-20250929'. */
  model?: string;
  /** Auto-fallback model if the primary is overloaded / unavailable. */
  fallbackModel?: string;
  /** Working directory override. Defaults to the active project's path,
   * then ~. */
  cwd?: string;
  /** Extra directories the agent can read/write beyond cwd. */
  additionalDirectories?: string[];
}

export interface LaunchTaskRequest extends SessionConfig {
  skillId?: string | null;
  prompt: string;
  origin?: TaskOrigin;
  /**
   * Session ID to fork-resume — picks up an existing claude session's
   * history and continues it as a new Jarvis-owned task (multi-turn).
   * Used to "take over" an external Claude Code session in Jarvis without
   * disturbing the original terminal session.
   */
  resumeSessionId?: string;
  /** Entity links — set by emit sites that know the upstream context.
   *  All three flow through to TaskSummary + the tasks table so we can
   *  query "all runs of routine X" / "all tasks in project Y" later. */
  routineId?: string | null;
  reminderId?: string | null;
  projectName?: string | null;
  /** Opt out of skill-session pooling for this single dispatch. The
   *  runner forks a fresh SDK session even if an active pooled one
   *  exists. Used for "fresh /<skill>" UI affordances. */
  forceFreshSession?: boolean;
}

// (TaskSummary.pooled is declared inline near the other entity links.)

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  path: string;
  allowedTools: string[];
  mcpServers: string[];
  model: string | null;
  hasBody: boolean;
}

export type SkillSuggestionStatus = 'pending' | 'accepted' | 'dismissed';

export interface SkillSuggestion {
  id: string;
  /** kebab-case directory name. */
  name: string;
  description: string;
  /** Full SKILL.md content — frontmatter + body — ready to write verbatim. */
  body: string;
  /** Up to ~5 prompts from history that inspired this proposal. */
  samplePrompts: string[];
  /** How many similar prompts the analyzer counted. */
  frequency: number;
  createdAt: number;
  status: SkillSuggestionStatus;
}

/**
 * Reminder lifecycle:
 *   - pending   — set, hasn't fired yet
 *   - fired     — fired (notification went out / scheduled task launched),
 *                 awaiting user acknowledgement. Stays in inbox.
 *   - done      — user marked it done from the inbox. Drops out of inbox,
 *                 stays in history (Reminders page) for the audit trail.
 *   - cancelled — user cancelled before it fired.
 */
export type ReminderStatus = 'pending' | 'fired' | 'done' | 'cancelled';

/**
 * `reminder` = user wants to be told. Notification is the point; the spawned
 * task is a reflective Claude turn on the topic.
 * `scheduled` = user wants Jarvis to *do* something at that time. Notification
 * announces the action; the spawned task carries it out (gh, slack, etc.).
 */
export type ReminderMode = 'reminder' | 'scheduled';

export interface Reminder {
  id: string;
  /** Original prompt the user gave (without the "remind me" / time wrapper). */
  body: string;
  mode: ReminderMode;
  createdAt: number;
  fireAt: number;
  status: ReminderStatus;
  /** ms epoch when it actually fired; null while pending. For recurring
   *  reminders this is the LAST fire time — the reminder stays pending
   *  with fireAt updated to the next occurrence. */
  firedAt: number | null;
  /** ms epoch when the user marked it done (from inbox); null otherwise. */
  doneAt?: number | null;
  /** When set, this is a recurring reminder. After each fire the store
   *  reschedules to the next cron occurrence and keeps status='pending'.
   *  Marking done or cancelling stops the series entirely. */
  cron?: string | null;
  /** Task ID we kicked off when firing — lets the constellation link them. */
  firedTaskId: string | null;
}

/**
 * Result of routing a free-text palette prompt. The router tries (in order):
 *  1. Verbal intent match — "record the meeting" → meeting module.
 *  2. Reminder/scheduled parse — "remind me in 2h …".
 *  3. Fall through to a regular Claude task.
 */
export type RoutePromptResult =
  | { kind: 'intent'; moduleId: string; intentId: string; ok: boolean; message?: string }
  | { kind: 'reminder'; reminder: Reminder }
  | { kind: 'task'; task: TaskSummary };

/**
 * User-defined dashboard layout. The Dashboard tab is just a renderer for
 * this config: sections in order, each with a title + ordered items.
 * Persisted to ~/.jarvis/dashboard.json.
 *
 * Item kinds are intentionally a discriminated union so future kinds
 * (pinned tasks, notes, external links) just add a variant.
 */
/** Time-horizon options for the dashboard Calendar widget. The Calendar
 *  tab module ignores this — it has its own Month/Week/Day modes. */
export type CalendarHorizon = 'today' | 'tomorrow' | 'week' | 'month';

export type DashboardItem =
  | { kind: 'inbox' }
  | { kind: 'routine'; routineId: string }
  | {
      /** Unified time-sorted view: calendar events, reminders, scheduled
       * actions, and routine cadence. Read-only aggregator over the
       * inbox + reminders + routines stores. */
      kind: 'calendar';
      /** How far ahead the widget looks. Default 'week'. */
      horizon?: CalendarHorizon;
    };

/** Cap how tall a section can grow. `auto` (default) is unconstrained;
 *  the rest are viewport-height based so they adapt to the window. When
 *  a half-section sets a max height, the value also applies to its
 *  row-mate (both halves on the same row clamp to the larger of the two
 *  settings) so they don't visually mismatch. Full-width sections only
 *  affect their own row. */
export type DashboardSectionMaxHeight = 'auto' | 'compact' | 'medium' | 'tall';

export interface DashboardSection {
  id: string;
  title: string;
  items: DashboardItem[];
  /** Layout width on the dashboard grid. `full` (default) takes a
   * whole row; `half` takes 50% so two halves can sit side-by-side.
   * Sections flow left-to-right, top-to-bottom — two halves followed
   * by a full just put the full on the next row. */
  width?: 'full' | 'half';
  /** Optional vertical cap. When set, the section body becomes
   *  scrollable past the limit. See DashboardSectionMaxHeight. */
  maxHeight?: DashboardSectionMaxHeight;
}

export interface DashboardConfig {
  sections: DashboardSection[];
}

/**
 * Snapshot of the ad-hoc meeting watcher's state. Exposed so the
 * renderer can show "auto-detect is quiet — use manual record"
 * instead of pretending the watcher is working when macOS 15
 * silences the audio log channel.
 */
export interface MeetingDetectionStatus {
  running: boolean;
  eventsSeen: number;
  inputEventsSeen: number;
  lastInputAt: number | null;
  lastCameraAt: number | null;
  lastPromptAt: number | null;
  startedAt: number;
  fault: string | null;
}

export interface RoutineDef {
  id: string;
  skillId: string;
  cron: string;
  input: string;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  /**
   * Optional shell command run on every cron tick. The routine's skill
   * fires only when this command exits 0 AND produces non-empty stdout.
   * Turns a cron routine into a "watch" — e.g. `cron: every 5m` +
   * `condition: gh pr list --search "review-requested:@me is:open" --limit 1`
   * fires the action only when there's something to review.
   *
   * Edit ~/.jarvis/routines.json directly to set this; no UI editor yet.
   */
  condition?: string;
  /** When the most recent condition check fired vs. skipped, for debugging. */
  lastConditionAt?: number;
  lastConditionResult?: 'fired' | 'skipped' | 'errored';
  /** Task id produced by the most recent fire — lets the UI deep-link
   * "view last run" to the actual transcript in the Observatory. Cleared
   * if the task was later deleted (the lookup just becomes a no-op). */
  lastTaskId?: string | null;
  /** History of recent task ids spawned by this routine, newest first.
   * Capped at RECENT_TASK_IDS_MAX in main. Drives the per-routine run
   * history pane in the UI. */
  recentTaskIds?: string[];
  /** Whether this routine's upcoming fires + recent fires show up in
   * the Calendar timeline (Dashboard section + Calendar module). Default
   * is true (visible); set false to hide routines that fire too often
   * to be useful in a calendar view (e.g. every-10-minute pollers). */
  showInCalendar?: boolean;
}

/**
 * An MCP server that Claude itself (Claude Code / Claude.ai connectors)
 * knows about. Parsed from `claude mcp list`. Distinct from
 * `McpServerSummary` which only reflects Jarvis-managed local stdio MCPs
 * in ~/.jarvis/mcp.json.
 */
export interface McpToolSummary {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpProbeResult {
  ok: boolean;
  tools?: McpToolSummary[];
  durationMs?: number;
  message?: string;
}

export interface McpInvokeResult {
  ok: boolean;
  /** Raw MCP `tools/call` result content (array of content blocks). */
  content?: unknown;
  /** Server flagged the result as an error (isError: true). */
  isError?: boolean;
  durationMs?: number;
  message?: string;
}

export interface ClaudeMcpEntry {
  /** Short name after stripping the "claude.ai " or "plugin:foo:" prefix. */
  name: string;
  /** Original full name including prefix. */
  fullName: string;
  /** URL for remote connectors, command string for stdio MCPs. */
  target: string;
  status: 'connected' | 'needs-auth' | 'failed' | 'unknown';
  source: 'claude.ai' | 'user' | 'plugin';
}

export type McpServerKind = 'stdio' | 'sse' | 'http';

export interface McpServerInput {
  /** Server id — lowercase, kebab-case. */
  id: string;
  type: McpServerKind;
  /** stdio: the command to run; remote: ignored. */
  command?: string;
  /** stdio args (already split). */
  args?: string[];
  /** stdio env vars. */
  env?: Record<string, string>;
  /** sse / http remote URL. */
  url?: string;
  /** sse / http headers. */
  headers?: Record<string, string>;
}

export interface McpServerSummary {
  id: string;
  type: 'stdio' | 'sse' | 'http';
  command?: string;
  url?: string;
  /** When true, resolve() skips this entry — the SDK never sees it,
   * the subprocess never spawns. Click to re-enable. */
  disabled?: boolean;
  /** ms epoch when the disable auto-expires; null/undefined = disabled
   * indefinitely (only manual re-enable). */
  disabledUntil?: number | null;
}

export interface ProjectMemoryFile {
  name: string;
  /** Absolute path on disk — exposed so the renderer can show it. */
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface ProjectDef {
  /** Canonical name — what the user typically says/types. */
  name: string;
  /** Fuzzy match strings the user might say ("cs ai", "csai", …). */
  aliases: string[];
  /** Absolute path on disk; resolved against home if it starts with ~. */
  path?: string;
  /** GitHub repo identifier ("owner/name") or full URL. */
  repo?: string;
  /** One-line description that helps the agent decide relevance. */
  description?: string;
  /**
   * Should the inbox PR sources scan this repo? Defaults to true when
   * `repo` is set. Set to `false` to exclude a project from PR scanning
   * without removing it as a project (you might still want it in the
   * scope picker / memory). Toggled from Settings → Inbox.
   */
  inboxScan?: boolean;
}

/** Payload for creating a new project from the UI. */
export interface ProjectInput {
  name: string;
  aliases?: string[];
  path?: string;
  repo?: string;
  description?: string;
  /** Default for inboxScan when this project is created. Defaults to
   * undefined (= included by default if repo is set). */
  inboxScan?: boolean;
  /** Optional workflow template id (see ProjectTemplateSummary). When set,
   * ProjectStore seeds the project's memory dir from the template. */
  templateId?: string;
}

/**
 * Status of the localhost HTTP API. Renderer reads this to show the URL
 * + token in Settings → API so the user can paste them into Shortcuts,
 * curl invocations, or future external clients.
 */
export interface HttpApiStatus {
  /** True when the server is bound and accepting requests. */
  running: boolean;
  /** Full URL (e.g. "http://127.0.0.1:4747") or null if not started. */
  url: string | null;
  /** Bearer token. Always present even when not running — generated
   * once on first launch, persisted in Keychain. */
  token: string;
}

/**
 * Cost rollup for the Dashboard. Sums Jarvis-launched tasks only — external
 * Claude Code mirror sessions don't count (Jarvis didn't pay for them).
 */
export interface CostSummary {
  /** Spend since local midnight today, USD. */
  today: number;
  /** Spend over the last 7 calendar days, USD. */
  last7days: number;
  /** Spend since the 1st of the current month, USD. */
  thisMonth: number;
  /** Top 3 skills by total cost over the last 30 days. */
  topSkills: {
    skillId: string | null;
    totalUsd: number;
    taskCount: number;
  }[];
}

/**
 * Detailed cost breakdown for the Spend dashboard. Each bucket is sorted
 * by totalUsd desc except `byDay` which is chronological ascending so
 * the renderer can chart a time series. Zero-spend days are filled in
 * so the chart doesn't have gaps.
 */
export interface CostBreakdown {
  windowDays: number;
  total: number;
  bySkill: Array<{ skillId: string | null; totalUsd: number; taskCount: number }>;
  byOrigin: Array<{ origin: string; totalUsd: number; taskCount: number }>;
  byRoutine: Array<{ routineId: string; totalUsd: number; taskCount: number }>;
  byDay: Array<{ date: string; totalUsd: number; taskCount: number }>;
  /** Skill-session pooling stats — within the window, how many
   *  palette/voice tasks reused a session vs. paid the cold start.
   *  Lets the Spend dashboard surface an estimated savings. */
  pool: {
    pooledTaskCount: number;
    freshTaskCount: number;
  };
}

/**
 * One row in the Inbox. Built by InboxSource implementations in main and
 * shipped to the renderer for the daily-driver triage list. Optional
 * `action` lets the user dispatch a skill / prompt with one click.
 */
export interface InboxItem {
  /** Stable id across refreshes — used for React keys and dedupe. */
  id: string;
  /** Source name (e.g. "pr-review", "reminders"). Groups rows in the UI. */
  source: string;
  /** One-line primary text. */
  title: string;
  /** Optional secondary line (repo · author · age · etc.). */
  subtitle?: string;
  /** Project alias if this item is scoped to one — used for filtering. */
  project?: string;
  /** External link (gh URL, Linear ticket, etc.) — opens in browser. */
  url?: string;
  /**
   * For time-pressured items (reminders): when this fires. Items with
   * fireAt sort first, soonest at the top.
   */
  fireAt?: number;
  /** When the item first appeared. Newest-first when no fireAt is set. */
  createdAt: number;
  /**
   * One-click action button shown to the right of the row. Two flavors:
   *
   *   - **task** (default) — clicking launches a Claude agent via
   *     `runner.launch({ skillId, prompt })`. Use this for genuine
   *     agentic work: "Draft a reply," "Review this PR," "Address
   *     comments." The button label should describe the work, not
   *     the destination.
   *
   *   - **open-url** — clicking opens `action.url` (or, if absent,
   *     the item's own `url`) directly in the browser. Use this when
   *     you want a custom-labeled link button beyond the generic
   *     "Open" the renderer adds from `item.url` alone — e.g. "View
   *     on Linear" with custom wording but no agent spawn.
   *
   * If you only want a plain "Open" link, just set `item.url` and
   * leave `action` undefined — the renderer adds the Open button
   * automatically. Spawning a task for what's really just navigation
   * (e.g. "Open the Linear issue and propose the next move") wastes
   * a turn and a few seconds of the user's life.
   */
  action?: {
    label: string;
    /** Defaults to 'task'. */
    kind?: 'task' | 'open-url';
    /** task only — skill id to launch (free-text routing if absent). */
    skillId?: string;
    /** task only — prompt text to send. Required when kind is 'task' or
     *  omitted. */
    prompt?: string;
    /** open-url only — URL to open. Falls back to item.url if absent. */
    url?: string;
  };
}

/** Renderer-facing summary of a workflow template — body lives in main. */
export interface ProjectTemplateSummary {
  id: string;
  label: string;
  description: string;
  /** Skill names the template suggests as good fits. Just hints. */
  recommendedSkills?: string[];
  /** MCP server names the template suggests. Just hints. */
  recommendedMcps?: string[];
  /** Count of memory files this template seeds, for the dialog hint. */
  memorySeedCount: number;
}

export interface PaletteIntentSummary {
  id: string;
  moduleId: string;
  prefix: string;
  label: string;
  description?: string;
  placeholder?: string;
}

export interface ModuleSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  intents: PaletteIntentSummary[];
  /** A renderer-side page is available for this module (Notes for quick-note, etc.). */
  hasPage: boolean;
  /** Schema for this module's user-tweakable preferences, if any.
   *  Renderer uses it to draw a settings panel in the Modules tab. */
  settings?: ModuleSettingsSpec;
  /** Current persisted values for the above, merged with defaults
   *  for any keys the user hasn't set explicitly. */
  settingsValues?: ModuleSettingsValues;
}

export interface DispatchIntentResult {
  ok: boolean;
  message?: string;
}

export interface JarvisFileEntry {
  name: string;
  isDir: boolean;
  mtimeMs: number;
  sizeBytes: number;
}

export interface TranscribeProgress {
  status: 'downloading' | 'loading' | 'ready' | 'transcribing' | 'done';
  file?: string;
  progress?: number; // 0-100
  loaded?: number;
  total?: number;
}

export type AuthMode = 'subscription' | 'api-key';

export interface AppStatus {
  authMode: AuthMode | null;
  hasApiKey: boolean;
  hasSubscriptionToken: boolean;
  claudeBinaryPath: string | null;
  version: string;
}
