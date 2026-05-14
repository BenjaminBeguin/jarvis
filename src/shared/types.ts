export type TaskStatus = 'queued' | 'running' | 'completed' | 'aborted' | 'errored';

export type TaskOrigin = 'palette' | 'voice' | 'routine' | 'api' | 'external';

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
}

export interface TaskEvent {
  seq: number;
  ts: number;
  msg: unknown;
}

export interface LaunchTaskRequest {
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
}

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

export type ReminderStatus = 'pending' | 'fired' | 'cancelled';

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
  /** ms epoch when it actually fired; null while pending. */
  firedAt: number | null;
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
   * One-click action — launches a task or routes through the palette.
   * Sources that have nothing to dispatch leave this undefined; the row
   * still shows as informational.
   */
  action?: {
    label: string;
    /** Skill id to launch — falls back to free-text routing if absent. */
    skillId?: string;
    /** Prompt text to send (or route through intent parser). */
    prompt: string;
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
