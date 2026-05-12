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
}

export interface AppStatus {
  hasApiKey: boolean;
  version: string;
}
