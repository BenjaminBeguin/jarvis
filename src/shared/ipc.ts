export const IpcChannels = {
  appStatus: 'app:status',
  setApiKey: 'app:setApiKey',
  clearApiKey: 'app:clearApiKey',
  openObservatory: 'app:openObservatory',
  openPalette: 'app:openPalette',

  listSkills: 'skills:list',
  refreshSkills: 'skills:refresh',

  launchTask: 'task:launch',
  abortTask: 'task:abort',
  listTasks: 'task:list',
  getTaskHistory: 'task:getHistory',

  taskEvent: 'task:event',
  taskStatus: 'task:status',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
