import { ipcMain } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { IpcChannels } from '@shared/ipc';

import type { IpcDeps } from './types.js';

export function registerSkillsIpc({ skills }: IpcDeps): void {
  ipcMain.handle(IpcChannels.listSkills, () => skills.list());
  ipcMain.handle(IpcChannels.refreshSkills, () => {
    skills.reloadAll();
    return skills.list();
  });

  // Read a SKILL.md body for in-app inspection. The renderer uses this
  // when the user clicks the skill name on a briefing's schedule strip
  // (or anywhere else that surfaces a skill id). Path traversal blocked
  // by validating the skill id against the loaded skill list.
  ipcMain.handle(IpcChannels.readSkillBody, (_e, skillId: string) => {
    if (typeof skillId !== 'string' || !skillId) return '';
    const found = skills.list().find((s) => s.id === skillId);
    if (!found) return '';
    const path = join(homedir(), '.jarvis', 'skills', skillId, 'SKILL.md');
    if (!existsSync(path)) return '';
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return '';
    }
  });
}
