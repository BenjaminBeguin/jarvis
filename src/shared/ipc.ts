export const IpcChannels = {
  appStatus: 'app:status',
  setApiKey: 'app:setApiKey',
  clearApiKey: 'app:clearApiKey',
  setSubscriptionToken: 'app:setSubscriptionToken',
  clearSubscriptionToken: 'app:clearSubscriptionToken',
  setAuthMode: 'app:setAuthMode',
  openObservatory: 'app:openObservatory',
  openPalette: 'app:openPalette',

  listSkills: 'skills:list',
  refreshSkills: 'skills:refresh',

  listMcpServers: 'mcp:list',

  listModules: 'modules:list',
  dispatchIntent: 'modules:dispatchIntent',
  setModuleEnabled: 'modules:setEnabled',
  modulesChanged: 'modules:changed',

  listJarvisDir: 'fs:listJarvisDir',
  readJarvisFile: 'fs:readJarvisFile',

  requestMicAccess: 'media:requestMic',
  micStatus: 'media:micStatus',

  transcribeAudio: 'audio:transcribe',
  transcribeProgress: 'audio:progress',

  listRoutines: 'routines:list',
  saveRoutine: 'routines:save',
  deleteRoutine: 'routines:delete',
  runRoutineNow: 'routines:runNow',
  routinesChanged: 'routines:changed',

  launchTask: 'task:launch',
  abortTask: 'task:abort',
  sendTaskMessage: 'task:sendMessage',
  listTasks: 'task:list',
  getTaskHistory: 'task:getHistory',

  taskEvent: 'task:event',
  taskStatus: 'task:status',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
