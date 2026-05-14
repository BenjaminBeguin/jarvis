export const IpcChannels = {
  appStatus: 'app:status',
  setApiKey: 'app:setApiKey',
  clearApiKey: 'app:clearApiKey',
  setSubscriptionToken: 'app:setSubscriptionToken',
  clearSubscriptionToken: 'app:clearSubscriptionToken',
  setAuthMode: 'app:setAuthMode',
  openObservatory: 'app:openObservatory',
  observatoryFocusTask: 'observatory:focusTask',
  shellNavigate: 'shell:navigate',
  openPalette: 'app:openPalette',
  resizePalette: 'app:resizePalette',
  openExternal: 'app:openExternal',

  showAnswerHud: 'hud:show',
  hideAnswerHud: 'hud:hide',
  resizeAnswerHud: 'hud:resize',
  answerHudTrack: 'hud:track',

  listSkills: 'skills:list',
  refreshSkills: 'skills:refresh',

  listMcpServers: 'mcp:list',
  listClaudeMcps: 'mcp:listClaude',
  addMcpServer: 'mcp:add',
  removeMcpServer: 'mcp:remove',
  readMcpFile: 'mcp:readFile',
  revealMcpFile: 'mcp:revealFile',
  probeMcpTools: 'mcp:probeTools',
  invokeMcpTool: 'mcp:invokeTool',

  listModules: 'modules:list',
  dispatchIntent: 'modules:dispatchIntent',
  setModuleEnabled: 'modules:setEnabled',
  modulesChanged: 'modules:changed',

  listJarvisDir: 'fs:listJarvisDir',
  readJarvisFile: 'fs:readJarvisFile',

  listProjects: 'projects:list',
  createProject: 'projects:create',
  setActiveProject: 'projects:setActive',
  projectsChanged: 'projects:changed',
  listProjectTemplates: 'projects:listTemplates',
  listProjectMemory: 'projects:listMemory',
  readProjectMemory: 'projects:readMemory',
  writeProjectMemory: 'projects:writeMemory',
  deleteProjectMemory: 'projects:deleteMemory',
  deleteNoteEntry: 'notes:deleteEntry',

  readPreferences: 'preferences:read',
  writePreferences: 'preferences:write',
  revealPreferences: 'preferences:reveal',
  preferencesChanged: 'preferences:changed',

  openInClaudeDesktop: 'tasks:openInClaudeDesktop',
  costSummary: 'tasks:costSummary',

  listInbox: 'inbox:list',
  refreshInbox: 'inbox:refresh',
  inboxChanged: 'inbox:changed',
  inboxRefreshing: 'inbox:refreshing',

  requestMicAccess: 'media:requestMic',
  micStatus: 'media:micStatus',

  transcribeAudio: 'audio:transcribe',
  transcribeProgress: 'audio:progress',

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
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
