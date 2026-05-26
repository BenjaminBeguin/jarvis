import { contextBridge, ipcRenderer } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type {
  ActivityEvent,
  AppMode,
  AppStatus,
  AuthMode,
  BatchDecision,
  ClaudeMcpEntry,
  ConnectorAccount,
  ConnectorId,
  ConnectorSummary,
  Draft,
  DraftStatus,
  InboxPrefs,
  DispatchIntentResult,
  JarvisFileEntry,
  CostBreakdown,
  CostPrefs,
  CostSummary,
  HttpApiStatus,
  InboxItem,
  InboxSourceSummary,
  LaunchTaskRequest,
  McpInvokeResult,
  McpProbeResult,
  McpServerInput,
  McpServerSummary,
  MeetingDetectionStatus,
  ModuleSettingsValues,
  ModuleSummary,
  NotificationPrefs,
  NotifierEmitPayload,
  WorkflowDef,
  WorkflowRun,
  WorkingHoursPrefs,
  ProjectDef,
  ProjectInput,
  ProjectMemoryFile,
  ProjectTemplateSummary,
  Reminder,
  DashboardConfig,
  RoutePromptResult,
  RoutineDef,
  SessionConfig,
  SkillSuggestion,
  SkillSummary,
  TaskEvent,
  TaskSummary,
  TranscribeProgress,
  TrayMenuState,
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

  getAfk: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.getAfk),
  setAfk: (value: boolean): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.setAfk, value),
  onAfkChanged: (listener: Listener<boolean>): Unsubscribe =>
    subscribe(IpcChannels.afkChanged, listener),

  getPaused: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.getPaused),
  setPaused: (value: boolean): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.setPaused, value),
  onPausedChanged: (listener: Listener<boolean>): Unsubscribe =>
    subscribe(IpcChannels.pausedChanged, listener),

  // Tri-state operating mode.
  getAppMode: (): Promise<AppMode> =>
    ipcRenderer.invoke(IpcChannels.getAppMode),
  setAppMode: (mode: AppMode): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.setAppMode, mode),
  onAppModeChanged: (listener: Listener<AppMode>): Unsubscribe =>
    subscribe(IpcChannels.appModeChanged, listener),

  // Autopilot approval flow (prompt-output node).
  onAutopilotApprovalRequested: (
    listener: Listener<{
      requestId: string;
      workflowId: string;
      title: string;
      summary?: string;
      // Single-item shape (prompt-output node)
      body?: string;
      context?: string;
      // Batch shape (batch-prompt-output node). Renderer routes by
      // presence of `items`.
      items?: Array<{
        id: string;
        preview: Array<{ label: string; value: string }>;
        draft: string;
        verdict?: string;
        context?: string;
      }>;
    }>,
  ): Unsubscribe => subscribe(IpcChannels.autopilotApprovalRequested, listener),
  autopilotApprove: (
    requestId: string,
    editedBody?: string,
  ): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IpcChannels.autopilotApprove, {
      requestId,
      editedBody,
    }),
  autopilotReject: (
    requestId: string,
    feedback?: string,
  ): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IpcChannels.autopilotReject, {
      requestId,
      feedback,
    }),
  autopilotApproveBatch: (
    requestId: string,
    decisions: BatchDecision[],
  ): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IpcChannels.autopilotApproveBatch, {
      requestId,
      decisions,
    }),
  autopilotFeedback: (
    action: 'list' | 'read' | 'clear',
    workflowId: string,
  ): Promise<unknown> =>
    ipcRenderer.invoke(IpcChannels.autopilotFeedback, { action, workflowId }),

  // Conversation sidebar — push reduced-chip count to the tray.
  setReducedConversationsCount: (count: number): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IpcChannels.conversationsSetReducedCount, { count }),

  /** Push the current set of pinned conversations so the tray menu
   *  surfaces them. Renderer calls this whenever the pin set
   *  changes; main replaces the list wholesale. */
  setPinnedConversations: (
    entries: Array<{
      taskId: string;
      title: string;
      status: TaskSummary['status'];
      reduced: boolean;
    }>,
  ): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IpcChannels.conversationsSetPinned, { entries }),

  /** Tray menu clicked → focus this conversation. Fired with a
   *  `{ taskId }` payload; the renderer should bump+focus that tab
   *  in the sidebar. */
  onConversationFocus: (
    listener: Listener<{ taskId: string }>,
  ): Unsubscribe =>
    subscribe(IpcChannels.conversationFocus, listener),

  setTelegramBotToken: (value: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.setTelegramBotToken, value),
  clearTelegramBotToken: (): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.clearTelegramBotToken),
  hasTelegramBotToken: (): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.hasTelegramBotToken),

  openObservatory: (taskId?: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.openObservatory, taskId),
  onObservatoryFocusTask: (listener: Listener<string>): Unsubscribe =>
    subscribe(IpcChannels.observatoryFocusTask, listener),
  onShellNavigate: (
    listener: Listener<{
      tab?:
        | 'observatory'
        | 'inbox'
        | 'projects'
        | 'routines'
        | 'skills'
        | 'settings';
      moduleId?: string;
      action?: 'open-new-project';
      initial?: string;
      skillId?: string;
    }>,
  ): Unsubscribe => subscribe(IpcChannels.shellNavigate, listener),
  openPalette: (): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.openPalette),
  resizePalette: (height: number): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.resizePalette, height),
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.openExternal, url),
  openInClaudeDesktop: (
    sessionId: string,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.openInClaudeDesktop, sessionId),
  costSummary: (): Promise<CostSummary> =>
    ipcRenderer.invoke(IpcChannels.costSummary),
  costBreakdown: (windowDays: number): Promise<CostBreakdown> =>
    ipcRenderer.invoke(IpcChannels.costBreakdown, windowDays),
  costPrefsRead: (): Promise<CostPrefs> =>
    ipcRenderer.invoke(IpcChannels.costPrefsRead),
  costPrefsWrite: (prefs: CostPrefs): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.costPrefsWrite, prefs),
  workingHoursRead: (): Promise<WorkingHoursPrefs> =>
    ipcRenderer.invoke(IpcChannels.workingHoursRead),
  workingHoursWrite: (
    prefs: WorkingHoursPrefs,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.workingHoursWrite, prefs),

  httpApiStatus: (): Promise<HttpApiStatus> =>
    ipcRenderer.invoke(IpcChannels.httpApiStatus),
  rotateHttpApiToken: (): Promise<{ token: string; url: string | null }> =>
    ipcRenderer.invoke(IpcChannels.rotateHttpApiToken),

  showAnswerHud: (taskId: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.showAnswerHud, taskId),
  hideAnswerHud: (): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.hideAnswerHud),
  resizeAnswerHud: (height: number): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.resizeAnswerHud, height),
  setAnswerHudInteractive: (interactive: boolean): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.setAnswerHudInteractive, interactive),
  onAnswerHudTrack: (listener: Listener<string>): Unsubscribe =>
    subscribe(IpcChannels.answerHudTrack, listener),

  /** Custom tray menu: read state, subscribe to changes, dismiss. */
  trayMenuRead: (): Promise<TrayMenuState> =>
    ipcRenderer.invoke(IpcChannels.trayMenuRead),
  onTrayMenuStateChanged: (
    listener: Listener<TrayMenuState>,
  ): Unsubscribe => subscribe(IpcChannels.trayMenuStateChanged, listener),
  hideTrayMenu: (): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.trayMenuHide),
  resizeTrayMenu: (height: number): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.trayMenuResize, height),
  quitApp: (): Promise<void> => ipcRenderer.invoke(IpcChannels.trayMenuQuit),

  /** Bring the main window forward and switch to the given tab. */
  openTab: (tab: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.openTab, tab),

  /** Subscribe to the global voice-shortcut toggle. Fires once per
   *  shortcut press; consumer decides whether to start or stop
   *  based on its own listening state. */
  onPaletteToggleVoice: (listener: Listener<void>): Unsubscribe =>
    subscribe(IpcChannels.paletteToggleVoice, listener),

  /** Voice orb: receive shortcut toggles + ask main to dismiss. */
  onVoiceOrbToggle: (listener: Listener<void>): Unsubscribe =>
    subscribe(IpcChannels.voiceOrbToggle, listener),
  hideVoiceOrb: (): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.voiceOrbHide),

  listSkills: (): Promise<SkillSummary[]> =>
    ipcRenderer.invoke(IpcChannels.listSkills),
  refreshSkills: (): Promise<SkillSummary[]> =>
    ipcRenderer.invoke(IpcChannels.refreshSkills),
  onSkillsChanged: (listener: Listener<SkillSummary[]>): Unsubscribe =>
    subscribe(IpcChannels.listSkills, listener),
  writeSkillBody: (
    skillId: string,
    raw: string,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.writeSkillBody, skillId, raw),
  createSkill: (input: {
    name: string;
    description?: string;
    body?: string;
  }): Promise<{ ok: boolean; id?: string; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.createSkill, input),
  deleteSkill: (
    skillId: string,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.deleteSkill, skillId),
  revealSkill: (skillId: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.revealSkill, skillId),

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
  /**
   * Toggle the disable flag on an MCP. Pass `untilMs` as:
   *   - `undefined` (or omit the arg) → re-enable
   *   - `null` → disabled indefinitely
   *   - epoch ms → disabled until that timestamp
   */
  setMcpDisabled: (
    id: string,
    untilMs?: number | null,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.setMcpDisabled, {
      id,
      // Only include the field when explicitly set; absence means
      // "re-enable" on the main side.
      ...(untilMs === undefined ? {} : { untilMs }),
    }),
  readMcpFile: (): Promise<{ path: string; contents: string | null }> =>
    ipcRenderer.invoke(IpcChannels.readMcpFile),
  writeMcpFile: (
    json: string,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.writeMcpFile, json),
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
  writeModuleSettings: (
    moduleId: string,
    values: ModuleSettingsValues,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.writeModuleSettings, { moduleId, values }),
  onModulesChanged: (listener: Listener<ModuleSummary[]>): Unsubscribe =>
    subscribe(IpcChannels.modulesChanged, listener),

  listJarvisDir: (rel: string): Promise<JarvisFileEntry[]> =>
    ipcRenderer.invoke(IpcChannels.listJarvisDir, rel),
  readJarvisFile: (rel: string): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.readJarvisFile, rel),
  writeJarvisFile: (
    path: string,
    contents: string,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.writeJarvisFile, { path, contents }),
  pickDirectory: (
    options?: { multi?: boolean; defaultPath?: string },
  ): Promise<string[]> =>
    ipcRenderer.invoke(IpcChannels.pickDirectory, options),

  listProjects: (): Promise<ProjectDef[]> =>
    ipcRenderer.invoke(IpcChannels.listProjects),
  createProject: (input: ProjectInput): Promise<ProjectDef> =>
    ipcRenderer.invoke(IpcChannels.createProject, input),
  updateProject: (
    currentName: string,
    patch: ProjectInput,
  ): Promise<ProjectDef> =>
    ipcRenderer.invoke(IpcChannels.updateProject, { currentName, patch }),
  deleteProject: (name: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.deleteProject, name),
  listProjectTemplates: (): Promise<ProjectTemplateSummary[]> =>
    ipcRenderer.invoke(IpcChannels.listProjectTemplates),
  setActiveProject: (name: string | null): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.setActiveProject, name),
  setProjectInboxScan: (name: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.setProjectInboxScan, { name, enabled }),
  onProjectsChanged: (listener: Listener<ProjectDef[]>): Unsubscribe =>
    subscribe(IpcChannels.projectsChanged, listener),
  listProjectMemory: (project: string): Promise<ProjectMemoryFile[]> =>
    ipcRenderer.invoke(IpcChannels.listProjectMemory, project),
  readProjectMemory: (project: string, file: string): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.readProjectMemory, { project, file }),
  writeProjectMemory: (
    project: string,
    file: string,
    content: string,
  ): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.writeProjectMemory, {
      project,
      file,
      content,
    }),
  deleteProjectMemory: (project: string, file: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.deleteProjectMemory, { project, file }),
  deleteNoteEntry: (
    date: string,
    fileIndex: number,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.deleteNoteEntry, { date, fileIndex }),
  setNoteEntryArchived: (
    date: string,
    fileIndex: number,
    archived: boolean,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.setNoteEntryArchived, {
      date,
      fileIndex,
      archived,
    }),

  readPreferences: (): Promise<{ path: string; contents: string }> =>
    ipcRenderer.invoke(IpcChannels.readPreferences),
  writePreferences: (contents: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.writePreferences, contents),
  revealPreferences: (): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.revealPreferences),
  onPreferencesChanged: (listener: Listener<string>): Unsubscribe =>
    subscribe(IpcChannels.preferencesChanged, listener),

  readNotificationPrefs: (): Promise<NotificationPrefs> =>
    ipcRenderer.invoke(IpcChannels.readNotificationPrefs),
  writeNotificationPrefs: (prefs: NotificationPrefs): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.writeNotificationPrefs, prefs),
  onNotificationPrefsChanged: (
    listener: Listener<NotificationPrefs>,
  ): Unsubscribe => subscribe(IpcChannels.notificationPrefsChanged, listener),

  readInboxPrefs: (): Promise<InboxPrefs> =>
    ipcRenderer.invoke(IpcChannels.readInboxPrefs),
  writeInboxPrefs: (prefs: InboxPrefs): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.writeInboxPrefs, prefs),
  onInboxPrefsChanged: (
    listener: Listener<InboxPrefs>,
  ): Unsubscribe => subscribe(IpcChannels.inboxPrefsChanged, listener),

  listInbox: (): Promise<InboxItem[]> =>
    ipcRenderer.invoke(IpcChannels.listInbox),
  listInboxDismissed: (): Promise<InboxItem[]> =>
    ipcRenderer.invoke(IpcChannels.listInboxDismissed),
  listInboxSources: (skillIds: string[]): Promise<InboxSourceSummary[]> =>
    ipcRenderer.invoke(IpcChannels.listInboxSources, skillIds),
  revealInboxFile: (
    name: string,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.revealInboxFile, name),
  refreshInbox: (): Promise<InboxItem[]> =>
    ipcRenderer.invoke(IpcChannels.refreshInbox),
  hardRefreshInbox: (): Promise<InboxItem[]> =>
    ipcRenderer.invoke(IpcChannels.hardRefreshInbox),
  onInboxChanged: (listener: Listener<InboxItem[]>): Unsubscribe =>
    subscribe(IpcChannels.inboxChanged, listener),
  onInboxRefreshing: (listener: Listener<boolean>): Unsubscribe =>
    subscribe(IpcChannels.inboxRefreshing, listener),
  dismissInboxItem: (id: string, snoozeMs: number): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.dismissInboxItem, { id, snoozeMs }),
  restoreInboxItem: (id: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.restoreInboxItem, id),
  countInboxSource: (
    name: string,
  ): Promise<{ count: number; mtimeMs: number | null }> =>
    ipcRenderer.invoke(IpcChannels.countInboxSource, name),
  clearInboxSource: (
    name: string,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.clearInboxSource, name),
  onMeetingImminent: (
    listener: Listener<{ item: InboxItem; minutesUntil: number }>,
  ): Unsubscribe => subscribe(IpcChannels.meetingImminent, listener),
  suppressMeetingPrompt: (id: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.suppressMeetingPrompt, id),
  snoozeMeetingHeadsUp: (ms: number): Promise<{ until: number }> =>
    ipcRenderer.invoke(IpcChannels.snoozeMeetingHeadsUp, ms),
  /** Push the live MeetingRecorder state into the main process so
   *  the tray shows 🔴/⏸ + the meeting title, and the OS sleep
   *  inhibitor stays armed while recording. Fire-and-forget; no
   *  return value needed. */
  meetingRecorderState: (state: {
    active: boolean;
    paused: boolean;
    title: string | null;
  }): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.meetingRecorderState, state),
  /** Remote-control commands forwarded from the phone PWA via the
   *  HTTP API. Renderer's MeetingRecorder subscribes to this and
   *  calls pause/resume/cancel/stop. */
  onMeetingControlRemote: (
    listener: Listener<{ action: 'pause' | 'resume' | 'cancel' | 'finish' }>,
  ): Unsubscribe =>
    subscribe(IpcChannels.meetingControlRemote, listener),
  meetingDetectionStatus: (): Promise<MeetingDetectionStatus> =>
    ipcRenderer.invoke(IpcChannels.meetingDetectionStatus),
  onMeetingDetectionChanged: (
    listener: Listener<MeetingDetectionStatus>,
  ): Unsubscribe => subscribe(IpcChannels.meetingDetectionChanged, listener),

  readDashboard: (): Promise<DashboardConfig> =>
    ipcRenderer.invoke(IpcChannels.readDashboard),
  writeDashboard: (cfg: DashboardConfig): Promise<DashboardConfig> =>
    ipcRenderer.invoke(IpcChannels.writeDashboard, cfg),
  onDashboardChanged: (listener: Listener<DashboardConfig>): Unsubscribe =>
    subscribe(IpcChannels.dashboardChanged, listener),

  listBriefingKinds: (): Promise<
    Array<{
      id: string;
      label: string;
      description: string;
      skillId: string;
      schedule?: string;
    }>
  > => ipcRenderer.invoke(IpcChannels.listBriefingKinds),
  listBriefingFiles: (
    kindId: string,
  ): Promise<
    Array<{
      kind: string;
      filename: string;
      path: string;
      mtimeMs: number;
      sizeBytes: number;
      title: string;
      date: string | null;
    }>
  > => ipcRenderer.invoke(IpcChannels.listBriefingFiles, kindId),
  readBriefingFile: (kindId: string, filename: string): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.readBriefingFile, { kindId, filename }),
  writeBriefingFile: (
    kindId: string,
    filename: string,
    content: string,
  ): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.writeBriefingFile, {
      kindId,
      filename,
      content,
    }),
  readSkillBody: (skillId: string): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.readSkillBody, skillId),
  generateBriefing: (kindId: string): Promise<TaskSummary> =>
    ipcRenderer.invoke(IpcChannels.generateBriefing, kindId),
  onBriefingsChanged: (listener: Listener<void>): Unsubscribe =>
    subscribe(IpcChannels.briefingsChanged, listener),

  requestMicAccess: (): Promise<{ granted: boolean; status: string }> =>
    ipcRenderer.invoke(IpcChannels.requestMicAccess),
  micStatus: (): Promise<{ status: string }> =>
    ipcRenderer.invoke(IpcChannels.micStatus),

  transcribe: (pcm: ArrayBuffer): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.transcribeAudio, pcm),
  onTranscribeProgress: (listener: Listener<TranscribeProgress>): Unsubscribe =>
    subscribe(IpcChannels.transcribeProgress, listener),

  /** Speak text aloud via macOS `say`. Cancels any in-flight
   *  utterance automatically. */
  speak: (text: string, voice?: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IpcChannels.speak, { text, voice }),
  stopSpeaking: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IpcChannels.stopSpeaking),

  /** Tell main the renderer is opening / closing its own mic.
   *  Pairs to suppress the meeting-recorder auto-prompt while we
   *  are the ones using the mic. */
  noteSelfMicStart: (): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.noteSelfMicStart),
  noteSelfMicStop: (): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.noteSelfMicStop),

  meetingFinish: (payload: {
    title: string;
    project?: string | null;
    startedAt: number;
    endedAt: number;
    sampleRate: number;
    pcm: ArrayBuffer;
  }): Promise<{ filename: string }> =>
    ipcRenderer.invoke(IpcChannels.meetingFinish, payload),
  /** Long-meeting fast path: hand the main process an already-
   *  transcribed text blob built by stitching live chunks instead
   *  of a giant PCM buffer. Skips Whisper re-pass + the multi-MB
   *  IPC marshal that made Finish unresponsive on 1h+ recordings. */
  meetingFinishFromText: (payload: {
    title: string;
    project?: string | null;
    startedAt: number;
    endedAt: number;
    transcript: string;
  }): Promise<{ filename: string }> =>
    ipcRenderer.invoke(IpcChannels.meetingFinishFromText, payload),
  onMeetingStart: (
    listener: Listener<{ title: string; project?: string | null; startedAt: number }>,
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
    options?: {
      origin?: 'palette' | 'voice';
      sessionConfig?: SessionConfig;
    },
  ): Promise<RoutePromptResult> =>
    ipcRenderer.invoke(IpcChannels.routePrompt, {
      prompt,
      origin: options?.origin,
      sessionConfig: options?.sessionConfig,
    }),
  previewIntent: (
    prompt: string,
  ): Promise<
    | { kind: 'task'; body: string }
    | {
        kind: 'reminder';
        mode: 'reminder' | 'scheduled';
        body: string;
        fireAt: number;
        cron?: string;
      }
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
  markReminderDone: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.markReminderDone, id),
  onRemindersChanged: (listener: Listener<Reminder[]>): Unsubscribe =>
    subscribe(IpcChannels.remindersChanged, listener),

  launchTask: (req: LaunchTaskRequest): Promise<TaskSummary> =>
    ipcRenderer.invoke(IpcChannels.launchTask, req),
  launchShell: (cmd: string): Promise<TaskSummary> =>
    ipcRenderer.invoke(IpcChannels.launchShell, cmd),
  abortTask: (taskId: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.abortTask, taskId),
  sendTaskMessage: (
    taskId: string,
    text: string,
    images?: Array<{ mediaType: string; base64: string }>,
  ): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.sendTaskMessage, {
      taskId,
      text,
      ...(images && images.length > 0 ? { images } : {}),
    }),
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

  listActivity: (limit?: number): Promise<ActivityEvent[]> =>
    ipcRenderer.invoke(IpcChannels.listActivity, limit),
  onActivityChanged: (listener: Listener<ActivityEvent>): Unsubscribe =>
    subscribe(IpcChannels.activityChanged, listener),

  /** Live notifier broadcasts — every notifier.post() emits one. Used
   *  by the FlowStream page for terminal-stage orbs. */
  onNotifierEmitted: (listener: Listener<NotifierEmitPayload>): Unsubscribe =>
    subscribe(IpcChannels.notifierEmitted, listener),

  // ─── OAuth Integrations ─────────────────────────────────────────
  listIntegrations: (): Promise<ConnectorSummary[]> =>
    ipcRenderer.invoke(IpcChannels.listIntegrations),
  connectIntegration: (
    connectorId: ConnectorId,
  ): Promise<{ ok: boolean; flowId?: string; authUrl?: string; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.connectIntegration, { connectorId }),
  awaitIntegrationCallback: (
    flowId: string,
  ): Promise<{ ok: boolean; account?: ConnectorAccount; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.awaitIntegrationCallback, { flowId }),
  cancelIntegrationFlow: (
    flowId: string,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.cancelIntegrationFlow, { flowId }),
  connectIntegrationByApiKey: (
    connectorId: ConnectorId,
    apiKey: string,
  ): Promise<{ ok: boolean; account?: ConnectorAccount; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.connectIntegrationByApiKey, {
      connectorId,
      apiKey,
    }),
  testIntegrationAccount: (
    accountId: string,
  ): Promise<{ ok: boolean; summary?: string; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.testIntegrationAccount, { accountId }),
  disconnectIntegration: (
    accountId: string,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.disconnectIntegration, { accountId }),
  setIntegrationAccountMeta: (
    accountId: string,
    patch: Partial<ConnectorAccount>,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.setIntegrationAccountMeta, {
      accountId,
      patch,
    }),
  setIntegrationDefault: (
    connectorId: ConnectorId,
    accountId: string | null,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.setIntegrationDefault, {
      connectorId,
      accountId,
    }),
  setIntegrationCredentials: (
    connectorId: ConnectorId,
    clientId: string,
    clientSecret?: string,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.setIntegrationCredentials, {
      connectorId,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
    }),
  clearIntegrationCredentials: (
    connectorId: ConnectorId,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.clearIntegrationCredentials, {
      connectorId,
    }),
  onIntegrationsChanged: (listener: Listener<void>): Unsubscribe =>
    subscribe(IpcChannels.integrationsChanged, listener),

  // ─── Workflows ──────────────────────────────────────────────────
  listWorkflows: (): Promise<{ workflows: WorkflowDef[]; errors: Array<{ filename: string; message: string }> }> =>
    ipcRenderer.invoke(IpcChannels.listWorkflows),
  saveWorkflow: (
    def: WorkflowDef,
  ): Promise<{ ok: boolean; message?: string; warnings?: string[] }> =>
    ipcRenderer.invoke(IpcChannels.saveWorkflow, def),
  deleteWorkflow: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.deleteWorkflow, id),
  runWorkflow: (id: string): Promise<{ ok: boolean; run?: WorkflowRun; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.runWorkflow, id),
  stopWorkflowRun: (runId: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.stopWorkflowRun, runId),
  readWorkflowRun: (runId: string): Promise<WorkflowRun | null> =>
    ipcRenderer.invoke(IpcChannels.readWorkflowRun, runId),
  listWorkflowRuns: (workflowId?: string): Promise<WorkflowRun[]> =>
    ipcRenderer.invoke(IpcChannels.listWorkflowRuns, workflowId),
  onWorkflowsChanged: (listener: Listener<WorkflowDef[]>): Unsubscribe =>
    subscribe(IpcChannels.workflowsChanged, listener),
  onWorkflowRunChanged: (listener: Listener<WorkflowRun>): Unsubscribe =>
    subscribe(IpcChannels.workflowRunChanged, listener),

  // ─── AI Drafts ──────────────────────────────────────────────────
  listDrafts: (
    args?: {
      status?: DraftStatus | DraftStatus[];
      source?: string;
      channel?: string;
      limit?: number;
    },
  ): Promise<Draft[]> =>
    ipcRenderer.invoke(IpcChannels.listDrafts, args ?? {}),
  getDraft: (id: string): Promise<Draft | null> =>
    ipcRenderer.invoke(IpcChannels.getDraft, id),
  updateDraftBody: (id: string, body: string): Promise<Draft | null> =>
    ipcRenderer.invoke(IpcChannels.updateDraftBody, id, body),
  refineDraft: (
    id: string,
    prompt: string,
  ): Promise<{ ok: boolean; draft?: Draft | null; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.refineDraft, id, prompt),
  sendDraft: (
    id: string,
    actionId?: string,
  ): Promise<{ ok: boolean; draft?: Draft | null; message?: string }> =>
    ipcRenderer.invoke(IpcChannels.sendDraft, id, actionId),
  discardDraft: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.discardDraft, id),
  revertDraft: (id: string): Promise<Draft | null> =>
    ipcRenderer.invoke(IpcChannels.revertDraft, id),
  onDraftsChanged: (listener: Listener<void>): Unsubscribe =>
    subscribe(IpcChannels.draftsChanged, listener),
};

export type JarvisApi = typeof api;

contextBridge.exposeInMainWorld('jarvis', api);
