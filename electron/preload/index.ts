import { contextBridge, ipcRenderer } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type {
  AppStatus,
  AuthMode,
  LaunchTaskRequest,
  McpServerSummary,
  RoutineDef,
  SkillSummary,
  TaskEvent,
  TaskSummary,
} from '@shared/types';

type Listener<T> = (payload: T) => void;
type Unsubscribe = () => void;

function subscribe<T>(channel: string, listener: Listener<T>): Unsubscribe {
  const wrapped = (_e: unknown, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped as never);
  return () => ipcRenderer.removeListener(channel, wrapped as never);
}

const api = {
  getStatus: (): Promise<AppStatus> =>
    ipcRenderer.invoke(IpcChannels.appStatus),
  setApiKey: (value: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.setApiKey, value),
  clearApiKey: (): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.clearApiKey),
  setAuthMode: (mode: AuthMode): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.setAuthMode, mode),

  openObservatory: (): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.openObservatory),
  openPalette: (): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.openPalette),

  listSkills: (): Promise<SkillSummary[]> =>
    ipcRenderer.invoke(IpcChannels.listSkills),
  refreshSkills: (): Promise<SkillSummary[]> =>
    ipcRenderer.invoke(IpcChannels.refreshSkills),
  onSkillsChanged: (listener: Listener<SkillSummary[]>): Unsubscribe =>
    subscribe(IpcChannels.listSkills, listener),

  listMcpServers: (): Promise<McpServerSummary[]> =>
    ipcRenderer.invoke(IpcChannels.listMcpServers),
  onMcpServersChanged: (listener: Listener<McpServerSummary[]>): Unsubscribe =>
    subscribe(IpcChannels.listMcpServers, listener),

  listRoutines: (): Promise<RoutineDef[]> =>
    ipcRenderer.invoke(IpcChannels.listRoutines),
  saveRoutine: (
    input: Partial<RoutineDef> & { skillId: string; cron: string },
  ): Promise<RoutineDef> =>
    ipcRenderer.invoke(IpcChannels.saveRoutine, input),
  deleteRoutine: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.deleteRoutine, id),
  runRoutineNow: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.runRoutineNow, id),
  onRoutinesChanged: (listener: Listener<RoutineDef[]>): Unsubscribe =>
    subscribe(IpcChannels.routinesChanged, listener),

  launchTask: (req: LaunchTaskRequest): Promise<TaskSummary> =>
    ipcRenderer.invoke(IpcChannels.launchTask, req),
  abortTask: (taskId: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.abortTask, taskId),
  listTasks: (): Promise<TaskSummary[]> =>
    ipcRenderer.invoke(IpcChannels.listTasks),
  getTaskHistory: (taskId: string): Promise<TaskEvent[]> =>
    ipcRenderer.invoke(IpcChannels.getTaskHistory, taskId),

  onTaskEvent: (
    listener: Listener<{ taskId: string; event: TaskEvent }>,
  ): Unsubscribe => subscribe(IpcChannels.taskEvent, listener),
  onTaskStatus: (listener: Listener<TaskSummary>): Unsubscribe =>
    subscribe(IpcChannels.taskStatus, listener),
  onAppStatus: (listener: Listener<AppStatus>): Unsubscribe =>
    subscribe(IpcChannels.appStatus, listener),
};

export type JarvisApi = typeof api;

contextBridge.exposeInMainWorld('jarvis', api);
