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

export interface RoutineDef {
  id: string;
  skillId: string;
  cron: string;
  input: string;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
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
