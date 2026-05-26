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
   *   - 'inbox-scope':  jump to Settings → Inbox (PR project scope)
   *   - 'routines':     jump to Routines tab
   *   - 'reminders':    reminders surface in Inbox; jump to Inbox tab
   *   - 'skill':        jump to the related skill (uses relatedSkillId)
   *   - 'integrations': jump to Settings → Integrations (MCP tokens)
   *   - null:           no configure action
   */
  configureHint?:
    | 'inbox-scope'
    | 'routines'
    | 'reminders'
    | 'skill'
    | 'integrations'
    | null;
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
 * User's working-hours window. Drives the `{businessHours}` token
 * substitution in workflow cron expressions — a single setting
 * controls every inbox feed's schedule.
 *
 * Hours are inclusive 24h ("9-18" = the 9am hour through 18:59).
 * `daysOfWeek` is POSIX cron day-of-week (0 or 7 = Sunday;
 * "1-5" = Mon-Fri).
 */
export interface WorkingHoursPrefs {
  startHour: number;
  endHour: number;
  daysOfWeek: string;
}

export const DEFAULT_WORKING_HOURS_PREFS: WorkingHoursPrefs = {
  startHour: 9,
  endHour: 18,
  daysOfWeek: '1-5',
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
  /**
   * Marks "passive" activity that Jarvis observes but the user almost
   * never wants to see in the main view — e.g. Claude Code's background
   * AI-title backfill writing single lines to old session files. Still
   * ingested + clickable, but the task list's default filters exclude
   * these and surface them only under a dedicated "background" tab.
   */
  background?: boolean;
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
  /** Speak the agent's final response aloud via macOS `say` when the
   *  result event lands. Used by the voice orb to close the loop —
   *  press hotkey, speak, hear the response. Markdown is stripped
   *  before TTS so headings + bullets don't read as syntax. */
  speakReply?: boolean;
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
  /** Unattended dispatch — close cleanly after the agent's result
   *  instead of holding the SDK session open for follow-ups, and
   *  flag the task as `errored` if the final text looks like a
   *  question to the user. Set by routine fires + scheduled-action
   *  reminders (no human is watching). Defaults to false. */
  unattended?: boolean;
}

// (TaskSummary.pooled is declared inline near the other entity links.)

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  path: string;
  allowedTools: string[];
  mcpServers: string[];
  /** Explicit model id from frontmatter — wins over `tier` when set. */
  model: string | null;
  /** Abstract tier (fast / balanced / smart) — resolved to a concrete
   *  model via electron/main/model-tiers.ts at task launch, with the
   *  user's speedBias applied. Null when the frontmatter neither sets
   *  it nor a model, in which case the default tier is used. */
  tier: 'fast' | 'balanced' | 'smart' | null;
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
 * Multi-day commitments: "ship X by Friday" — the shape that doesn't
 * fit reminders (too long) or routines (not recurring). Surfaced into
 * the Inbox alongside everything else; the goal-progress skill auto-
 * appends activity entries.
 */
export type GoalStatus = 'active' | 'done' | 'abandoned';

export interface GoalProgressEntry {
  /** ms epoch when this entry was added. */
  at: number;
  /** Free-text note describing what happened. */
  note: string;
  /** Where the signal came from — 'user', 'goal-progress', 'pr-merge', etc. */
  source: string;
  /** Optional URL / file path linking to the underlying signal. */
  url?: string;
}

