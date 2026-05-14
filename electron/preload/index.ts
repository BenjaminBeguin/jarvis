import { contextBridge, ipcRenderer } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type {
  AppStatus,
  AuthMode,
  ClaudeMcpEntry,
  DispatchIntentResult,
  JarvisFileEntry,
  LaunchTaskRequest,
  McpInvokeResult,
  McpProbeResult,
  McpServerInput,
  McpServerSummary,
  ModuleSummary,
  Reminder,
  RoutePromptResult,
  RoutineDef,
  SkillSuggestion,
  SkillSummary,
  TaskEvent,
  TaskSummary,
  TranscribeProgress,
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
  setSubscriptionToken: (value: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.setSubscriptionToken, value),
  clearSubscriptionToken: (): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.clearSubscriptionToken),
  setAuthMode: (mode: AuthMode): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.setAuthMode, mode),

  openObservatory: (taskId?: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.openObservatory, taskId),
  onObservatoryFocusTask: (listener: Listener<string>): Unsubscribe =>
    subscribe(IpcChannels.observatoryFocusTask, listener),
  onShellNavigate: (
    listener: Listener<{
      tab?: 'observatory' | 'routines' | 'integrations' | 'modules';
      moduleId?: string;
    }>,
  ): Unsubscribe => subscribe(IpcChannels.shellNavigate, listener),
  openPalette: (): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.openPalette),
  resizePalette: (height: number): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.resizePalette, height),
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.openExternal, url),

  showAnswerHud: (taskId: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.showAnswerHud, taskId),
  hideAnswerHud: (): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.hideAnswerHud),
  resizeAnswerHud: (height: number): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.resizeAnswerHud, height),
  onAnswerHudTrack: (listener: Listener<string>): Unsubscribe =>
    subscribe(IpcChannels.answerHudTrack, listener),

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
  listClaudeMcps: (): Promise<ClaudeMcpEntry[]> =>
    ipcRenderer.invoke(IpcChannels.listClaudeMcps),
  addMcpServer: (input: McpServerInput): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.addMcpServer, input),
  removeMcpServer: (id: string): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.removeMcpServer, id),
  readMcpFile: (): Promise<{ path: string; contents: string | null }> =>
    ipcRenderer.invoke(IpcChannels.readMcpFile),
  revealMcpFile: (): Promise<void> => ipcRenderer.invoke(IpcChannels.revealMcpFile),
  probeMcpTools: (id: string): Promise<McpProbeResult> =>
    ipcRenderer.invoke(IpcChannels.probeMcpTools, id),
  invokeMcpTool: (
    id: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpInvokeResult> =>
    ipcRenderer.invoke(IpcChannels.invokeMcpTool, { id, toolName, args }),

  listModules: (): Promise<ModuleSummary[]> =>
    ipcRenderer.invoke(IpcChannels.listModules),
  dispatchIntent: (
    moduleId: string,
    intentId: string,
    input: string,
  ): Promise<DispatchIntentResult> =>
    ipcRenderer.invoke(IpcChannels.dispatchIntent, { moduleId, intentId, input }),
  setModuleEnabled: (moduleId: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.setModuleEnabled, { moduleId, enabled }),
  onModulesChanged: (listener: Listener<ModuleSummary[]>): Unsubscribe =>
    subscribe(IpcChannels.modulesChanged, listener),

  listJarvisDir: (rel: string): Promise<JarvisFileEntry[]> =>
    ipcRenderer.invoke(IpcChannels.listJarvisDir, rel),
  readJarvisFile: (rel: string): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.readJarvisFile, rel),
  deleteNoteEntry: (
    date: string,
    fileIndex: number,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.deleteNoteEntry, { date, fileIndex }),

  requestMicAccess: (): Promise<{ granted: boolean; status: string }> =>
    ipcRenderer.invoke(IpcChannels.requestMicAccess),
  micStatus: (): Promise<{ status: string }> =>
    ipcRenderer.invoke(IpcChannels.micStatus),

  transcribe: (pcm: ArrayBuffer): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.transcribeAudio, pcm),
  onTranscribeProgress: (listener: Listener<TranscribeProgress>): Unsubscribe =>
    subscribe(IpcChannels.transcribeProgress, listener),

  meetingFinish: (payload: {
    title: string;
    startedAt: number;
    endedAt: number;
    sampleRate: number;
    pcm: ArrayBuffer;
  }): Promise<{ filename: string }> =>
    ipcRenderer.invoke(IpcChannels.meetingFinish, payload),
  onMeetingStart: (
    listener: Listener<{ title: string; startedAt: number }>,
  ): Unsubscribe => subscribe(IpcChannels.meetingStart, listener),
  onMeetingStopRequest: (listener: Listener<void>): Unsubscribe =>
    subscribe(IpcChannels.meetingStopRequest, listener),

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

  routePrompt: (
    prompt: string,
    options?: { origin?: 'palette' | 'voice' },
  ): Promise<RoutePromptResult> =>
    ipcRenderer.invoke(IpcChannels.routePrompt, { prompt, origin: options?.origin }),
  previewIntent: (
    prompt: string,
  ): Promise<
    | { kind: 'task'; body: string }
    | { kind: 'reminder'; mode: 'reminder' | 'scheduled'; body: string; fireAt: number }
  > => ipcRenderer.invoke(IpcChannels.previewIntent, prompt),

  listSkillSuggestions: (): Promise<SkillSuggestion[]> =>
    ipcRenderer.invoke(IpcChannels.listSkillSuggestions),
  acceptSkillSuggestion: (
    id: string,
  ): Promise<{ ok: boolean; message?: string; path?: string }> =>
    ipcRenderer.invoke(IpcChannels.acceptSkillSuggestion, id),
  dismissSkillSuggestion: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.dismissSkillSuggestion, id),
  removeSkillSuggestion: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.removeSkillSuggestion, id),
  onSkillSuggestionsChanged: (
    listener: Listener<SkillSuggestion[]>,
  ): Unsubscribe => subscribe(IpcChannels.skillSuggestionsChanged, listener),

  listReminders: (): Promise<Reminder[]> =>
    ipcRenderer.invoke(IpcChannels.listReminders),
  cancelReminder: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.cancelReminder, id),
  removeReminder: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.removeReminder, id),
  fireReminderNow: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.fireReminderNow, id),
  onRemindersChanged: (listener: Listener<Reminder[]>): Unsubscribe =>
    subscribe(IpcChannels.remindersChanged, listener),

  launchTask: (req: LaunchTaskRequest): Promise<TaskSummary> =>
    ipcRenderer.invoke(IpcChannels.launchTask, req),
  launchShell: (cmd: string): Promise<TaskSummary> =>
    ipcRenderer.invoke(IpcChannels.launchShell, cmd),
  abortTask: (taskId: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.abortTask, taskId),
  sendTaskMessage: (taskId: string, text: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.sendTaskMessage, { taskId, text }),
  listTasks: (): Promise<TaskSummary[]> =>
    ipcRenderer.invoke(IpcChannels.listTasks),
  getTaskHistory: (taskId: string): Promise<TaskEvent[]> =>
    ipcRenderer.invoke(IpcChannels.getTaskHistory, taskId),

  onTaskEvent: (
    listener: Listener<{ taskId: string; event: TaskEvent }>,
  ): Unsubscribe => subscribe(IpcChannels.taskEvent, listener),
  onTaskStatus: (listener: Listener<TaskSummary>): Unsubscribe =>
    subscribe(IpcChannels.taskStatus, listener),
  onTaskRemoved: (listener: Listener<string>): Unsubscribe =>
    subscribe(IpcChannels.taskRemoved, listener),
  onAppStatus: (listener: Listener<AppStatus>): Unsubscribe =>
    subscribe(IpcChannels.appStatus, listener),
};

export type JarvisApi = typeof api;

contextBridge.exposeInMainWorld('jarvis', api);
