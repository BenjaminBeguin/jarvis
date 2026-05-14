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
}

/**
 * An MCP server that Claude itself (Claude Code / Claude.ai connectors)
 * knows about. Parsed from `claude mcp list`. Distinct from
 * `McpServerSummary` which only reflects Jarvis-managed local stdio MCPs
 * in ~/.jarvis/mcp.json.
 */
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