export interface Goal {
  id: string;
  title: string;
  body: string;
  /** ms epoch deadline. null = open-ended. */
  deadline: number | null;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  relatedKeywords: string[];
  progressLog: GoalProgressEntry[];
  /** Optional project alias scope. */
  project?: string | null;
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
  | {
      /** Compact list of pending AI drafts. Title + the primary
       *  LLM-chosen action per row, clickable to act in-place;
       *  "Open Drafts" link at the bottom goes to the full view. */
      kind: 'drafts';
      /** Cap how many rows the widget shows. Default 6. */
      limit?: number;
    }
  | {
      /** Pinned card showing items from a single inbox source —
       *  Tech watch, Linear, Slack, etc. Renders the Inbox component
       *  in stripped-down "single-source" mode: no header strips, no
       *  calibration nudges, no settings, no dismissed accordion.
       *  Use this when you want a glanceable per-source card on the
       *  dashboard instead of the firehose Inbox widget. */
      kind: 'inbox-source';
      /** Which `InboxItem.source` to show. See `PINNABLE_INBOX_SOURCES`
       *  in `src/renderer/views/Inbox.tsx`. */
      source: string;
      /** Cap how many rows the card shows. Default 6. */
      limit?: number;
    }
  | { kind: 'routine'; routineId: string }
  | {
      /** Unified time-sorted view: calendar events, reminders, scheduled
       * actions, and routine cadence. Read-only aggregator over the
       * inbox + reminders + routines stores. */
      kind: 'calendar';
      /** How far ahead the widget looks. Default 'week'. */
      horizon?: CalendarHorizon;
    }
  | {
      /** Today's / week's / month's spend at a glance. Click jumps to
       *  Settings → Spend for the detail. Mirrors the at-a-glance
       *  tray tooltip but in a pinnable card so a glance at the
       *  Dashboard shows the budget posture. */
      kind: 'spend';
      windowDays?: 1 | 7 | 30;
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
  /** Whether this routine runs unattended (no one is watching). When
   * true (the default), the runner closes the task cleanly after the
   * agent's result instead of holding the session open for a reply.
   * If the agent's final text ends in a question, the task is marked
   * `errored` so the routine surfaces in the Inbox "Needs attention"
   * source — that's a buggy skill prompt for an unattended context.
   * Set false for the rare routine you want to allow to ask. */
  unattended?: boolean;
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
  /** True when an OAuth-managed integration publishes an MCP entry
   *  under the same name, so the manual mcp.json copy is invisible to
   *  TaskRunner. UI surfaces a migration banner + per-row badge so the
   *  user can clean up without hand-editing the JSON. */
  shadowedByManaged?: boolean;
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
export interface CostPrefs {
  /** Warn once when a single task crosses this USD threshold. 0 disables. */
  perTaskUsd: number;
  /** Warn when today's total spend crosses this USD threshold. 0 disables. */
  dailyUsd: number;
  /** When true, crossing the daily threshold also flips the global pause
   *  flag — routines + scheduled actions stop until the user resumes. */
  autoPauseOnDaily: boolean;
}

export interface CostBreakdown {
  windowDays: number;
  total: number;
  bySkill: Array<{ skillId: string | null; totalUsd: number; taskCount: number }>;
  byOrigin: Array<{ origin: string; totalUsd: number; taskCount: number }>;
  byRoutine: Array<{ routineId: string; totalUsd: number; taskCount: number }>;
  byProject: Array<{ projectName: string; totalUsd: number; taskCount: number }>;
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
  /**
   * Long-form content that belongs to the item itself (vs the brief
   * subtitle). Used by autopilot `draft-output` so the user can read
   * the full drafted reply / review without leaving the Inbox.
   * Markdown is fine; the renderer treats it as plain text for now.
   */
  body?: string;
  /**
   * True when the source flagged this item as bot-originated (e.g.
   * Slack bot messages, GitHub-bot Slack pings). Autopilot scenarios
   * filter on this so a notification bot doesn't get treated like a
   * human conversation. Not surfaced in the UI today; the inbox row
   * looks the same regardless.
   */
  isBotSender?: boolean;
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
   * Short "why this matters right now" annotation, surfaced inline
   * under the title. Used by the inbox-curate skill to explain its
   * ranking — e.g. "Joe is blocking the launch", "PR your colleague
   * is waiting on". One sentence; the UI renders it dimmed beneath
   * the subtitle. Plain text; no markdown.
   */
  why?: string;
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

/**
 * Renderer mirror of the main-side `ModuleMemoryRef`. Same fields,
 * lives here because it crosses IPC. See
 * electron/main/modules/types.ts for the authoritative definition.
 */
export interface ModuleMemorySummary {
  label: string;
  location: string;
  kind: 'file' | 'directory' | 'keychain' | 'sqlite' | 'config' | 'memory';
  access: 'read' | 'write' | 'read-write';
  notes?: string;
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
  /** Declared storage footprint — rendered as "Where this lives"
   *  in Settings → Modules → [module]. */
  memory?: ModuleMemorySummary[];
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

/**
 * One row in a `batch-prompt-output` HUD. The autopilot scenarios
 * that produce multiple drafts in a single tick (Slack DMs across
 * several senders, PR review across a queue, PR comments across one
 * PR) emit an array of these; the HUD renders them as a table and
 * the user accepts / rejects per row.
 */
export interface BatchItem {
  /** Stable id keyed by domain (e.g. `slack-CXXX-1727654321.001`,
   *  `pr-acme-foo-#123`, `comment-12345`). Used as the React key in
   *  the HUD and the row-id in the per-row decision IPC. */
  id: string;
  /** Header cells the renderer shows as the row's identity (From,
   *  Channel, File:line, PR title, etc.). Pure labels + values; the
   *  HUD doesn't reflow these. */
  preview: Array<{ label: string; value: string }>;
  /** Editable draft body for this row. Slack scenario: the reply
   *  text. PR scenarios: the review summary or the reply text. */
  draft: string;
  /** Optional intent / verdict line shown next to the draft.
   *  'approve' / 'comment' / 'request-changes' for PR review;
   *  'should-do' / 'ignore' for PR-comments; omitted for Slack. */
  verdict?: string;
  /** Optional read-only context shown when the row is expanded
   *  (diff snippet, thread excerpt, the original comment, …).
   *  Renders as monospaced plain text. */
  context?: string;
}

/**
 * Per-row outcome the renderer reports back from `BatchApprovalHud`.
 * The workflow's `batch-prompt-output` node fans each one into the
 * feedback file (one entry per decision) and returns the accepted +
 * rejected subsets as the pipeline's next-step input.
 */
export interface BatchDecision {
  rowId: string;
  decision: 'accept' | 'reject' | 'skip';
  /** If the user edited the draft before accepting, the edited text. */
  editedDraft?: string;
  /** Free-form note attached to a reject. */
  feedback?: string;
}

/**
 * Top-level operating state. Replaces the older `paused: boolean` —
 * three exclusive modes:
 *
 *   - paused    silences automatic notifications, skips routine /
 *               workflow cron ticks. Existing paused semantics.
 *   - running   default. Everything fires normally; confirms still
 *               apply (meeting prompt, reminder fire-now, etc.).
 *   - autopilot less-friction (auto-confirm prompts) AND lets Jarvis
 *               act on incoming asks via opt-in scenario workflows
 *               (trigger.kind === 'autopilot').
 *
 * Tray + header expose a 3-radio control; only one mode is active at
 * a time. State lives in `~/.jarvis/config.json` as `appMode`.
 */
export type AppMode = 'paused' | 'running' | 'autopilot';

/**
 * Snapshot of everything the custom tray menu renders. Pushed
 * from main on open + on state change so the popover stays live
 * without each open re-fetching from a dozen sources.
 */
export interface TrayMenuState {
  appMode: AppMode;
  afk: boolean;
  runningTasks: number;
  awaitingReplies: number;
  pendingReminders: number;
  reducedConversations: number;
  todaySpendUsd: number;
  pinned: Array<{
    taskId: string;
    title: string;
    status: TaskStatus;
    reduced: boolean;
  }>;
}

export interface AppStatus {
  authMode: AuthMode | null;
  hasApiKey: boolean;
  hasSubscriptionToken: boolean;
  claudeBinaryPath: string | null;
  version: string;
}

/**
 * Wire shape for notifier broadcasts crossing IPC. Mirrors the main-
 * side NotificationEvent minus the onClick callback (functions can't
 * cross the bridge). The FlowStream page consumes this to render
 * terminal-stage notification orbs.
 */
export type NotificationSourceWire =
  | 'notify-tool'
  | 'reminder'
  | 'reminder-created'
  | 'scheduled-action'
  | 'task-launched'
  | 'task-awaiting'
  | 'task-complete'
  | 'task-errored'
  | 'meeting-heads-up'
  | 'cost-guardrail'
  | 'inbox-new'
  | 'skill-suggestion'
  | 'other';

export interface NotifierEmitPayload {
  source: NotificationSourceWire;
  title: string;
  body: string;
  taskId?: string;
  reminderId?: string;
  /** Wall-clock ms — when the notifier fired this. Stamped at the
   *  broadcast site so the renderer's FlowStream can place the orb
   *  on the right timeline. */
  ts: number;
}

// ─── Workflows ────────────────────────────────────────────────────────

/**
 * User-facing workflow definition. Saved as JSON at
 * `~/.jarvis/workflows/<id>.json`. The engine compiles each one to an
 * XState machine at load time; users edit the flat shape and never
 * see machine concepts.
 *
 * A workflow is one trigger + an ordered pipeline of nodes. Each
 * node's output becomes the next node's input. The first node sees
 * `undefined` as input.
 */
export interface WorkflowDef {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  trigger: WorkflowTrigger;
  pipeline: WorkflowNodeDef[];
}

/**
 * How a workflow is invoked. V1 keeps it simple: scheduled or
 * user-launched. Event-driven triggers (subscribing to internal
 * `task.completed` etc.) will land once we have a clear use case
 * — adding the wire format now would force decisions we don't need
 * to make yet.
 */
export type WorkflowTrigger =
  | { kind: 'cron'; every: string }
  | { kind: 'manual'; palette?: string }
  /**
   * Autopilot-scoped scenario. The workflow scheduler only fires
   * these when `appMode === 'autopilot'`. Two firing patterns:
   *   - `when: 'cron'` + `every`: same as a normal cron trigger,
   *     but gated by autopilot mode.
   *   - `when: 'inbox-changed'` + optional `sources` filter:
   *     dispatched by InboxEventBridge whenever a new item lands
   *     under one of the listed source ids. Per-(workflowId, itemId)
   *     dedupe + `minIntervalMs` rate-limit prevent runaway fires.
   */
  | {
      kind: 'autopilot';
      when: 'cron' | 'inbox-changed';
      every?: string;
      sources?: string[];
      minIntervalMs?: number;
    };

/** Known node `type`s as of V1. Treated as opaque strings on the
 *  wire so adding new node types later doesn't require a type bump.
 *  The registry in main is the source of truth. */
export type WorkflowNodeType =
  | 'http-fetch'
  | 'osascript'
  | 'shell'
  | 'transform'
  | 'inbox-write'
  | 'notify'
  | 'run-skill'
  | 'mcp-call'
  | 'draft-output'
  | 'draft-store-write'
  | 'prompt-output'
  | 'batch-prompt-output';

// ─── AI Drafts ────────────────────────────────────────────────────────

/**
 * Lifecycle of a draft:
 *   - pending    AI produced it; user hasn't acted yet.
 *   - sending    User clicked Send; the MCP call is in flight.
 *   - sent       Sent successfully — moves out of the default view.
 *   - failed     Send failed; user can retry or edit.
 *   - discarded  User threw it away.
 */
export type DraftStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'discarded';

/**
 * Legacy intent enum. Kept for type compatibility with already-stored
 * rows; new code reads `Draft.actions` instead. Drafts migrated from
 * the old schema synthesise an `actions` array from intent +
 * sendAction at read time.
 */
export type DraftIntent = 'reply' | 'archive';

/**
 * One possible resolution for a draft. The LLM emits 1-N actions per
 * draft based on what makes sense for the message. Each action carries
 * its own UI label and its own dispatch template (`sendAction`).
 *
 * Example — a Gmail message that's borderline spam might get:
 *   [
 *     { id: 'send', label: 'Reply anyway', primary: true,
 *       requiresBody: true, sendAction: <gmail send_message> },
 *     { id: 'archive', label: 'Archive (spam)',
 *       requiresBody: false, sendAction: <gmail modify_labels> },
 *   ]
 *
 * A Slack DM from a co-worker about a PM-team topic might get:
 *   [
 *     { id: 'send', label: 'Reply', primary: true,
 *       requiresBody: true, sendAction: <slack send_message> },
 *     { id: 'forward-pm', label: 'Forward to #pm',
 *       requiresBody: false, sendAction: <slack send_message
 *                                          to #pm with quote> },
 *   ]
 *
 * The user picks one — clicking an action resolves the draft (status
 * goes to 'sent' / 'failed'). Actions are mutually exclusive.
 */
export interface DraftAction {
  /** Stable id within the draft. Used as the API selector when the
   *  user picks this action (sendDraft(draftId, actionId)). Examples:
   *  'send', 'archive', 'forward-pm', 'star-and-archive'. */
  id: string;
  /** Button text the user clicks. Keep it short (≤ 24 chars). */
  label: string;
  /** Optional one-liner shown as tooltip / secondary text. */
  description?: string;
  /** Exactly one action per draft can be marked primary — it gets
   *  the accent color in the UI. If none is primary, the first
   *  in the array is treated as primary. */
  primary?: boolean;
  /** When true (or omitted, default true), the action consumes the
   *  user-editable body — the UI shows the textarea + Refine, and
   *  the body is substituted into the sendAction at dispatch time.
   *  Set false for body-less actions (archive, label-as, star,
   *  forward-to-fixed-recipient). When ALL actions have
   *  requiresBody=false, the UI hides the textarea entirely. */
  requiresBody?: boolean;
  sendAction: SendAction;
}

/**
 * Channel-specific dispatch template carried on each draft. Two shapes:
 *
 *   - `kind: 'mcp'` (default) — invoke an MCP tool. The editable body
 *     is substituted into `args[bodyKey]` and the store calls
 *     `invokeMcpTool(mcp, tool, args)`. Used by Gmail, Slack, any
 *     channel with a tool-shaped API.
 *
 *   - `kind: 'shell'` — `execFile(cmd, args)`. Each occurrence of
 *     `bodyToken` (default `'{body}'`) in any of the literal args is
 *     replaced with the editable body before exec. Used by GitHub PR
 *     replies / reviews (gh CLI) where the canonical send path is
 *     already shell-based. Restricted to an allowlist of commands
 *     server-side; never accepts arbitrary `cmd`.
 *
 * Producers fill the shape that fits their channel. The store + UI
 * are channel-agnostic — they just dispatch on `kind` at send time.
 */
export type SendAction =
  | {
      kind?: 'mcp';
      /** Resolved MCP server id (e.g. 'gmail-ben@hive.app', 'slack'). */
      mcp: string;
      /** Tool name on that server (e.g. 'send_message'). */
      tool: string;
      /** Fixed args. The editable body is substituted in at send time,
       *  not stored here. */
      args: Record<string, unknown>;
      /** Which key of `args` the body slots into (e.g. 'body' for
       *  Gmail, 'text' for Slack). Omit for actions that have no
       *  user-editable body (e.g. archive/modify_labels) — the args
       *  are sent as-is. */
      bodyKey?: string;
    }
  | {
      kind: 'shell';
      /** Command to exec. Must be on the allowlist (currently: 'gh'). */
      cmd: string;
      /** Literal args. Token substitution applies (see below). */
      args: string[];
      /** Optional stdin payload — useful for `gh api --input -` style
       *  calls that need a JSON request body. Token substitution
       *  applies. */
      stdin?: string;
      /** Optional working directory. Defaults to the user's home. */
      cwd?: string;
      /** Timeout in ms. Default 30s. */
      timeoutMs?: number;
    };

/**
 * Substitution tokens used in shell SendAction `args` and `stdin`:
 *
 *   - `{body}`       → literal body, no escaping. Use in shell args
 *                      where execFile passes the value as a single
 *                      arg (e.g. `-f body={body}`).
 *   - `{body_json}`  → `JSON.stringify(body)` (quoted + escaped).
 *                      Use inside JSON-shaped stdin payloads:
 *                      `{"body": {body_json}, "event": "APPROVE"}`.
 *
 * Both tokens replace every occurrence, anywhere they appear.
 */

export interface Draft {
  id: string;
  /** Producer id — the workflow / module that wrote the draft. Used to
   *  group + filter ("via gmail-triage"). */
  source: string;
  /** Channel family — drives the UI badge and lets the user filter
   *  ("just my email drafts"). */
  channel: string;
  /** Producer's natural id for the upstream item (gmail message id,
   *  slack ts, PR comment id). Drives idempotent dedupe via a partial
   *  unique index. */
  sourceItemId?: string | null;
  status: DraftStatus;
  /** Possible resolutions for the user to pick from. The LLM emits 1-N
   *  per draft based on what makes sense for the message. The UI
   *  renders one button per action; clicking dispatches that action's
   *  sendAction and resolves the draft. */
  actions: DraftAction[];
  /** Legacy: classification before actions[] existed. New code
   *  ignores this; reads carry it for compat only. Synthesized into
   *  actions[] for old rows during DB read. */
  intent?: DraftIntent;
  title: string;
  /** Short context line shown in the collapsed row. */
  contextSummary?: string | null;
  /** Full upstream content (original email body, slack thread excerpt)
   *  — surfaced when the row expands and fed to the refine engine. */
  contextFull?: string | null;
  /** Current editable body — what an action with requiresBody=true
   *  will substitute into its sendAction at dispatch time. Hidden by
   *  the UI when no action consumes a body. */
  currentBody: string;
  /** AI's first draft. Drives the Revert button. */
  originalBody: string;
  /** One-sentence reasoning from the triage skill. */
  why?: string | null;
  /** Workflow run that produced this draft, if any. Audit trail. */
  workflowId?: string | null;
  createdAt: number;
  updatedAt: number;
  sentAt?: number | null;
  /** JSON-serialized result of the send (success body / error). */
  sentResult?: unknown;
}

/** Shape producers pass to `DraftsStore.create`. */
export interface NewDraft {
  source: string;
  channel: string;
  sourceItemId?: string | null;
  title: string;
  contextSummary?: string | null;
  contextFull?: string | null;
  /** The default body for actions that consume one. Substituted into
   *  `sendAction.args[bodyKey]` at dispatch time. Pass an empty
   *  string when no action requires a body. */
  body: string;
  why?: string | null;
  /** Possible resolutions for this draft. At least one required.
   *  If the producer hasn't migrated to actions[] yet, the
   *  workflow node synthesises one from a legacy { intent,
   *  sendAction } pair. */
  actions: DraftAction[];
  workflowId?: string | null;
}

export interface WorkflowNodeDef {
  type: string;
  params?: Record<string, unknown>;
  /** Skip this node when prev output is null/undefined. */
  optional?: boolean;
}

export type WorkflowRunStatus =
  | 'running'
  | 'completed'
  | 'errored'
  | 'aborted';

export interface WorkflowRunStep {
  index: number;
  nodeType: string;
  startedAt: number;
  endedAt: number | null;
  status: 'pending' | 'running' | 'completed' | 'errored' | 'skipped';
  error?: string;
  /** The value this step emitted on completion. Captured so the UI can
   *  show "what did this node actually produce" without re-running.
   *  Truncated if the serialized form exceeds 100KB. */
  output?: unknown;
  /** Set when `output` was truncated for size; the original was bigger
   *  than what's in `output`. UI surfaces this so users don't think
   *  they're seeing the full payload. */
  outputTruncated?: boolean;
}

/** One execution of a workflow. Lives in memory; older runs prune. */
export interface WorkflowRun {
  id: string;
  workflowId: string;
  trigger: 'cron' | 'manual' | 'autopilot' | 'inbox-event';
  startedAt: number;
  endedAt: number | null;
  status: WorkflowRunStatus;
  steps: WorkflowRunStep[];
  error?: string;
}

/** Built-in connector ids. Open to extension via custom string for any
 *  future connectors that haven't been registered as part of the core
 *  enum (test-echo lives here so the renderer can render it like any
 *  other). */
export type ConnectorId =
  | 'test-echo'
  | 'slack'
  | 'google'
  | 'notion'
  | 'linear'
  | 'github';

/** What the renderer sees about a single connected account. Tokens
 *  never cross IPC — they live in Keychain only. */
export interface ConnectorAccount {
  id: string;
  connectorId: ConnectorId;
  label: string;
  addedAt: number;
  /** ms epoch; null = non-expiring (Slack, Notion). */
  expiresAt: number | null;
  scopes: string[];
  /** Connector-specific extras (e.g. Slack `sendAs`, Google `email`). */
  meta: Record<string, unknown>;
  /** True if the most recent refresh attempt failed and the user needs
   *  to re-authorize. Surfaces a "Reconnect" affordance in the UI. */
  needsReauth?: boolean;
}

/** What credentials a connector wants from the user. Drives the form
 *  rendered inside the per-connector setup panel. */
export interface ConnectorCredentialSpec {
  needsCredentials: boolean;
  needsClientSecret: 'required' | 'optional' | 'never';
}

/** Renderer-side mirror of the connector's API-key path metadata.
 *  Only the descriptive fields cross IPC — the validating callback
 *  stays on main. Presence in `ConnectorSummary.apiKeyMode` is the
 *  signal to render the "API key" tab. */
export interface ConnectorApiKeyMode {
  label: string;
  helpText: string;
  helpUrl?: string;
  placeholder: string;
}

/** Per-connector summary the renderer renders into the Integrations
 *  page's "Connected accounts" section. Built by the orchestrator from
 *  the registry + the account store. */
export interface ConnectorSummary {
  id: ConnectorId;
  name: string;
  description: string;
  /** When false, the "Connect" button is hidden — the connector is in
   *  the registry but not yet ready for production use. Test-echo uses
   *  this to opt out of looking like a real provider. */
  builtIn: boolean;
  accounts: ConnectorAccount[];
  defaultAccountId: string | null;
  /** What credentials this connector expects. */
  credentialSpec: ConnectorCredentialSpec;
  /** True when credentials are present (Keychain or bundled fallback)
   *  and the Connect button can fire OAuth. False means the setup
   *  panel should surface a credentials form first. */
  credentialsConfigured: boolean;
  /** Set when the connector exposes a personal-API-key path; renderer
   *  offers it as an alternative tab in the setup panel. */
  apiKeyMode?: ConnectorApiKeyMode;
}

/** What `integrations:connect` returns. Renderer opens `authUrl` in the
 *  external browser, then awaits the callback via `integrations:awaitCallback`. */
export interface ConnectInit {
  flowId: string;
  authUrl: string;
}
