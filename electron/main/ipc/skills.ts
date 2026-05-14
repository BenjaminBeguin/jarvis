import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';

import type { IpcDeps } from './types.js';

export function registerSkillsIpc({ skills }: IpcDeps): void {
  ipcMain.handle(IpcChannels.listSkills, () => skills.list());
  ipcMain.handle(IpcChannels.refreshSkills, () => {
    skills.reloadAll();
    return skills.list();
  });
}
