export type TaskStatus = 'queued' | 'running' | 'completed' | 'aborted' | 'errored';

export type TaskOrigin = 'palette' | 'voice' | 'routine' | 'api';

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

export type AuthMode = 'subscription' | 'api-key';

export interface AppStatus {
  authMode: AuthMode | null;
  hasApiKey: boolean;
  claudeBinaryPath: string | null;
  version: string;
}
