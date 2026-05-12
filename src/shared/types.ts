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
  intents: PaletteIntentSummary[];
}

export interface DispatchIntentResult {
  ok: boolean;
  message?: string;
}

export type AuthMode = 'subscription' | 'api-key';

export interface AppStatus {
  authMode: AuthMode | null;
  hasApiKey: boolean;
  claudeBinaryPath: string | null;
  version: string;
}
