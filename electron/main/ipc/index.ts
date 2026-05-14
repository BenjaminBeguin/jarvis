import { registerAuthIpc } from './auth.js';
import { registerIntentIpc } from './intent.js';
import { registerMcpIpc } from './mcp.js';
import { registerMediaIpc } from './media.js';
import { registerModulesIpc } from './modules.js';
import { registerPreferencesIpc } from './preferences.js';
import { registerProjectsIpc } from './projects.js';
import { registerRemindersIpc } from './reminders.js';
import { registerRoutinesIpc } from './routines.js';
import { registerSkillsIpc } from './skills.js';
import { registerSuggestionsIpc } from './suggestions.js';
import { registerTasksIpc } from './tasks.js';
import type { IpcDeps } from './types.js';
import { registerWindowIpc } from './windows.js';

export type { IpcDeps } from './types.js';

/**
 * Wire every domain's IPC handlers in one call. Order doesn't matter — each
 * registrar attaches its own channels independently — but keep this list
 * alphabetised so it's obvious which domains exist.
 */
export function registerAllIpc(deps: IpcDeps): void {
  registerAuthIpc(deps);
  registerIntentIpc(deps);
  registerMcpIpc(deps);
  registerMediaIpc(deps);
  registerModulesIpc(deps);
  registerPreferencesIpc(deps);
  registerProjectsIpc(deps);
  registerRemindersIpc(deps);
  registerRoutinesIpc(deps);
  registerSkillsIpc(deps);
  registerSuggestionsIpc(deps);
  registerTasksIpc(deps);
  registerWindowIpc(deps);
}
