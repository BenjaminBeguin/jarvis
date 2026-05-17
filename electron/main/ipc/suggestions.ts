import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';

import type { IpcDeps } from './types.js';

export function registerSuggestionsIpc({
  skillSuggestions,
  activity,
}: IpcDeps): void {
  ipcMain.handle(IpcChannels.listSkillSuggestions, () =>
    skillSuggestions.list(),
  );
  ipcMain.handle(IpcChannels.acceptSkillSuggestion, (_e, id: string) => {
    const before = skillSuggestions.list().find((s) => s.id === id);
    const result = skillSuggestions.accept(id);
    if (before) {
      activity.record({
        kind: 'skill-suggestion.accepted',
        label: `Skill suggestion accepted · ${before.name}`,
        detail: { id, name: before.name },
      });
    }
    return result;
  });
  ipcMain.handle(IpcChannels.dismissSkillSuggestion, (_e, id: string) => {
    const before = skillSuggestions.list().find((s) => s.id === id);
    const result = skillSuggestions.dismiss(id);
    if (before) {
      activity.record({
        kind: 'skill-suggestion.dismissed',
        label: `Skill suggestion dismissed · ${before.name}`,
        detail: { id, name: before.name },
      });
    }
    return result;
  });
  ipcMain.handle(IpcChannels.removeSkillSuggestion, (_e, id: string) =>
    skillSuggestions.remove(id),
  );
}
