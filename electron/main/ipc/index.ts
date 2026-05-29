import { registerActivityIpc } from './activity.js';
import { registerArtifactsIpc } from './artifacts.js';
import { registerAuthIpc } from './auth.js';
import { registerAutopilotIpc } from './autopilot.js';
import { registerConversationIpc } from './conversation.js';
import { registerBriefingsIpc } from './briefings.js';
import { registerDashboardIpc } from './dashboard.js';
import { registerDraftsIpc } from './drafts.js';
import { registerGoalsIpc } from './goals.js';
import { registerInboxIpc } from './inbox.js';
import { registerIntegrationsIpc } from './integrations.js';
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
import { registerWorkflowsIpc } from './workflows.js';

export type { IpcDeps } from './types.js';

/**
 * Wire every domain's IPC handlers in one call. Order doesn't matter — each
 * registrar attaches its own channels independently — but keep this list
 * alphabetised so it's obvious which domains exist.
 */
export function registerAllIpc(deps: IpcDeps): void {
  registerActivityIpc(deps);
  registerArtifactsIpc();
  registerAuthIpc(deps);
  registerAutopilotIpc({ activity: deps.activity });
  registerConversationIpc();
  registerBriefingsIpc(deps);
  registerDashboardIpc(deps);
  registerDraftsIpc(deps);
  registerGoalsIpc(deps);
  registerInboxIpc(deps);
  registerIntegrationsIpc({
    integrations: deps.integrations,
    registry: deps.connectorRegistry,
    orchestrator: deps.oauth,
    activity: deps.activity,
  });
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
  registerWorkflowsIpc(deps);
}
