export const IpcChannels = {
  appStatus: 'app:status',
  setApiKey: 'app:setApiKey',
  clearApiKey: 'app:clearApiKey',
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

  listRoutines: 'routines:list',
  saveRoutine: 'routines:save',
  deleteRoutine: 'routines:delete',
  runRoutineNow: 'routines:runNow',
  routinesChanged: 'routines:changed',

  launchTask: 'task:launch',
  abortTask: 'task:abort',
  listTasks: 'task:list',
  getTaskHistory: 'task:getHistory',

  taskEvent: 'task:event',
  taskStatus: 'task:status',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
