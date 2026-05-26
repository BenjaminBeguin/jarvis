export const IpcChannels = {
  appStatus: 'app:status',
  setApiKey: 'app:setApiKey',
  clearApiKey: 'app:clearApiKey',
  setSubscriptionToken: 'app:setSubscriptionToken',
  clearSubscriptionToken: 'app:clearSubscriptionToken',
  setAuthMode: 'app:setAuthMode',

  // AFK mode: when on, more notifications are mirrored to the phone
  // via the Telegram module. Read/write/event triple.
  getAfk: 'app:getAfk',
  setAfk: 'app:setAfk',
  afkChanged: 'app:afkChanged',

  // Global pause: when true, routines + scheduled-action reminders
  // skip firing. Read/write/event triple. Legacy — still used by
  // existing callsites; mirrors appMode under the hood.
  getPaused: 'app:getPaused',
  setPaused: 'app:setPaused',
  pausedChanged: 'app:pausedChanged',

  // Tri-state operating mode (paused / running / autopilot). Canonical
  // source of truth. Setting the mode also fires the legacy
  // pausedChanged event for back-compat.
  getAppMode: 'app:getAppMode',
  setAppMode: 'app:setAppMode',
  appModeChanged: 'app:appModeChanged',

  // Conversation surface — renderer pushes the reduced-chip count
  // so the tray tooltip + (later) macOS dock badge can surface it.
  conversationsSetReducedCount: 'convo:setReducedCount',
  // Pinned conversations → menu bar. Renderer pushes the current
  // pinned list whenever the user pins / unpins. Tray rebuilds its
  // menu with a "Pinned" section; clicking an item broadcasts
  // `conversationFocus` so the renderer brings that tab forward.
  conversationsSetPinned: 'convo:setPinned',
  conversationFocus: 'convo:focus',

  // Autopilot approval flow (prompt-output workflow node). The main
  // process opens the approval HUD with a payload; the renderer
  // settles it via approve/reject. Batch flow (batch-prompt-output)
  // reuses the same `approvalRequested` event — payload carries
  // either { body } (single) or { items } (batch); the renderer
  // routes by sniffing the payload shape.
  autopilotApprovalRequested: 'autopilot:approvalRequested',
  autopilotApprove: 'autopilot:approve',
  autopilotReject: 'autopilot:reject',
  autopilotApproveBatch: 'autopilot:approveBatch',
  autopilotFeedback: 'autopilot:feedback',

  // Telegram module bot-token management (Keychain-backed; the renderer
  // sends a token in to be persisted, but never reads it back).
  setTelegramBotToken: 'app:setTelegramBotToken',
  clearTelegramBotToken: 'app:clearTelegramBotToken',
  hasTelegramBotToken: 'app:hasTelegramBotToken',
  openObservatory: 'app:openObservatory',
  observatoryFocusTask: 'observatory:focusTask',
  shellNavigate: 'shell:navigate',
  openPalette: 'app:openPalette',
  resizePalette: 'app:resizePalette',
  openExternal: 'app:openExternal',

  showAnswerHud: 'hud:show',
  hideAnswerHud: 'hud:hide',
  resizeAnswerHud: 'hud:resize',
  setAnswerHudInteractive: 'hud:setInteractive',
  answerHudTrack: 'hud:track',

  listSkills: 'skills:list',
  refreshSkills: 'skills:refresh',
  writeSkillBody: 'skills:writeBody',
  createSkill: 'skills:create',
  deleteSkill: 'skills:delete',
  revealSkill: 'skills:reveal',

  listMcpServers: 'mcp:list',
  listClaudeMcps: 'mcp:listClaude',
  addMcpServer: 'mcp:add',
  removeMcpServer: 'mcp:remove',
  setMcpDisabled: 'mcp:setDisabled',
  readMcpFile: 'mcp:readFile',
  writeMcpFile: 'mcp:writeFile',
  revealMcpFile: 'mcp:revealFile',
  probeMcpTools: 'mcp:probeTools',
  invokeMcpTool: 'mcp:invokeTool',

  listModules: 'modules:list',
  dispatchIntent: 'modules:dispatchIntent',
  setModuleEnabled: 'modules:setEnabled',
  writeModuleSettings: 'modules:writeSettings',
  modulesChanged: 'modules:changed',

  listJarvisDir: 'fs:listJarvisDir',
  readJarvisFile: 'fs:readJarvisFile',
  writeJarvisFile: 'fs:writeJarvisFile',

  listProjects: 'projects:list',
  createProject: 'projects:create',
  updateProject: 'projects:update',
  deleteProject: 'projects:delete',
  setActiveProject: 'projects:setActive',
  setProjectInboxScan: 'projects:setInboxScan',
  projectsChanged: 'projects:changed',
  listProjectTemplates: 'projects:listTemplates',
  listProjectMemory: 'projects:listMemory',
  readProjectMemory: 'projects:readMemory',
  writeProjectMemory: 'projects:writeMemory',
  deleteProjectMemory: 'projects:deleteMemory',
  deleteNoteEntry: 'notes:deleteEntry',
  setNoteEntryArchived: 'notes:setEntryArchived',

  readPreferences: 'preferences:read',
  writePreferences: 'preferences:write',
  revealPreferences: 'preferences:reveal',
  preferencesChanged: 'preferences:changed',

  readNotificationPrefs: 'notif:read',
  writeNotificationPrefs: 'notif:write',
  notificationPrefsChanged: 'notif:changed',

  readInboxPrefs: 'inboxPrefs:read',
  writeInboxPrefs: 'inboxPrefs:write',
  inboxPrefsChanged: 'inboxPrefs:changed',

  openInClaudeDesktop: 'tasks:openInClaudeDesktop',
  costSummary: 'tasks:costSummary',
  costBreakdown: 'tasks:costBreakdown',
  costPrefsRead: 'cost:prefsRead',
  costPrefsWrite: 'cost:prefsWrite',
  workingHoursRead: 'workingHours:read',
  workingHoursWrite: 'workingHours:write',
  pickDirectory: 'fs:pickDirectory',

  httpApiStatus: 'http:status',
  rotateHttpApiToken: 'http:rotateToken',

  listInbox: 'inbox:list',
  listInboxDismissed: 'inbox:listDismissed',
  listInboxSources: 'inbox:listSources',
  revealInboxFile: 'inbox:revealFile',
  refreshInbox: 'inbox:refresh',
  /** Manual "real" refresh: re-fires every `*-inbox` routine, waits for
   *  its task to land, then re-reads disk. Distinct from refreshInbox
   *  which just re-reads (used by the 5-min auto-refresh). */
  hardRefreshInbox: 'inbox:hardRefresh',
  inboxChanged: 'inbox:changed',
  inboxRefreshing: 'inbox:refreshing',
  dismissInboxItem: 'inbox:dismiss',
  restoreInboxItem: 'inbox:restore',
  countInboxSource: 'inbox:countSource',
  clearInboxSource: 'inbox:clearSource',
  meetingImminent: 'inbox:meetingImminent',
  suppressMeetingPrompt: 'inbox:suppressMeetingPrompt',
  snoozeMeetingHeadsUp: 'inbox:snoozeMeetingHeadsUp',
  meetingRecorderState: 'meeting:recorder-state',
  meetingControlRemote: 'meeting:control-remote',
  meetingFinishFromText: 'meeting:finish-from-text',
  meetingDetectionStatus: 'meeting:detection-status',
  meetingDetectionChanged: 'meeting:detection-changed',

  readDashboard: 'dashboard:read',
  writeDashboard: 'dashboard:write',
  dashboardChanged: 'dashboard:changed',

  listBriefingKinds: 'briefings:listKinds',
  listBriefingFiles: 'briefings:listFiles',
  readBriefingFile: 'briefings:readFile',
  writeBriefingFile: 'briefings:writeFile',
  generateBriefing: 'briefings:generate',
  briefingsChanged: 'briefings:changed',
  readSkillBody: 'skills:readBody',

  requestMicAccess: 'media:requestMic',
  micStatus: 'media:micStatus',

  transcribeAudio: 'audio:transcribe',
  transcribeProgress: 'audio:progress',

  /** Text-to-speech via macOS `say`. */
  speak: 'audio:speak',
  stopSpeaking: 'audio:stopSpeak',
  /** Suppress the meeting-recorder auto-prompt while a Jarvis-
   *  owned mic capture is active (palette voice / composer mic).
   *  Reference-counted on the main side so overlapping captures
   *  don't drop the suppression prematurely. */
  noteSelfMicStart: 'audio:selfMicStart',
  noteSelfMicStop: 'audio:selfMicStop',

  /** Custom tray menu IPC. Read the current state once on open
   *  (mode, counts, pinned list) + subscribe to live updates so
   *  the menu reflects e.g. a fresh task starting while open.
   *  Other handlers are action shims (hide, resize). */
  trayMenuRead: 'tray:read',
  trayMenuStateChanged: 'tray:stateChanged',
  trayMenuHide: 'tray:hide',
  trayMenuResize: 'tray:resize',
  trayMenuQuit: 'tray:quit',

  /** Toggle voice capture inside the palette. Fired by a global
   *  shortcut so the user can start speaking without first
   *  reaching for the mic button. */
  paletteToggleVoice: 'palette:toggleVoice',

  /** Voice-orb interaction events. The orb is a separate window
   *  that handles mic + transcribe + dispatch. The global ⌘⇧Space
   *  shortcut sends a single "toggle" event — the orb decides
   *  whether to start or stop based on its own state. */
  voiceOrbToggle: 'voiceOrb:toggle',
  voiceOrbHide: 'voiceOrb:hide',

  /** Bring the main window forward and switch to a specific tab.
   *  Used by the tray menu so its nav rows actually land on the
   *  named tab (Observatory / Inbox / Routines / …) instead of
   *  the hardcoded ai-agent override that openObservatory uses. */
  openTab: 'shell:openTab',

  meetingStart: 'meeting:start',
  meetingStopRequest: 'meeting:stop-request',
  meetingFinish: 'meeting:finish',

  listRoutines: 'routines:list',
  saveRoutine: 'routines:save',
  deleteRoutine: 'routines:delete',
  runRoutineNow: 'routines:runNow',
  routinesChanged: 'routines:changed',

  routePrompt: 'palette:routePrompt',
  previewIntent: 'palette:previewIntent',

  listSkillSuggestions: 'skill-suggestions:list',
  acceptSkillSuggestion: 'skill-suggestions:accept',
  dismissSkillSuggestion: 'skill-suggestions:dismiss',
  removeSkillSuggestion: 'skill-suggestions:remove',
  skillSuggestionsChanged: 'skill-suggestions:changed',

  listReminders: 'reminders:list',
  cancelReminder: 'reminders:cancel',
  removeReminder: 'reminders:remove',
  fireReminderNow: 'reminders:fireNow',
  markReminderDone: 'reminders:markDone',
  remindersChanged: 'reminders:changed',

  launchTask: 'task:launch',
  launchShell: 'task:launchShell',
  abortTask: 'task:abort',
  sendTaskMessage: 'task:sendMessage',
  listTasks: 'task:list',
  getTaskHistory: 'task:getHistory',

  taskEvent: 'task:event',
  taskStatus: 'task:status',
  taskRemoved: 'task:removed',

  listActivity: 'activity:list',
  activityChanged: 'activity:changed',

  /** Live notifier broadcast — fires every time notifier.post() runs.
   *  Used by the FlowStream page to render terminal-stage orbs for
   *  notifications. Payload is a serializable subset of the notifier
   *  event (no onClick callback). */
  notifierEmitted: 'notifier:emitted',

  // ─── OAuth Integrations ──────────────────────────────────────────
  listIntegrations: 'integrations:list',
  connectIntegration: 'integrations:connect',
  awaitIntegrationCallback: 'integrations:awaitCallback',
  disconnectIntegration: 'integrations:disconnect',
  setIntegrationAccountMeta: 'integrations:setAccountMeta',
  setIntegrationDefault: 'integrations:setDefault',
  setIntegrationCredentials: 'integrations:setCredentials',
  clearIntegrationCredentials: 'integrations:clearCredentials',
  cancelIntegrationFlow: 'integrations:cancelFlow',
  connectIntegrationByApiKey: 'integrations:connectByApiKey',
  testIntegrationAccount: 'integrations:testAccount',
  integrationsChanged: 'integrations:changed',

  // ─── AI Drafts ───────────────────────────────────────────────────
  listDrafts: 'drafts:list',
  getDraft: 'drafts:get',
  updateDraftBody: 'drafts:updateBody',
  refineDraft: 'drafts:refine',
  sendDraft: 'drafts:send',
  discardDraft: 'drafts:discard',
  revertDraft: 'drafts:revert',
  draftsChanged: 'drafts:changed',

  // ─── Workflows ───────────────────────────────────────────────────
  listWorkflows: 'workflows:list',
  saveWorkflow: 'workflows:save',
  deleteWorkflow: 'workflows:delete',
  runWorkflow: 'workflows:run',
  stopWorkflowRun: 'workflows:stop-run',
  readWorkflowRun: 'workflows:read-run',
  listWorkflowRuns: 'workflows:list-runs',
  workflowsChanged: 'workflows:changed',
  workflowRunChanged: 'workflows:run-changed',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
