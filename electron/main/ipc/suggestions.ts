import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';

import type { IpcDeps } from './types.js';

export function registerSuggestionsIpc({ skillSuggestions }: IpcDeps): void {
  ipcMain.handle(IpcChannels.listSkillSuggestions, () =>
    skillSuggestions.list(),
  );
  ipcMain.handle(IpcChannels.acceptSkillSuggestion, (_e, id: string) =>
    skillSuggestions.accept(id),
  );
  ipcMain.handle(IpcChannels.dismissSkillSuggestion, (_e, id: string) =>
    skillSuggestions.dismiss(id),
  );
  ipcMain.handle(IpcChannels.removeSkillSuggestion, (_e, id: string) =>
    skillSuggestions.remove(id),
  );
}
